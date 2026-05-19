import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildExecutionConfig, detectUsdJpySession } from "../src/services/executionProfile.js";

test("detectUsdJpySession classifies JST sessions", () => {
  assert.equal(detectUsdJpySession("2026-02-14T03:30:00.000Z"), "TOKYO");
  assert.equal(detectUsdJpySession("2026-02-14T08:30:00.000Z"), "LONDON");
  assert.equal(detectUsdJpySession("2026-02-14T16:30:00.000Z"), "NY");
});

test("buildExecutionConfig increases stress under wide spread", () => {
  const base = buildExecutionConfig(DEFAULT_CONFIG, { spreadPips: 0.18, ts: "2026-02-14T08:30:00.000Z" });
  const stressed = buildExecutionConfig(DEFAULT_CONFIG, { spreadPips: 0.45, ts: "2026-02-14T16:30:00.000Z" });

  assert.ok(stressed.stress > base.stress);
  assert.ok(stressed.config.execution.rejectProbability >= base.config.execution.rejectProbability);
  assert.ok(stressed.config.execution.depthBaseQty <= base.config.execution.depthBaseQty);
});

test("buildExecutionConfig tightens execution under high-impact events", () => {
  const normal = buildExecutionConfig(DEFAULT_CONFIG, {
    spreadPips: 0.2,
    ts: "2026-02-14T08:30:00.000Z",
    news: { shortTermRiskLevel: 0.1, dominantTag: "GENERAL", highImpactEvent: false }
  });
  const highImpact = buildExecutionConfig(DEFAULT_CONFIG, {
    spreadPips: 0.2,
    ts: "2026-02-14T08:30:00.000Z",
    news: { shortTermRiskLevel: 0.9, dominantTag: "POLITICAL", highImpactEvent: true }
  });

  assert.ok(highImpact.eventStress > normal.eventStress);
  assert.ok(highImpact.config.execution.maxSlippagePips >= normal.config.execution.maxSlippagePips);
  assert.ok(highImpact.config.execution.rejectProbability >= normal.config.execution.rejectProbability);
  assert.ok(highImpact.config.execution.depthBaseQty <= normal.config.execution.depthBaseQty);
});
