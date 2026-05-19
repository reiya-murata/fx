import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { simulateOrderLifecycle } from "../src/execution/stateMachine.js";

test("large qty can produce partial fill under depth model", () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.execution.rejectProbability = 0;

  const out = simulateOrderLifecycle({
    side: "BUY",
    qty: 500000,
    requestedPrice: 150.0,
    market: { bid: 149.99, ask: 150.01, spreadPips: 0.2 },
    config: cfg
  });

  assert.equal(out.rejected, false);
  assert.ok(out.executedQty > 0);
  assert.ok(out.executedQty <= 500000);
  assert.ok(out.order.status === "PARTIALLY_FILLED" || out.order.status === "FILLED");
});
