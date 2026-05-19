import test from "node:test";
import assert from "node:assert/strict";
import { parseYahooChartCandles } from "../src/market/history.js";

test("parseYahooChartCandles parses valid ohlc rows", () => {
  const payload = {
    chart: {
      result: [{
        timestamp: [1739404800, 1739404860, 1739404920],
        indicators: {
          quote: [{
            open: [154.1, 154.11, 154.12],
            high: [154.12, 154.13, 154.15],
            low: [154.08, 154.1, 154.11],
            close: [154.11, 154.12, 154.14]
          }]
        }
      }]
    }
  };
  const out = parseYahooChartCandles(payload);
  assert.equal(out.length, 3);
  assert.equal(out[0].open, 154.1);
  assert.equal(out[2].close, 154.14);
  assert.ok(typeof out[0].ts === "string");
});

test("parseYahooChartCandles skips invalid rows", () => {
  const payload = {
    chart: {
      result: [{
        timestamp: [1739404800, 1739404860],
        indicators: {
          quote: [{
            open: [154.1, null],
            high: [154.2, 154.3],
            low: [154.0, 154.1],
            close: [154.15, 154.2]
          }]
        }
      }]
    }
  };
  const out = parseYahooChartCandles(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].close, 154.15);
});

