import test from "node:test";
import assert from "node:assert/strict";
import { buildLearnedContext } from "../src/services/learnedModel.js";

test("learned context stays disabled with insufficient samples", () => {
  const out = buildLearnedContext({
    samples: 20,
    corrEv: 0.2,
    corrRr: 0.1,
    corrMom: 0,
    corrConf: 0.1
  });
  assert.equal(out.ready, false);
  assert.equal(out.confidenceDelta, 0);
});

test("learned context provides bounded deltas with enough samples", () => {
  const out = buildLearnedContext({
    samples: 1200,
    corrEv: 0.18,
    corrRr: 0.11,
    corrMom: 0.06,
    corrConf: 0.15
  });
  assert.equal(out.ready, true);
  assert.ok(out.minExpectedValueDelta <= 0);
  assert.ok(out.minRiskRewardDelta <= 0);
  assert.ok(Math.abs(out.confidenceDelta) <= 0.08);
});
