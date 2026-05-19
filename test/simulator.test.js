import test from "node:test";
import assert from "node:assert/strict";
import { MarketSimulator } from "../src/market/simulator.js";

test("market simulator generates ticker shape", () => {
  const sim = new MarketSimulator();
  const t = sim.step();
  assert.equal(t.symbol, "USDJPY");
  assert.ok(typeof t.bid === "number");
  assert.ok(typeof t.ask === "number");
  assert.ok(t.ask > t.bid);
});

test("market simulator provides candles by timeframe", () => {
  const sim = new MarketSimulator();
  for (let i = 0; i < 200; i += 1) sim.step();
  const c1 = sim.getCandles("1m", 50);
  const c15 = sim.getCandles("15m", 20);
  const c1h = sim.getCandles("1h", 20);
  const c1d = sim.getCandles("1d", 20);
  assert.ok(c1.length > 0);
  assert.ok(c15.length > 0);
  assert.ok(c1h.length > 0);
  assert.ok(c1d.length > 0);
});
