import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCheckFeedback } from "../app/check-feedback.ts";
import { getCheckJob, startCheckJob } from "../app/check-jobs.server.ts";

const settled = () => new Promise(resolve => setImmediate(resolve));
const actionFor = job => ({ ok: true, checkJobId: job.id, message: "Checking the supplier page. Results will appear here automatically." });

test("launch feedback becomes completion feedback from polling without another action", async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const shop = "feedback-success.myshopify.com";
  let calls = 0;
  startCheckJob(shop, ["source"], { checkSource: async () => { calls += 1; await wait; } });
  const running = getCheckJob(shop);
  const action = actionFor(running);
  assert.match(getCheckFeedback(action, running, "idle").message, /Checking/);
  finish();
  await settled();
  const finished = getCheckJob(shop);
  assert.equal(finished.id, running.id);
  assert.match(getCheckFeedback(action, finished, "idle").message, /^Finished 1 check/);
  assert.doesNotMatch(getCheckFeedback(action, finished, "idle").message, /Checking/);
  assert.equal(calls, 1);
});

test("terminal failure replaces the launch notice with a failure summary", async () => {
  const shop = "feedback-failure.myshopify.com";
  startCheckJob(shop, ["source"], { checkSource: async () => { throw new Error("fixture failure"); } });
  const action = actionFor(getCheckJob(shop));
  await settled();
  const feedback = getCheckFeedback(action, getCheckJob(shop), "idle");
  assert.equal(feedback.ok, false);
  assert.match(feedback.message, /1 failed/);
  assert.doesNotMatch(feedback.message, /Checking/);
});

test("new submissions and jobs cannot inherit or revive an older job's feedback", async () => {
  const shop = "feedback-newer.myshopify.com";
  const service = { checkSource: async () => {} };
  startCheckJob(shop, ["old"], service);
  const oldAction = actionFor(getCheckJob(shop));
  await settled();
  const oldJob = getCheckJob(shop);
  for (const state of ["submitting", "loading"]) {
    assert.equal(getCheckFeedback(oldAction, oldJob, state), null);
  }
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  startCheckJob(shop, ["new"], { checkSource: async () => { await wait; } });
  const newJob = getCheckJob(shop);
  const newAction = actionFor(newJob);
  assert.notEqual(newJob.id, oldJob.id);
  assert.equal(getCheckFeedback(newAction, oldJob, "idle"), null);
  assert.equal(getCheckFeedback(oldAction, newJob, "idle"), null);
  assert.match(getCheckFeedback(newAction, newJob, "idle").message, /Checking/);
  assert.equal(startCheckJob(shop, ["duplicate"], service), false);
  assert.equal(getCheckJob(shop).id, newJob.id);
  finish();
  await settled();
  assert.equal(getCheckFeedback(oldAction, getCheckJob(shop), "idle"), null);
  assert.match(getCheckFeedback(newAction, getCheckJob(shop), "idle").message, /^Finished/);
});

test("missing/restarted jobs do not keep a running notice and ordinary action errors remain visible", () => {
  assert.equal(getCheckFeedback({ ok: true, checkJobId: "gone", message: "Checking" }, null, "idle"), null);
  assert.equal(getCheckFeedback(undefined, null, "idle"), null);
  assert.deepEqual(getCheckFeedback({ ok: false, message: "Product not found." }, null, "idle"), {
    ok: false, message: "Product not found.",
  });
});

test("both watchlist and detail routes use live-job feedback rather than stale action text", () => {
  for (const route of ["app._index.tsx", "app.products.$sourceId.tsx"]) {
    const text = readFileSync(new URL(`../app/routes/${route}`, import.meta.url), "utf8");
    assert.match(text, /getCheckFeedback\(fetcher.data, data.checkJob, fetcher.state\)/);
    assert.match(text, /\{feedback.message\}/);
    assert.doesNotMatch(text, /\{fetcher.data.message\}/);
  }
  const actionText = readFileSync(new URL("../app/watchlist.server.ts", import.meta.url), "utf8");
  assert.equal((actionText.match(/checkJobId: started \? job\?\.id : null/g) || []).length, 2);
});

test("a declined duplicate request cannot claim completion of the unrelated active job", () => {
  const declined = { ok: false, checkJobId: null, message: "A check was already running." };
  const unrelated = { id: "other", status: "finished", failed: 0, message: "Finished 1 check." };
  assert.deepEqual(getCheckFeedback(declined, unrelated, "idle"), {
    ok: false, message: "A check was already running.",
  });
});
