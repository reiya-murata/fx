import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRiskGate } from "../src/engine/risk.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

test("position size follows user risk percent cap", () => {
  const signal = {
    action: "BUY",
    entryPrice: 150,
    stopLossPrice: 149.9
  };
  const baseAccount = {
    currentBalanceJpy: 1000000,
    dayPnlJpy: 0,
    weekDrawdownJpy: 0,
    consecutiveLosses: 0
  };

  const low = evaluateRiskGate({
    account: { ...baseAccount, maxRiskPercentPerTrade: 0.5 },
    signal,
    config: DEFAULT_CONFIG
  });
  const high = evaluateRiskGate({
    account: { ...baseAccount, maxRiskPercentPerTrade: 5 },
    signal,
    config: DEFAULT_CONFIG
  });

  assert.ok(low.positionSize > 0);
  assert.ok(high.positionSize > low.positionSize);
});

