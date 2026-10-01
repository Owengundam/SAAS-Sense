import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { createRequestHandler } from "react-router";

// Non-production fixture configuration only. No credentials or paid providers
// are needed to render these public documents.
process.env.SHOPIFY_API_KEY = "public-page-smoke-fixture";
process.env.SHOPIFY_API_SECRET = "public-page-smoke-fixture";
process.env.SHOPIFY_APP_URL = "https://public-page-smoke.example";
const directory = mkdtempSync(join(tmpdir(), "supplier-public-smoke-"));
const databasePath = join(directory, "sessions.sqlite");
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.PROVIDER = "mock";
process.env.SCHEDULER_ENABLED = "false";
process.env.SHOPIFY_APP_PRICING_ENABLED = "true";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Public pages must not make outbound service requests"); };
const database = new DatabaseSync(databasePath);
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const entry of readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  database.exec(readFileSync(new URL(`${entry.name}/migration.sql`, migrations), "utf8"));
}
database.close();
// The Shopify SDK checks that its session table exists during module import.
// Share this empty, disposable client so it can be disconnected cleanly.
globalThis.prismaGlobal = new PrismaClient();

try {
  const build = await import("../build/server/index.js");
  const handle = createRequestHandler(build, "production");
  for (const path of ["/privacy", "/privacy?shop=smoke-test.myshopify.com&host=fixture"]) {
    const response = await handle(new Request(`https://public-page-smoke.example${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /<title>Privacy policy \| SupplierSignal<\/title>/);
    assert.match(html, /<h1>Privacy policy<\/h1>/);
    assert.match(html, /Haiming Wang/);
    assert.match(html, /mailto:owenwhm@gmail\.com/);
    assert.match(html, /Retention and deletion/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /\[.*(?:OWNER TO COMPLETE|PRIVACY EMAIL|LEGAL ENTITY).*\]/);
  }
  const landing = await handle(new Request("https://public-page-smoke.example/"));
  assert.equal(landing.status, 200);
  const html = await landing.text();
  assert.match(html, /href="\/privacy"/);
  console.log("SupplierSignal public-page smoke checks passed (no login, billing, cookies, or service calls)");
} finally {
  globalThis.fetch = originalFetch;
  await globalThis.prismaGlobal.$disconnect();
  delete globalThis.prismaGlobal;
  rmSync(directory, { recursive: true, force: true });
}
