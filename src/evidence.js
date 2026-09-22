const DEFAULT_MAX_CANDIDATES = 120;
const DEFAULT_MAX_CANDIDATE_CHARS = 600;
const DEFAULT_SHARED_PACKAGE_CANDIDATES = 12;
const DEFAULT_SHARED_CONTEXT_CHARS = 900;
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
    const matchedStart = Number.isInteger(reference.offsetStart)
      ? reference.offsetStart
      : source.toLowerCase().indexOf(String(reference.text || "").toLowerCase());
    if (matchedStart < 0) return clean(reference.text);
    const matchedEnd = Number.isInteger(reference.offsetEnd)
      ? Math.max(matchedStart, reference.offsetEnd)
      : matchedStart + String(reference.text || "").length;
    // The selected evidence is the non-negotiable part of the window. The old
    // fixed-length slice could drop the end of a long selection (including the
    // actual stock statement) after adding leading context.
    const contextBudget = Math.max(0, maxLength - (matchedEnd - matchedStart));
    let start = Math.max(0, matchedStart - Math.floor(contextBudget / 3));
    let end = Math.min(source.length, matchedEnd + (contextBudget - (matchedStart - start)));
    if (end - start < maxLength && start > 0) start = Math.max(0, end - maxLength);
    if (end < matchedEnd) end = matchedEnd;
    return clean(source.slice(start, end));
  }
  // Structured fields are already bounded during candidate preparation. Never
  // crop a selected value merely to satisfy a smaller context preference.
  return clean(reference.text);
}

function expectedProduct(source) {
  return {
    merchantSku: clean(source?.sku) || null,
    title: clean(source?.productTitle) || null,
    shopifyProductId: clean(source?.shopifyProductId) || null,
    shopifyVariantId: clean(source?.shopifyVariantId) || null,
    supplierSku: clean(source?.supplierSku) || null,
    supplierProductId: clean(source?.supplierProductId) || null,
    supplierVariantId: clean(source?.supplierVariantId) || null,
    matchTerms: [...new Set((source?.matchTerms || []).map(clean).filter(Boolean))].slice(0, 20),
  };
}

function expectedIdentityTerms(source) {
  const product = expectedProduct(source);
  return [
    product.supplierSku,
    product.supplierProductId,
    product.supplierVariantId,
    product.merchantSku,
    product.title,
    ...product.matchTerms,
  ].filter(Boolean);
}

function availabilitySignals(text) {
  const value = String(text || "");
  const signals = [];
  if (/\b(?:in\s*stock|available\s+now|ready\s*to\s*ship)\b/iu.test(value)) signals.push("IN_STOCK");
  if (/\b(?:pre[ -]?order(?:ed)?)\b/iu.test(value)) signals.push("PREORDER");
  if (/\b(?:back[ -]?order(?:ed)?)\b/iu.test(value)) signals.push("BACKORDERED");
  if (/\b(?:out\s*of\s*stock|sold\s*out|unavailable)\b/iu.test(value)) signals.push("OUT_OF_STOCK");
  if (/\b(?:discontinued|end\s+of\s+life|no\s+longer\s+available)\b/iu.test(value)) signals.push("DISCONTINUED");
  if (/\b(?:ships?|dispatches?)\s+(?:in|within|by)|\blead\s+time\b/iu.test(value)) signals.push("LEAD_TIME");
  return [...new Set(signals)];
}

function sameReference(left, right) {
  if (!left || !right || left.origin !== right.origin) return false;
  if (left.origin === "STRUCTURED_FIELD") return left.path && left.path === right.path;
  return (!left.snapshotId || !right.snapshotId || left.snapshotId === right.snapshotId) &&
    Number.isInteger(left.offsetStart) && Number.isInteger(right.offsetStart) &&
    left.offsetStart === right.offsetStart && left.offsetEnd === right.offsetEnd;
}

// One provider-independent representation is used by fallback readers and the
// evaluation harness. Expected identity stays separate from observed source
// material, and no upstream model decision or confidence enters this package.
export function buildSharedEvidencePackage(source, providerResult, {
  maxCandidates = DEFAULT_SHARED_PACKAGE_CANDIDATES,
  maxCandidateChars = DEFAULT_MAX_CANDIDATE_CHARS,
  maxContextChars = DEFAULT_SHARED_CONTEXT_CHARS,
  preferredReferences = providerResult?.preferredEvidenceReferences || [],
} = {}) {
  const identityTerms = expectedIdentityTerms(source);
  const bundle = prepareEvidenceBundle(providerResult, {
    maxCandidates: Math.max(maxCandidates, DEFAULT_SHARED_PACKAGE_CANDIDATES),
    maxCandidateChars,
    groupAdjacent: true,
    identityTerms,
  });
  const preferred = preferredReferences.filter(Boolean);
  const ordered = [
    ...preferred.map((reference) => bundle.candidates.find((item) => sameReference(item, reference)) || reference),
    ...bundle.candidates,
  ];
  const unique = [];
  for (const candidate of ordered) {
    if (!candidate?.text || unique.some((item) => sameReference(item, candidate) ||
      (item.origin === candidate.origin && item.path === candidate.path && item.text === candidate.text))) continue;
    unique.push(candidate);
  }
  const selected = unique.slice(0, maxCandidates);
  const evidence = selected.map((candidate, index) => {
    const context = evidenceContextForReference(providerResult, candidate, maxContextChars);
    return {
      id: candidate.id || `E${String(index + 1).padStart(3, "0")}`,
      origin: candidate.origin,
      path: candidate.path || null,
      snapshotId: candidate.snapshotId || providerResult?.pageSnapshotId || providerResult?.runId || null,
      sourceUrl: candidate.sourceUrl || providerResult?.url || null,
      offsetStart: Number.isInteger(candidate.offsetStart) ? candidate.offsetStart : null,
      offsetEnd: Number.isInteger(candidate.offsetEnd) ? candidate.offsetEnd : null,
      text: candidate.text,
      surroundingContext: clean(context) !== clean(candidate.text) ? context : null,
      availabilitySignals: availabilitySignals(`${candidate.text} ${context}`),
    };
  });
  const signalGroups = new Map();
  for (const item of evidence) {
    for (const state of item.availabilitySignals) {
      if (!signalGroups.has(state)) signalGroups.set(state, []);
      signalGroups.get(state).push(item.id);
    }
  }
  const potentialConflicts = signalGroups.size > 1
    ? [...signalGroups].map(([state, evidenceIds]) => ({ state, evidenceIds }))
    : [];
  const totalCandidates = Math.max(bundle.totalCandidates, unique.length);
  return {
    schemaVersion: "supplier-evidence-v2",
    expectedProduct: expectedProduct(source),
    observedPage: {
      title: clean(providerResult?.title) || null,
      resolvedUrl: providerResult?.url || null,
      snapshotId: providerResult?.pageSnapshotId || providerResult?.runId ||
        evidence.find((item) => item.snapshotId)?.snapshotId || null,
    },
    evidence,
    potentialConflicts,
    extraction: {
      truncated: bundle.truncated || unique.length > selected.length,
      totalCandidateCount: totalCandidates,
      includedCandidateCount: selected.length,
      omittedCandidateCount: Math.max(0, totalCandidates - selected.length),
    },
  };
}

export function evaluateLabelEvidenceBinding(testCase, providerResult, { maxContextChars = 900 } = {}) {
  const label = clean(testCase?.labelEvidence);
  if (!label) return { present: null, bound: null, evidenceId: null };
  const raw = String(providerResult?.rawPageText || providerResult?.text || "");
  const present = raw.toLowerCase().includes(label.toLowerCase());
  if (!present) return { present: false, bound: false, evidenceId: null };
  const terms = expectedIdentityTerms(testCase?.source).map(searchable).filter((term) => term.length >= 3);
  const evidencePackage = buildSharedEvidencePackage(testCase?.source, providerResult, { maxContextChars });
  const boundEvidence = evidencePackage.evidence.find((item) => {
    // Binding is intentionally paragraph/window-local. Surrounding context can
    // cross product-card boundaries and must not turn a generic label into a
    // monitored-variant label.
    const normalized = searchable(item.text);
    return item.text.toLowerCase().includes(label.toLowerCase()) && terms.some((term) => normalized.includes(term));
  });
  return {
    present: true,
    bound: Boolean(boundEvidence),
    evidenceId: boundEvidence?.id || null,
  };
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
