import test from "node:test";
import assert from "node:assert/strict";
import { analyticsGatePerformance } from "../src/services/analytics.js";

test("analyticsGatePerformance aggregates gate blocks and opened performance", () => {
  const trades = [
    { signalId: "s1", netPnlJpy: 120, holdingSeconds: 50, exitTime: "2026-01-01T00:01:00.000Z" },
    { signalId: "s2", netPnlJpy: -80, holdingSeconds: 40, exitTime: "2026-01-01T00:02:00.000Z" }
  ];
  const logs = [
    { ts: "2026-01-01T00:00:00.000Z", event: "auto.skip", reason: "pre-trade guard" },
    { ts: "2026-01-01T00:00:10.000Z", event: "auto.position.opened", signalId: "s1" },
    { ts: "2026-01-01T00:00:20.000Z", event: "auto.position.opened", signalId: "s2" },
    { ts: "2026-01-01T00:00:30.000Z", event: "auto.killswitch.stop" }
  ];
  const out = analyticsGatePerformance(trades, logs, { limit: 1000 });
  assert.equal(out.opened, 2);
  assert.equal(out.blocked["pre-trade guard"], 1);
  assert.equal(out.blocked.killSwitch, 1);
  assert.ok(out.openedPerformance.trades >= 2);
});

