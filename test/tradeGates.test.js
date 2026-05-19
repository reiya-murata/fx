import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExpectancyGate, evaluateWalkForwardGate } from "../src/services/tradeGates.js";

function buildTrades(count, pnlByIndex) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `t-${i}`,
      side: i % 2 === 0 ? "BUY" : "SELL",
      entryTime: new Date(base + i * 60_000).toISOString(),
      exitTime: new Date(base + (i + 1) * 60_000).toISOString(),
      holdingSeconds: 60,
      netPnlJpy: pnlByIndex(i)
    });
  }
  return out;
}

test("walk-forward gate returns pending before minimum trades", () => {
  const trades = buildTrades(30, (i) => (i % 2 === 0 ? 1200 : -900));
  const out = evaluateWalkForwardGate(trades, { enforceForAuto: true, minTrades: 80, blockWhenInsufficient: false });
  assert.equal(out.pending, true);
  assert.equal(out.allowed, true);
});

test("walk-forward gate blocks when OOS quality is poor", () => {
  const trades = buildTrades(120, (i) => (i % 5 === 0 ? 400 : -1100));
  const out = evaluateWalkForwardGate(trades, {
    enforceForAuto: true,
    minTrades: 80,
    lookbackTrades: 120,
    minOosWinRate: 0.5,
    minOosProfitFactor: 1.1,
    minOosExpectancyJpy: 0,
    maxOosDrawdownJpy: 70000
  });
  assert.equal(out.pending, false);
  assert.equal(out.pass, false);
  assert.equal(out.allowed, false);
});

test("expectancy gate blocks when recent expectancy degrades", () => {
  const trades = buildTrades(36, (i) => (i % 4 === 0 ? 900 : -1300));
  const out = evaluateExpectancyGate(trades, {
    enabled: true,
    lookbackTrades: 30,
    minTrades: 20,
    minExpectancyJpy: 0,
    minWinRate: 0.45,
    minProfitFactor: 1.0,
    maxDrawdownJpy: 50000
  });

  assert.equal(out.pending, false);
  assert.equal(out.allowed, false);
  assert.equal(out.pass, false);
});

test("expectancy gate can use compressed memory when recent trades are insufficient", () => {
  const trades = buildTrades(8, (i) => (i % 2 === 0 ? 500 : -400));
  const out = evaluateExpectancyGate(
    trades,
    {
      enabled: true,
      lookbackTrades: 30,
      minTrades: 20,
      minExpectancyJpy: 50,
      minWinRate: 0.45,
      minProfitFactor: 1.01
    },
    {
      totalTrades: 500,
      ewmaExpectancyJpy: 120,
      ewmaWinRate: 0.53,
      ewmaProfitFactor: 1.2
    }
  );
  assert.equal(out.pending, false);
  assert.equal(out.allowed, true);
  assert.equal(out.source, "learning-memory");
});

test("expectancy gate stays warn-only when compressed memory is poor and blockOnCompressedMemoryFail=false", () => {
  const trades = buildTrades(6, () => -500);
  const out = evaluateExpectancyGate(
    trades,
    {
      enabled: true,
      lookbackTrades: 30,
      minTrades: 20,
      minExpectancyJpy: 80,
      minWinRate: 0.44,
      minProfitFactor: 1.02,
      blockOnCompressedMemoryFail: false
    },
    {
      totalTrades: 40,
      ewmaExpectancyJpy: -21.2,
      ewmaWinRate: 0.374,
      ewmaProfitFactor: 0.74
    }
  );
  assert.equal(out.allowed, true);
  assert.equal(out.pending, true);
  assert.equal(out.warnOnly, true);
});
