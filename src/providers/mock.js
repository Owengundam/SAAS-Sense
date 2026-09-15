import { readFileSync } from "node:fs";

export class MockProvider {
  constructor({ fixturePath, fixtures } = {}) {
    this.fixtures = fixtures || JSON.parse(readFileSync(fixturePath, "utf8"));
    this.sequences = new Map();
  }

  queue(url, results) {
    this.sequences.set(url, [...results]);
  }

  async fetchPage(source) {
    const queued = this.sequences.get(source.url);
    if (queued?.length) return queued.shift();
    const fixture = this.fixtures[source.url];
    if (!fixture) return { ok: false, error: "Mock source unavailable", runId: `mock-missing-${source.id}` };
    return { ok: true, ...fixture };
  }
}
