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

test("newly confirmed products queue their first check behind an active run", async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const shop = "queued.myshopify.com";
  const service = { checkSource: async (_shop, id) => { calls.push(id); if (calls.length === 1) await waiting; } };
  startCheckJob(shop, ["old"], service);
  assert.equal(startCheckJob(shop, ["new"], service, true), true);
  assert.equal(startCheckJob(shop, ["new"], service, true), true);
  assert.equal(getCheckJob(shop).total, 2);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["old", "new"]);
  assert.equal(getCheckJob(shop).status, "finished");
  assert.equal(getCheckJob(shop).completed, 2);
});
