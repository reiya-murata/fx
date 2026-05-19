import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { simulateOrderLifecycle } from "../src/execution/stateMachine.js";

test("execution state machine returns valid structure", () => {
  const out = simulateOrderLifecycle({
    side: "BUY",
    qty: 1000,
    requestedPrice: 150.0,
    market: { bid: 149.99, ask: 150.01 },
    config: DEFAULT_CONFIG
  });

  assert.ok(out.order.id);
  assert.ok(Array.isArray(out.order.statusHistory));
  assert.ok(out.order.status);
  if (!out.rejected) {
    assert.ok(out.fills.length >= 1);
    assert.ok(out.executedQty > 0);
  }
});
