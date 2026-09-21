import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareEvidenceCandidates,
  verifyEvidenceReference,
  prepareEvidenceBundle,
} from "../src/evidence.js";

test("JEV windows preserve identity, contradictions and exact source offsets", () => {
  const text = "Arc Lamp\nSKU SUP-123\nIn stock. Currently unavailable.\n\nRelated shade\nSold out.";
  const page = { rawPageText: text, runId: "window-snapshot" };
  const { candidates } = prepareEvidenceBundle(page, { groupAdjacent: true });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].text, "Arc Lamp\nSKU SUP-123\nIn stock. Currently unavailable.");
  assert.equal(candidates[1].text, "Related shade\nSold out.");
  for (const candidate of candidates) {
    assert.equal(text.slice(candidate.offsetStart, candidate.offsetEnd), candidate.text);
    assert.equal(verifyEvidenceReference(page, candidate, candidate.text), true);
  }
});

test("bounded JEV windows report truncation and never merge structured fields into page text", () => {
  const page = { evidenceRecords: [
    { origin: "PAGE_TEXT", text: "Product one. In stock.\n\nProduct two. Sold out.", snapshotId: "p" },
    { origin: "STRUCTURED_FIELD", path: "offers.availability", text: "InStock" },
  ] };
  const full = prepareEvidenceBundle(page, { groupAdjacent: true, maxCandidateChars: 30 });
  assert.equal(full.candidates.length, 3);
  assert.equal(full.candidates[2].origin, "STRUCTURED_FIELD");
  assert.ok(full.candidates.every(x => x.text.length <= 30));
  const limited = prepareEvidenceBundle(page, { groupAdjacent: true, maxCandidates: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.totalCandidates, 3);
});

test("captured page spans retain exact offsets and snapshot provenance", () => {
  const text = "Lamp X5. Graphite / X5 — ready to ship. Related shade sold out.";
  const providerResult = {
    runId: "combined-run",
    url: "https://supplier.test/x5",
    rawPageText: text,
    evidenceRecords: [{
      origin: "PAGE_TEXT",
      text,
      snapshotId: "page-run-1",
      sourceUrl: "https://supplier.test/x5",
    }],
  };
  const candidate = prepareEvidenceCandidates(providerResult)
    .find((item) => item.text.includes("ready to ship"));
  assert.equal(candidate.origin, "PAGE_TEXT");
  assert.equal(candidate.snapshotId, "page-run-1");
  assert.equal(text.slice(candidate.offsetStart, candidate.offsetEnd), candidate.text);
  assert.equal(verifyEvidenceReference(providerResult, candidate, candidate.text), true);
});

test("structured evidence is verified by original field path rather than synthesized display text", () => {
  const providerResult = {
    text: "Lamp X5. In stock",
    evidenceRecords: [{
      origin: "STRUCTURED_FIELD",
      path: "offers.availability",
      text: "https://schema.org/InStock",
      snapshotId: "structured-run",
    }],
  };
  const candidate = prepareEvidenceCandidates(providerResult)[0];
  assert.equal(candidate.origin, "STRUCTURED_FIELD");
  assert.equal(candidate.path, "offers.availability");
  assert.equal(verifyEvidenceReference(providerResult, candidate, "https://schema.org/InStock"), true);
  assert.equal(verifyEvidenceReference(providerResult, { ...candidate, text: "In stock" }, "In stock"), false);
});
