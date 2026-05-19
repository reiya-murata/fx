import test from "node:test";
import assert from "node:assert/strict";
import { extractTickFromPayload } from "../src/market/liveFeed.js";

test("extracts bid/ask tick from generic payload", () => {
  const tick = extractTickFromPayload(JSON.stringify({ symbol: "USDJPY", bid: 149.9, ask: 149.92 }));
  assert.equal(tick.symbol, "USDJPY");
  assert.ok(tick.ask > tick.bid);
});

test("extracts tick from mid-price payload", () => {
  const tick = extractTickFromPayload(JSON.stringify({ pair: "USDJPY", price: 150.1 }));
  assert.equal(tick.symbol, "USDJPY");
  assert.ok(tick.ask > tick.bid);
});
