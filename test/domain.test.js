import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyObservation,
  decideTransition,
  evaluateAiObservation,
  incorporateAiObservation,
  isStale,
  STATES,
} from "../src/domain.js";

const source = {
  sku: "AFL-220",
  productTitle: "Arc Floor Lamp",
  matchTerms: ["AFL-220", "Arc Floor Lamp"],
  inStockTerms: [],
  outOfStockTerms: [],
  lastState: STATES.IN_STOCK,
  candidateState: null,
  candidateCount: 0,
};

test("classifies a matched in-stock page as factual", () => {
  const result = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. In stock and ships in 3 days.",
  });
  assert.equal(result.state, STATES.IN_STOCK);
  assert.equal(result.factual, true);
  assert.ok(result.confidence >= 0.8);
});

test("classifies an explicit sold-out page", () => {
  const result = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. Sold out.",
  });
  assert.equal(result.state, STATES.OUT_OF_STOCK);
  assert.equal(result.factual, true);
});

test("does not present preorder or backorder as in stock", () => {
  const preorder = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. Available for pre-order.",
  });
  const backordered = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. This item is backordered.",
  });
  assert.equal(preorder.state, STATES.PREORDER);
  assert.equal(backordered.state, STATES.BACKORDERED);
});

test("distinguishes discontinued products and lead-time-only copy", () => {
  const discontinued = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. This model is discontinued.",
  });
  const leadTime = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. Ships in 8 weeks.",
  });
  assert.equal(discontinued.state, STATES.DISCONTINUED);
  assert.equal(leadTime.state, STATES.LEAD_TIME);
});

test("does not mistake unavailable for available", () => {
  const result = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp",
    text: "SKU AFL-220. Currently unavailable.",
  });
  assert.equal(result.state, STATES.OUT_OF_STOCK);
});

test("does not trust related or structured stock when the product defers availability", () => {
  const result = classifyObservation({
    ...source,
    productTitle: "Aamnah Pouf",
    supplierSku: "AMH-002",
    matchTerms: ["AMH-002", "Aamnah"],
  }, {
    ok: true,
    url: "https://supplier.test/amh-002",
    title: "Aamnah Pouf",
    text: "Aamnah Pouf. SKU AMH-002. See Availability. Related pillow is in stock.",
    availabilityState: "IN_STOCK",
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
  assert.match(result.reason, /deferred/i);
});

test("AI cannot override deferred monitored availability with a generic stock phrase", () => {
  const page = {
    ok: true,
    url: "https://supplier.test/amh-002",
    title: "Aamnah AMH-002 Pouf",
    text: "AMH-002. See Availability. Related products. In Stock.",
  };
  const deterministic = classifyObservation({ ...source, matchTerms: ["AMH-002"] }, page);
  const evaluated = evaluateAiObservation(deterministic, page, {
    ok: true,
    provider: "siliconflow",
    productMatch: "MATCH",
    availability: "IN_STOCK",
    evidenceQuote: "In Stock",
    confidence: 0.95,
  });

  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.influencedDecision, true);
  assert.equal(evaluated.observation.state, STATES.UNCERTAIN);
  assert.match(evaluated.rejectionReason, /deferred/);
});

test("prefers structured provider availability over ambiguous page copy", () => {
  const result = classifyObservation(source, {
    ok: true,
    url: "https://supplier.test/a-1",
    title: "Arc Floor Lamp",
    text: "Arc Floor Lamp SKU AFL-220. Contact us for available accessories.",
    availabilityState: "OUT_OF_STOCK",
  });
  assert.equal(result.state, STATES.OUT_OF_STOCK);
  assert.equal(result.factual, true);
  assert.match(result.reason, /Structured provider/);
});

test("conflicting stock phrases are uncertain", () => {
  const result = classifyObservation(source, {
    ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp AFL-220",
    text: "In stock for display only. Online item sold out.",
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
});

test("wrong product match is uncertain", () => {
  const result = classifyObservation(source, {
    ok: true, url: "https://supplier.test/wrong", title: "Different lamp",
    text: "In stock.",
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.match(result.reason, /ambiguous/i);
});

test("missing fields are uncertain, not out of stock", () => {
  const result = classifyObservation(source, { ok: true, url: "https://supplier.test/a", title: "Arc Floor Lamp" });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
});

test("provider failure is a source error, not a stock event", () => {
  const result = classifyObservation(source, { ok: false, error: "HTTP 503" });
  assert.equal(result.state, STATES.SOURCE_ERROR);
  assert.equal(result.factual, false);
});

test("AI can turn unrecognized captured wording into verified availability", () => {
  const providerResult = {
    ok: true,
    url: "https://supplier.test/book",
    title: "A Light in the Attic",
    text: "TEST-BOOK-001. Availability: In stock (22 available)",
  };
  const deterministic = {
    state: STATES.UNCERTAIN,
    confidence: 0.55,
    reason: "No recognized availability statement",
    checkedAt: "2026-09-16T08:43:00.000Z",
    factual: false,
  };
  const result = incorporateAiObservation(deterministic, providerResult, {
    ok: true,
    productMatch: "MATCH",
    availability: "IN_STOCK",
    evidenceQuote: "In stock (22 available)",
    confidence: 0.96,
  });
  assert.equal(result.state, STATES.IN_STOCK);
  assert.equal(result.factual, true);
  assert.match(result.reason, /AI verified/);
});

test("AI cannot promote a fabricated evidence quote into a fact", () => {
  const deterministic = {
    state: STATES.UNCERTAIN,
    confidence: 0.55,
    reason: "No recognized availability statement",
    checkedAt: "2026-09-16T08:43:00.000Z",
    factual: false,
  };
  const result = incorporateAiObservation(deterministic, { text: "Contact the supplier for details." }, {
    ok: true,
    productMatch: "MATCH",
    availability: "IN_STOCK",
    evidenceQuote: "In stock now",
    confidence: 0.99,
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
  assert.match(result.reason, /could not be verified/);
});

test("rules and AI disagreement stays uncertain", () => {
  const deterministic = {
    state: STATES.OUT_OF_STOCK,
    confidence: 0.9,
    reason: "Matched sold out",
    checkedAt: "2026-09-16T08:43:00.000Z",
    factual: true,
  };
  const result = incorporateAiObservation(deterministic, { text: "In stock for display only. Online item sold out." }, {
    ok: true,
    productMatch: "MATCH",
    availability: "IN_STOCK",
    evidenceQuote: "In stock",
    confidence: 0.94,
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
  assert.match(result.reason, /conflict/);
});

test("JEV hard evidence failures cannot fall back to a convenient rules fact", () => {
  const deterministic = classifyObservation(source, {
    ok: true,
    title: "Arc Floor Lamp",
    text: "AFL-220. In stock.",
  });
  const result = incorporateAiObservation(deterministic, { text: "AFL-220. In stock." }, {
    ok: true,
    provider: "typesafe",
    productMatch: "MATCH",
    availability: "UNKNOWN",
    confidence: 0.95,
    reasonCode: "HARD_EVIDENCE_CONFLICT",
    reason: "Relevant supplier evidence is contradictory",
  });
  assert.equal(result.state, STATES.UNCERTAIN);
  assert.equal(result.factual, false);
});

test("a transition requires two consistent factual checks", () => {
  const observation = { state: STATES.OUT_OF_STOCK, factual: true, confidence: 0.92 };
  const first = decideTransition(source, observation, 2);
  assert.equal(first.confirmedState, STATES.IN_STOCK);
  assert.equal(first.candidateCount, 1);
  assert.equal(first.alert, null);
  const second = decideTransition({ ...source, candidateState: STATES.OUT_OF_STOCK, candidateCount: 1 }, observation, 2);
  assert.equal(second.confirmedState, STATES.OUT_OF_STOCK);
  assert.equal(second.alert.to, STATES.OUT_OF_STOCK);
});

test("uncertain observations clear pending transitions", () => {
  const result = decideTransition({ ...source, candidateState: STATES.OUT_OF_STOCK, candidateCount: 1 }, {
    state: STATES.UNCERTAIN, factual: false, confidence: 0.4,
  });
  assert.equal(result.confirmedState, STATES.IN_STOCK);
  assert.equal(result.candidateState, null);
  assert.equal(result.alert, null);
});

test("stale calculation respects the source threshold", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  assert.equal(isStale("2026-09-14T00:00:00Z", 24, now), true);
  assert.equal(isStale("2026-09-15T00:00:00Z", 24, now), false);
  assert.equal(isStale(null, 24, now), true);
});
