import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateFixtureCases } from "../src/fixture-evaluation.js";

const fixturePath = resolve(process.cwd(), "fixtures", "evaluation-cases.json");
const cases = JSON.parse(readFileSync(fixturePath, "utf8"));
const report = evaluateFixtureCases(cases);

console.log(JSON.stringify({
  evaluatedAt: new Date().toISOString(),
  fixturePath,
  total: report.total,
  passed: report.passed,
  failed: report.failed,
  factualCorrect: report.factualCorrect,
  safeNonFactual: report.safeNonFactual,
  domains: report.domains,
  failures: report.failures,
}, null, 2));

if (report.failed) process.exitCode = 1;
