import test from "node:test";
import assert from "node:assert/strict";
import { getCheckJob, startCheckJob } from "../app/check-jobs.server.ts";

test("supplier checks return immediately and reject duplicate runs until finished", async () => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const service = { checkSource: async (shop, sourceId) => {
    calls.push([shop, sourceId]);
    await waiting;
  } };
  assert.equal(startCheckJob("test.myshopify.com", ["first"], service), true);
  assert.equal(getCheckJob("test.myshopify.com").status, "running");
  assert.equal(startCheckJob("test.myshopify.com", ["first"], service), false);
  assert.deepEqual(calls, [["test.myshopify.com", "first"]]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getCheckJob("test.myshopify.com").status, "finished");
  assert.equal(getCheckJob("test.myshopify.com").completed, 1);
});
