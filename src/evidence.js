const DEFAULT_MAX_CANDIDATES = 120;
const DEFAULT_MAX_CANDIDATE_CHARS = 600;
const AVAILABILITY_PATTERN = /\b(?:in\s*stock|out\s*of\s*stock|sold\s*out|unavailable|available\s+now|ready\s*to\s*ship|pre[ -]?order(?:ed)?|back[ -]?order(?:ed)?|discontinued|end\s+of\s+life|ships?\s+(?:in|within|by)|dispatches?\s+(?:in|within|by)|lead\s+time|within\s+\d+\s+(?:business\s+)?(?:day|week|month)s?)\b/iu;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function searchable(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function prioritizeForIdentity(candidates, identityTerms) {
  const terms = [...new Set((identityTerms || []).map(searchable).filter((term) => term.length >= 2))];
  if (!terms.length) return candidates;
  return candidates
    .map((candidate, index) => {
      const text = searchable(candidate.text);
      const identityHits = terms.filter((term) => text.includes(term)).length;
      const availability = AVAILABILITY_PATTERN.test(candidate.text) ||
        /availability|inventory|stock/i.test(candidate.path || "");
      return {
        candidate,
        index,
        score: identityHits * 100 + (availability ? 10 : 0),
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function exactTrimmedRange(text, start, end) {
  let first = start;
  let last = end;
  while (first < last && /\s/.test(text[first])) first += 1;
  while (last > first && /\s/.test(text[last - 1])) last -= 1;
  return { start: first, end: last, text: text.slice(first, last) };
}

export function segmentCapturedText(text, {
  snapshotId = null,
  sourceUrl = null,
  maxCandidateChars = DEFAULT_MAX_CANDIDATE_CHARS,
} = {}) {
  const input = String(text ?? "");
  if (!input.trim()) return [];
  const segments = [];
  const pattern = /[^.!?\n]+(?:[.!?]+|(?=\n|$))/g;
  for (const match of input.matchAll(pattern)) {
    const range = exactTrimmedRange(input, match.index, match.index + match[0].length);
    if (range.text.length < 3) continue;
    if (range.text.length <= maxCandidateChars) {
      segments.push({
        origin: "PAGE_TEXT",
        path: null,
        snapshotId,
        sourceUrl,
        offsetStart: range.start,
        offsetEnd: range.end,
        text: range.text,
      });
      continue;
    }
    for (let start = range.start; start < range.end; start += maxCandidateChars) {
      const part = exactTrimmedRange(input, start, Math.min(range.end, start + maxCandidateChars));
      if (part.text.length >= 3) {
        segments.push({
          origin: "PAGE_TEXT",
          path: null,
          snapshotId,
          sourceUrl,
          offsetStart: part.start,
          offsetEnd: part.end,
          text: part.text,
        });
      }
    }
  }
  return segments;
}

function normalizeRecord(record, providerResult) {
  const text = clean(record?.text ?? record?.value);
  if (!text) return null;
  return {
    origin: record.origin === "PAGE_TEXT" ? "PAGE_TEXT" : "STRUCTURED_FIELD",
    path: record.path || null,
    snapshotId: record.snapshotId || providerResult?.runId || null,
    sourceUrl: record.sourceUrl || providerResult?.url || null,
    offsetStart: Number.isInteger(record.offsetStart) ? record.offsetStart : null,
    offsetEnd: Number.isInteger(record.offsetEnd) ? record.offsetEnd : null,
    text,
  };
}

// Non-overlapping, verbatim windows keep adjacent identity and stock text together.
// Paragraph boundaries remain separate: adjacency alone never establishes identity.
export function windowCapturedText(text, options = {}) {
  const input = String(text ?? "");
  const limit = options.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS;
  const spans = segmentCapturedText(input, options);
  const windows = [];
  for (const span of spans) {
    const previous = windows.at(-1);
    const gap = previous ? input.slice(previous.offsetEnd, span.offsetStart) : "";
    if (previous && span.offsetEnd - previous.offsetStart <= limit && !/\n\s*\n/.test(gap)) {
      previous.offsetEnd = span.offsetEnd;
      previous.text = input.slice(previous.offsetStart, previous.offsetEnd);
    } else windows.push({ ...span });
  }
  return windows;
}

export function prepareEvidenceBundle(providerResult, {
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  maxCandidateChars = DEFAULT_MAX_CANDIDATE_CHARS,
  groupAdjacent = false,
  identityTerms = [],
} = {}) {
  const records = Array.isArray(providerResult?.evidenceRecords)
    ? providerResult.evidenceRecords
    : [];
  const candidates = [];
  const pageRecords = records.filter((record) => record?.origin === "PAGE_TEXT");
  const structuredRecords = records.filter((record) => record?.origin !== "PAGE_TEXT");
  const segment = groupAdjacent ? windowCapturedText : segmentCapturedText;

  for (const record of pageRecords) {
    const raw = String(record.text ?? record.value ?? "");
    candidates.push(...segment(raw, {
      snapshotId: record.snapshotId || providerResult?.runId || null,
      sourceUrl: record.sourceUrl || providerResult?.url || null,
      maxCandidateChars,
    }));
  }

  if (!pageRecords.length) {
    const raw = providerResult?.rawPageText ?? (!records.length ? providerResult?.text : "");
    candidates.push(...segment(raw, {
      snapshotId: providerResult?.pageSnapshotId || providerResult?.runId || null,
      sourceUrl: providerResult?.url || null,
      maxCandidateChars,
    }));
  }

  for (const record of structuredRecords) {
    const normalized = normalizeRecord(record, providerResult);
    if (!normalized) continue;
    normalized.text = normalized.text.slice(0, maxCandidateChars);
    candidates.push(normalized);
  }

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = [candidate.origin, candidate.path || "", candidate.text.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...candidate });
  }
  const prioritized = prioritizeForIdentity(unique, identityTerms);
  const truncated = prioritized.length > maxCandidates;
  const selected = prioritized.slice(0, maxCandidates).map((candidate, index) => ({
    ...candidate,
    id: `${candidate.origin === "PAGE_TEXT" ? "P" : "S"}${String(index + 1).padStart(3, "0")}`,
  }));
  return { candidates: selected, truncated, totalCandidates: unique.length };
}

export function prepareEvidenceCandidates(providerResult, options = {}) {
  return prepareEvidenceBundle(providerResult, options).candidates;
}

export function evidenceContextForReference(providerResult, reference, maxLength = 700) {
  if (!reference) return "";
  if (reference.origin === "PAGE_TEXT") {
    const record = (providerResult?.evidenceRecords || []).find((item) =>
      item.origin === "PAGE_TEXT" &&
      (!reference.snapshotId || item.snapshotId === reference.snapshotId));
    const source = String(record?.text ?? providerResult?.rawPageText ?? providerResult?.text ?? "");
    if (!source) return "";
    const start = Number.isInteger(reference.offsetStart)
      ? Math.max(0, reference.offsetStart - Math.floor(maxLength / 3))
      : Math.max(0, source.toLowerCase().indexOf(String(reference.text || "").toLowerCase()) - Math.floor(maxLength / 3));
    return clean(source.slice(start, start + maxLength));
  }
  return clean(reference.text).slice(0, maxLength);
}

export function verifyEvidenceReference(providerResult, reference, quote) {
  const expected = clean(quote);
  if (!reference || expected.length < 3 || clean(reference.text).toLowerCase() !== expected.toLowerCase()) return false;
  if (reference.origin === "PAGE_TEXT") {
    const records = providerResult?.evidenceRecords || [];
    const record = records.find((item) =>
      item.origin === "PAGE_TEXT" &&
      (!reference.snapshotId || item.snapshotId === reference.snapshotId));
    const source = String(record?.text ?? providerResult?.rawPageText ?? (!records.length ? providerResult?.text : "") ?? "");
    if (Number.isInteger(reference.offsetStart) && Number.isInteger(reference.offsetEnd)) {
      return clean(source.slice(reference.offsetStart, reference.offsetEnd)).toLowerCase() === expected.toLowerCase();
    }
    return clean(source).toLowerCase().includes(expected.toLowerCase());
  }
  if (reference.origin === "STRUCTURED_FIELD") {
    return (providerResult?.evidenceRecords || []).some((record) =>
      record.origin !== "PAGE_TEXT" &&
      (!reference.path || record.path === reference.path) &&
      clean(record.text ?? record.value).toLowerCase() === expected.toLowerCase());
  }
  return false;
}
