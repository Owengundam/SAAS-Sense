import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertHoldoutDisjoint, normalizeRealSupplierFixture } from "../src/real-supplier-fixture.js";

const baseline = "88174635c49123fa2e62b24505307d8911ea5f7a";

function fixtureCase(id, url = `https://supplier.test/products/${id}`) {
  return { id, expected: "IN_STOCK", labelEvidence: "In stock", source: { url } };
}

function holdout(cases = [fixtureCase("new-case")]) {
  return {
    schemaVersion: 1,
    datasetRole: "holdout",
    frozenAt: "2026-09-22T13:00:00Z",
    frozenAgainstCommit: baseline,
    selectionProtocol: "Selected before the first model run.",
    cases,
  };
}

test("legacy arrays remain development fixtures", () => {
  const result = normalizeRealSupplierFixture([fixtureCase("development")], { requestedRole: "development" });
  assert.equal(result.datasetRole, "development");
  assert.equal(result.metadata, null);
});

test("an environment variable cannot relabel development data as holdout", () => {
  assert.throws(
    () => normalizeRealSupplierFixture([fixtureCase("development")], { requestedRole: "holdout" }),
    /REAL_SUPPLIER_DATASET_ROLE_MISMATCH/,
  );
});

test("holdout fixtures pin their policy baseline and exact file digest", () => {
  const result = normalizeRealSupplierFixture(holdout(), {
    requestedRole: "holdout",
    expectedBaselineSha: baseline,
    expectedFixtureSha256: "abc123",
    actualFixtureSha256: "abc123",
  });
  assert.equal(result.datasetRole, "holdout");
  assert.equal(result.metadata.frozenAgainstCommit, baseline);
});

test("holdout fixtures reject the wrong baseline or file digest", () => {
  assert.throws(
    () => normalizeRealSupplierFixture(holdout(), { expectedBaselineSha: "0".repeat(40) }),
    /REAL_SUPPLIER_HOLDOUT_BASELINE_MISMATCH/,
  );
  assert.throws(
    () => normalizeRealSupplierFixture(holdout(), {
      expectedFixtureSha256: "expected",
      actualFixtureSha256: "changed",
    }),
    /REAL_SUPPLIER_FIXTURE_SHA256_MISMATCH/,
  );
});

test("holdout cases must be disjoint from development IDs and normalized URLs", () => {
  const development = [fixtureCase("development", "https://supplier.test/products/shared/?tracking=1")];
  assert.throws(
    () => assertHoldoutDisjoint([fixtureCase("development")], development),
    /REAL_SUPPLIER_HOLDOUT_ID_OVERLAP/,
  );
  assert.throws(
    () => assertHoldoutDisjoint([
      fixtureCase("different-id", "https://SUPPLIER.test/products/shared#availability"),
    ], development),
    /REAL_SUPPLIER_HOLDOUT_URL_OVERLAP/,
  );
  assert.doesNotThrow(() => assertHoldoutDisjoint([fixtureCase("new-case")], development));
});

test("holdout cases cannot reuse a supplier identity at another URL", () => {
  const development = [{
    ...fixtureCase("development", "https://supplier.test/products/old"),
    source: { url: "https://supplier.test/products/old", supplierSku: "SKU-123" },
  }];
  const holdoutCases = [{
    ...fixtureCase("holdout", "https://supplier.test/products/new"),
    source: { url: "https://supplier.test/products/new", supplierSku: "sku-123" },
  }];
  assert.throws(
    () => assertHoldoutDisjoint(holdoutCases, development),
    /REAL_SUPPLIER_HOLDOUT_IDENTITY_OVERLAP/,
  );
});

test("fixtures reject duplicate IDs and URLs", () => {
  assert.throws(
    () => normalizeRealSupplierFixture([fixtureCase("same"), fixtureCase("same", "https://b.test/item")]),
    /REAL_SUPPLIER_DUPLICATE_CASE_ID/,
  );
  assert.throws(
    () => normalizeRealSupplierFixture([
      fixtureCase("one", "https://supplier.test/item?one=1"),
      fixtureCase("two", "https://supplier.test/item?two=2"),
    ]),
    /REAL_SUPPLIER_DUPLICATE_CASE_URL/,
  );
});

test("the frozen real-supplier holdout is valid and disjoint from development", () => {
  const development = JSON.parse(readFileSync(
    new URL("../fixtures/real-supplier-validation-25.json", import.meta.url),
    "utf8",
  ));
  const holdoutPayload = JSON.parse(readFileSync(
    new URL("../fixtures/real-supplier-holdout-24.json", import.meta.url),
    "utf8",
  ));
  const holdoutFixture = normalizeRealSupplierFixture(holdoutPayload, {
    requestedRole: "holdout",
    expectedBaselineSha: baseline,
  });

  assert.equal(holdoutFixture.cases.length, 24);
  assert.deepEqual(
    [...new Set(holdoutFixture.cases.map((testCase) => new URL(testCase.source.url).hostname))].sort(),
    ["lightingsupply.com", "shop.miele.hk", "www.surya.com"],
  );
  assert.doesNotThrow(() => assertHoldoutDisjoint(holdoutFixture.cases, development));
});
