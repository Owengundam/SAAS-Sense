import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSharedEvidencePackage,
  evidenceContextForReference,
  evaluateLabelEvidenceBinding,
  prepareEvidenceCandidates,
  verifyEvidenceReference,
  prepareEvidenceBundle,
} from "../src/evidence.js";

test("evidence context always preserves the complete selected span", () => {
  const selectedText = `${"x".repeat(560)} OUT OF STOCK`;
  const text = `${"leading ".repeat(60)}${selectedText}${" trailing".repeat(60)}`;
  const offsetStart = text.indexOf(selectedText);
  const reference = {
    origin: "PAGE_TEXT",
    snapshotId: "long-selection",
    offsetStart,
    offsetEnd: offsetStart + selectedText.length,
    text: selectedText,
  };
  const context = evidenceContextForReference({
    rawPageText: text,
    evidenceRecords: [{ origin: "PAGE_TEXT", snapshotId: "long-selection", text }],
  }, reference, 700);
  assert.match(context, /OUT OF STOCK/);
  assert.ok(context.includes(selectedText));
});

test("shared evidence package separates expected identity and preserves provenance and conflicts", () => {
  const text = "SKU TARGET-7. Backordered for 2 weeks.\n\nRelated shade. In stock.";
  const source = { productTitle: "Target Lamp", supplierSku: "TARGET-7", matchTerms: ["TARGET-7"] };
  const evidencePackage = buildSharedEvidencePackage(source, {
    title: "Target Lamp - Supplier",
    url: "https://supplier.test/target-7",
    runId: "snapshot-7",
    rawPageText: text,
  });
  assert.equal(evidencePackage.expectedProduct.supplierSku, "TARGET-7");
  assert.equal(evidencePackage.observedPage.title, "Target Lamp - Supplier");
  assert.equal(evidencePackage.observedPage.snapshotId, "snapshot-7");
  assert.equal(evidencePackage.evidence[0].sourceUrl, "https://supplier.test/target-7");
  assert.match(evidencePackage.evidence[0].text, /TARGET-7/);
  assert.deepEqual(new Set(evidencePackage.potentialConflicts.map((item) => item.state)),
    new Set(["BACKORDERED", "IN_STOCK"]));
  assert.equal("confidence" in evidencePackage, false);
});

test("generic label evidence is scorable only when bound to monitored identity", () => {
  const testCase = {
    labelEvidence: "In stock",
    source: { supplierSku: "TARGET-7", matchTerms: ["TARGET-7"] },
  };
  const unrelated = evaluateLabelEvidenceBinding(testCase, {
    text: "TARGET-7 details.\n\nRelated shade. In stock.",
  });
  const bound = evaluateLabelEvidenceBinding(testCase, {
    text: "TARGET-7. In stock.",
  });
  assert.equal(unrelated.present, true);
  assert.equal(unrelated.bound, false);
  assert.equal(bound.bound, true);
});

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

test("bounded JEV retrieval keeps exact-variant availability ahead of unrelated variants", () => {
  const distractors = Array.from({ length: 140 }, (_, index) =>
    `Related finish SKU SS-OTHER-${index}. ${index % 2 ? "In stock." : "Within 4 weeks."}`);
  const target = "Siena Large Flush Mount\nSKU SS 4016AN-WG\n47 in stock, ships by 09.18.26.";
  const text = [...distractors, target].join("\n\n");
  const page = { rawPageText: text, runId: "mixed-variant-page" };
  const { candidates, truncated } = prepareEvidenceBundle(page, {
    groupAdjacent: true,
    maxCandidates: 5,
    identityTerms: ["SS 4016AN-WG", "Siena Large Flush Mount in Antique Nickel"],
  });

  assert.equal(truncated, true);
  assert.match(candidates[0].text, /SS 4016AN-WG/);
  assert.match(candidates[0].text, /47 in stock/);
  assert.equal(verifyEvidenceReference(page, candidates[0], candidates[0].text), true);
});
