import test from "node:test";
import assert from "node:assert/strict";
import { computeExecutionCalibration } from "../src/services/executionCalibration.js";

function makeTrades(count, rowFn) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }).map((_, i) => ({
    exitTime: new Date(base + i * 60_000).toISOString(),
    ...rowFn(i)
  }));
}

test("execution calibration reports ready with enough samples", () => {
  const trades = makeTrades(60, (i) => ({
    netPnlJpy: i % 2 === 0 ? 1200 : -900,
    slippagePips: 0.35,
    latencyMs: 340,
    exitReason: "auto-tp"
  }));
  const out = computeExecutionCalibration(trades, { enabled: true, minTrades: 30, lookbackTrades: 60 });
  assert.equal(out.ready, true);
  assert.ok(Number.isFinite(out.slippageAdj));
});

test("execution calibration can infer rejects from orders and audit logs", () => {
  const trades = makeTrades(40, () => ({
    netPnlJpy: -200,
    slippagePips: 0.2,
    latencyMs: 210,
    exitReason: "auto-ttl"
  }));
  const orders = Array.from({ length: 20 }).map((_, i) => ({
    id: `o-${i}`,
    status: i < 8 ? "REJECTED" : "FILLED"
  }));
  const auditLogs = Array.from({ length: 12 }).map((_, i) => ({
    event: i < 7 ? "auto.order.rejected" : "auto.position.opened"
  }));
  const out = computeExecutionCalibration(
    { trades, orders, auditLogs },
    { enabled: true, minTrades: 30, lookbackTrades: 60 }
  );
  assert.equal(out.ready, true);
  assert.ok(out.stats.rejectRate > 0.1);
});
