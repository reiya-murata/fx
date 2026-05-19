import test from "node:test";
import assert from "node:assert/strict";
import { buildAssistantDecision } from "../src/engine/assistant.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

function makeCandles(base, count, delta) {
  const out = [];
  let p = base;
  for (let i = 0; i < count; i += 1) {
    const d = i % 5 === 0 ? -delta * 0.5 : delta;
    const open = p;
    const close = p + d;
    out.push({
      open,
      close,
      high: Math.max(open, close) + delta * 0.5,
      low: Math.min(open, close) - delta * 0.5
    });
    p = close;
  }
  return out;
}

function buildInput(overrides = {}) {
  return {
    bid: 150.001,
    ask: 150.004,
    spreadPips: 0.2,
    candles1m: makeCandles(149.2, 150, 0.05),
    candles5m: makeCandles(149.0, 150, 0.08),
    candles15m: makeCandles(148.8, 150, 0.12),
    account: {
      currentBalanceJpy: 1000000,
      dayPnlJpy: 0,
      weekDrawdownJpy: 10000,
      consecutiveLosses: 0
    },
    ...overrides
  };
}

function buildPermissiveConfig() {
  return {
    ...DEFAULT_CONFIG,
    executionGate: {
      ...DEFAULT_CONFIG.executionGate,
      minExpectedValuePips: -10,
      minRiskReward: 0.5
    },
    spread: {
      ...DEFAULT_CONFIG.spread,
      maxPipsNormal: 0.5
    }
  };
}

test("returns actionable signal under healthy conditions", () => {
  const decision = buildAssistantDecision(buildInput(), buildPermissiveConfig());
  assert.notEqual(decision.action, "HOLD");
  assert.ok(decision.positionSize > 0);
  assert.equal(decision.safetyFlags.length, 0);
});

test("blocks trading when daily stop is reached", () => {
  const decision = buildAssistantDecision(
    buildInput({ account: { currentBalanceJpy: 1000000, dayPnlJpy: -30000, weekDrawdownJpy: 10000, consecutiveLosses: 0 } }),
    buildPermissiveConfig()
  );
  assert.equal(decision.action, "HOLD");
  assert.match(decision.rationale, /Daily stop reached/);
});

test("blocks trading in high volatility regime", () => {
  const decision = buildAssistantDecision(buildInput({ spreadPips: 0.8 }));
  assert.equal(decision.action, "HOLD");
  assert.match(decision.rationale, /High volatility safeguard|Spread too wide/);
});

test("does not hard-lock trading on consecutive losses", () => {
  const decision = buildAssistantDecision(
    buildInput({ account: { currentBalanceJpy: 1000000, dayPnlJpy: 0, weekDrawdownJpy: 10000, consecutiveLosses: 4 } })
  );
  assert.equal(/Consecutive loss lock/.test(decision.rationale), false);
});
