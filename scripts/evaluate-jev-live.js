// Explicit opt-in: invokes paid TypeSafe calls only; never reads/writes the app DB.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { JevEvidenceReader } from "../src/providers/jev.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize paid model evaluation");
const token = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
if (!token) throw new Error("JEV_API_KEY is required");
const cases = JSON.parse(await readFile(new URL("../fixtures/jev-live-cases.json", import.meta.url), "utf8"));
const Candidate = process.env.JEV_CANDIDATE_MODULE
  ? (await import(pathToFileURL(process.env.JEV_CANDIDATE_MODULE))).JevEvidenceReader : JevEvidenceReader;
const readers = { candidate: new Candidate({ token, model: process.env.TYPESAFE_MODEL }) };
if (process.env.JEV_BASELINE_MODULE) {
  const { JevEvidenceReader: Baseline } = await import(pathToFileURL(process.env.JEV_BASELINE_MODULE));
  readers.baseline = new Baseline({ token, model: process.env.TYPESAFE_MODEL });
}
const rows = [];
for (const c of cases) {
  const source = { sku: "TEST-BOOK-001", productTitle: "A Light in the Attic", supplierSku: "TEST-BOOK-001", matchTerms: ["A Light in the Attic"], ...c.source };
  const page = { title: c.pageTitle || source.productTitle, url: "https://fixture.invalid/book", runId: `eval-${c.name}`, text: c.text, rawPageText: c.text,
    evidenceRecords: [{ origin: "PAGE_TEXT", text: c.text, snapshotId: `eval-${c.name}`, sourceUrl: "https://fixture.invalid/book" }] };
  const row = { name: c.name, split: c.split, expected: c.expected };
  for (const [name, reader] of Object.entries(readers)) {
    const started = performance.now();
    const result = await reader.analyze(source, page);
    const accepted = result.ok && result.acceptedByPolicy === true;
    row[name] = { ok: result.ok, accepted, state: result.availability || "UNKNOWN", effectiveState: accepted ? result.availability : "UNKNOWN",
      reason: result.reasonCode, ms: Math.round(performance.now() - started), usage: result.usage, signals: result.decisionSignals };
  }
  rows.push(row);
  console.log("CASE " + JSON.stringify(row));
}
const summary = {};
for (const name of Object.keys(readers)) {
  summary[name] = {};
  for (const split of ["original", "holdout", "all"]) {
    const selected = rows.filter(row => split === "all" || row.split === split);
    const factual = selected.filter(row => row.expected !== "UNKNOWN");
    summary[name][split] = { total: selected.length,
      correctEffective: selected.filter(row => row[name].ok && row[name].effectiveState === row.expected).length,
      factualCases: factual.length, acceptedCorrect: factual.filter(row => row[name].accepted && row[name].state === row.expected).length,
      falseAccepted: selected.filter(row => row[name].accepted && row[name].state !== row.expected).length,
      providerFailures: selected.filter(row => !row[name].ok).length,
      averageMs: Math.round(selected.reduce((sum,row) => sum + row[name].ms, 0) / selected.length) };
  }
}
console.log("SUMMARY " + JSON.stringify(summary));
