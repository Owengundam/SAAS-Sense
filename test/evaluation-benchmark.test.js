import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateFixtureCases } from "../src/fixture-evaluation.js";

test("labeled supplier fixture benchmark has no incorrect factual outcomes", () => {
  const cases = JSON.parse(readFileSync(resolve("fixtures/evaluation-cases.json"), "utf8"));
  const report = evaluateFixtureCases(cases);
  assert.equal(report.total, 30);
  assert.equal(Object.keys(report.domains).length, 3);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, report.total);
});
