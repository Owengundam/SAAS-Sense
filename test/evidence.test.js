import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareEvidenceCandidates,
  verifyEvidenceReference,
} from "../src/evidence.js";

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
