import test from "node:test";
import assert from "node:assert/strict";
import { buildNewsContext, normalizeNewsItem, scoreHeadline } from "../src/services/news.js";

test("news scoring detects bullish USDJPY headline", () => {
  const score = scoreHeadline("Hawkish Fed and strong US jobs data");
  assert.ok(score > 0);
});

test("news context returns high-impact lock signal", () => {
  const item = normalizeNewsItem({
    headline: "BoJ tightening and risk-off flows",
    impact: "HIGH",
    ts: new Date().toISOString()
  });
  const context = buildNewsContext([item]);
  assert.equal(context.highImpactEvent, true);
  assert.ok(context.directionBias === "BUY" || context.directionBias === "SELL" || context.directionBias === "NEUTRAL");
});

test("news context links event ids and feature vector", () => {
  const now = new Date();
  const item = normalizeNewsItem({
    id: "evt-001",
    headline: "US CPI release expected: 3.0% actual: 3.4%",
    impact: "HIGH",
    expected: "3.0%",
    actual: "3.4%",
    ts: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    eventTime: now.toISOString()
  });
  const context = buildNewsContext([item], { now: now.toISOString() });
  assert.deepEqual(context.linkedEventIds, ["evt-001"]);
  assert.ok(context.activeEventIds.includes("evt-001"));
  assert.ok(context.eventFeatureVector.highImpactCount >= 1);
  assert.ok(Number.isFinite(context.eventFeatureVector.avgAbsSurprise));
  assert.ok(typeof context.dominantTag === "string");
});
