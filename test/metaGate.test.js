import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMetaGate } from "../src/services/metaGate.js";

test("meta gate blocks when composite score is low", () => {
  const out = evaluateMetaGate({
    benchmarkAllowed: true,
    walkForwardAllowed: false,
    walkForwardPending: false,
    expectancyAllowed: false,
    expectancyPending: false,
    anomalyBlocked: false,
    banditAdvantage: -0.08,
    banditGuardHold: true
  }, { enabled: true, minScore: 0.56 });
  assert.equal(out.allowed, false);
  assert.ok(out.score < 0.56);
});

test("meta gate passes under healthy components", () => {
  const out = evaluateMetaGate({
    benchmarkAllowed: true,
    walkForwardAllowed: true,
    expectancyAllowed: true,
    anomalyBlocked: false,
    banditAdvantage: 0.09,
    banditGuardHold: false
  }, { enabled: true, minScore: 0.56 });
  assert.equal(out.allowed, true);
});
