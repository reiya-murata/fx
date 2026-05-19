import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSignalConfigForProfile, evaluateShadowPromotion } from "../src/services/shadowAb.js";

function makeTrades(count, pnlFn) {
  const base = Date.parse("2026-02-01T00:00:00.000Z");
  return Array.from({ length: count }).map((_, i) => ({
    side: i % 2 === 0 ? "BUY" : "SELL",
    entryTime: new Date(base + i * 60_000).toISOString(),
    exitTime: new Date(base + (i + 1) * 60_000).toISOString(),
    netPnlJpy: pnlFn(i)
  }));
}

test("candidate profile tightens execution gate", () => {
  const cfg = buildSignalConfigForProfile(DEFAULT_CONFIG, "CANDIDATE_A");
  assert.ok(cfg.executionGate.minRiskReward > DEFAULT_CONFIG.executionGate.minRiskReward);
  assert.ok(cfg.executionGate.minExpectedValuePips > DEFAULT_CONFIG.executionGate.minExpectedValuePips);
});

test("shadow promotion approves better candidate under sample rule", () => {
  const baseline = makeTrades(40, (i) => (i % 3 === 0 ? 900 : -700));
  const candidate = makeTrades(40, (i) => (i % 3 === 0 ? 1200 : -450));
  const out = evaluateShadowPromotion(
    { tradesByProfile: { BASELINE: baseline, CANDIDATE_A: candidate } },
    {
      profiles: ["BASELINE", "CANDIDATE_A"],
      minSamplesPerProfile: 30,
      promoteMinExpectancyDiffJpy: 50,
      promoteMaxDdWorseningJpy: 15000
    }
  );
  assert.equal(out.pending, false);
  assert.equal(out.approved, true);
  assert.equal(out.bestProfile, "CANDIDATE_A");
});
