import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAN_LIMITS } from "../src/shopify/billing.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("new-merchant landing offer is $49 USD with bounded setup and honest readiness", () => {
  const landing = read("app/routes/_index/route.tsx");
  assert.match(landing, /New-merchant pilot: \$49 USD\/month/);
  assert.doesNotMatch(landing, /<del\b|regularPrice|Founding price: \$19|Daily checks|Daily monitoring/);
  assert.match(landing, /1,500 source-check jobs per calendar month \(UTC\)/);
  assert.match(landing, /including failed jobs, confirmations, and repeat checks/);
  assert.match(landing, /One assisted setup of up to 30 minutes/);
  assert.match(landing, /Standard email support; no recurring concierge, SLA, or custom integrations/);
  assert.match(landing, /Monitoring cadence confirmed during setup, after source validation/);
  assert.match(landing, /No usage overage charges/);
  assert.match(landing, /Confirm the plan and price in Shopify before approving/);
  assert.match(landing, /Existing \$19 founding commitments keep their promised first six months/);
  assert.match(landing, /Existing subscriptions are not changed by this offer/);
});

test("active commercial guidance preserves legacy commitments and uses the new offer", () => {
  for (const path of ["ECONOMICS.md", "PILOT_AND_GTM.md", "README.md", "PROJECT_STATE.md", "PRIVACY_AND_TERMS_DRAFT.md"]) {
    const document = read(path);
    assert.match(document, /\$49 USD/, path);
    assert.match(document, /\$19/, `${path} must retain the legacy commitment boundary`);
    assert.match(document, /30 minutes/, path);
    assert.match(document, /1,500 source-check jobs/, path);
  }
  assert.match(read("RESEARCH.md"), /90-minute thresholds are superseded/);
  assert.match(read("ECONOMICS.md"), /There is no implemented 15% retry reserve/);
});

test("merchant usage wording distinguishes source-check jobs from provider calls", () => {
  const settings = read("app/routes/app.settings.tsx");
  assert.match(settings, /source-check jobs this calendar month \(UTC\)/);
  assert.match(settings, /Multiple provider calls within one job count as one source-check job/);
  assert.deepEqual(PLAN_LIMITS.pilot, { sources: 25, monthlyChecks: 1500 });
});
