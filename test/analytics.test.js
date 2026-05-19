import test from "node:test";
import assert from "node:assert/strict";
import { analyticsAssistantImpact, analyticsByHour, analyticsByWeekday, analyticsEventImpact, analyticsSummary, analyticsValidationReport200 } from "../src/services/analytics.js";

const trades = [
  { exitTime: "2026-02-10T01:10:00.000Z", netPnlJpy: 1200, assistantAdopted: true },
  { exitTime: "2026-02-10T01:30:00.000Z", netPnlJpy: -800, assistantAdopted: false },
  { exitTime: "2026-02-11T13:00:00.000Z", netPnlJpy: 600, assistantAdopted: true }
];

test("analyticsSummary calculates core metrics", () => {
  const out = analyticsSummary(trades, "2026-02-10", "2026-02-11");
  assert.equal(out.totalTrades, 3);
  assert.equal(out.wins, 2);
  assert.equal(out.losses, 1);
  assert.equal(out.netProfitJpy, 1000);
});

test("analyticsByHour returns 24 buckets", () => {
  const items = analyticsByHour(trades);
  assert.equal(items.length, 24);
  assert.equal(items[1].trades, 2);
  assert.equal(items[13].trades, 1);
});

test("assistant impact splits adopted and non-adopted", () => {
  const out = analyticsAssistantImpact(trades);
  assert.equal(out.adopted.trades, 2);
  assert.equal(out.notAdopted.trades, 1);
});

test("analyticsByWeekday aggregates by UTC weekday", () => {
  const items = analyticsByWeekday(trades);
  assert.equal(items.length, 7);
  const total = items.reduce((s, v) => s + v.trades, 0);
  assert.equal(total, 3);
});

test("analyticsEventImpact aggregates by event id and tag", () => {
  const enriched = [
    { exitTime: "2026-02-10T01:10:00.000Z", netPnlJpy: 1200, linkedEventIds: ["evt-a"], eventDominantTag: "MACRO" },
    { exitTime: "2026-02-10T01:30:00.000Z", netPnlJpy: -800, linkedEventIds: ["evt-a"], eventDominantTag: "MACRO" },
    { exitTime: "2026-02-11T13:00:00.000Z", netPnlJpy: 600, linkedEventIds: ["evt-b"], eventDominantTag: "POLITICAL" }
  ];
  const out = analyticsEventImpact(enriched, { minTrades: 1 });
  assert.ok(out.eventItems.length >= 2);
  assert.ok(out.tagItems.some((x) => x.tag === "MACRO"));
  assert.ok(out.tagItems.some((x) => x.tag === "POLITICAL"));
});

test("analyticsValidationReport200 returns pending when samples are short", () => {
  const out = analyticsValidationReport200(trades, { minTrades: 200 });
  assert.equal(out.ok, false);
  assert.equal(out.requirement, 200);
});
