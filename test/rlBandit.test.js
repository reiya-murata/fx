import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  createPolicySnapshot,
  decideBanditGuard,
  listPolicySnapshots,
  restorePolicySnapshot,
  updateBanditFromTrade
} from "../src/services/rlBandit.js";

test("bandit returns guard decision shape", () => {
  const out = decideBanditGuard({
    signal: {
      action: "BUY",
      regime: "TREND_UP",
      confidence: 0.62,
      metrics: { spreadPips: 0.2, expectedValuePips: 0.32, rr: 1.5 },
      news: { shortTermRiskLevel: 0.1 }
    },
    ticker: { spreadPips: 0.2 },
    config: DEFAULT_CONFIG
  });
  assert.equal(typeof out.contextKey, "string");
  assert.equal(typeof out.guardHold, "boolean");
  assert.ok(Number.isFinite(out.sizeMultiplier));
});

test("bandit policy updates from trade outcome", () => {
  const updated = updateBanditFromTrade({
    trade: {
      side: "BUY",
      netPnlJpy: 12000,
      holdingSeconds: 45,
      regime: "TREND_UP",
      signalConfidence: 0.7,
      banditContextKey: "reg:TREND_UP|spr:LOW|ev:MID|rr:MID|risk:LOW|sess:TOKYO"
    },
    config: DEFAULT_CONFIG
  });
  assert.ok(updated);
  assert.ok(updated.count >= 1);
  assert.ok(Number.isFinite(updated.ewmaReward));
  assert.ok(updated.objectiveTag);
  assert.ok(updated.objectiveWeights);
});

test("bandit objective can tilt to win-rate in stressed macro losses", () => {
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = updateBanditFromTrade({
      trade: {
        side: "SELL",
        netPnlJpy: -18000,
        holdingSeconds: 140,
        regime: "RANGE",
        signalConfidence: 0.65,
        eventDominantTag: "MACRO",
        eventFeatureSnapshot: { highImpactRatio: 1, activeRatio: 1, avgAbsSurprise: 0.35 },
        banditContextKey: "reg:RANGE|spr:MID|ev:LOW|rr:MID|risk:MID|sess:NY|tag:MACRO"
      },
      config: DEFAULT_CONFIG
    });
  }
  assert.ok(last);
  assert.equal(last.objectiveTag, "MACRO");
  assert.ok(last.objectiveWeights.drawdownWeight >= 0.08);
  assert.ok(last.objectiveWeights.costWeight >= 0.04);
});

test("bandit policy snapshot create/list/restore works", () => {
  const created = createPolicySnapshot("unit-test");
  assert.ok(created.id);
  const list = listPolicySnapshots();
  assert.ok(list.some((x) => x.id === created.id));
  const restored = restorePolicySnapshot(created.id);
  assert.ok(restored);
  assert.equal(restored.id, created.id);
});
