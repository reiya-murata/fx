import test from "node:test";
import assert from "node:assert/strict";
import { computeExecutionCalibrationFromTelemetry } from "../src/services/executionCalibration.js";

test("computeExecutionCalibrationFromTelemetry returns ready with enough records", () => {
  const rows = Array.from({ length: 220 }, (_, i) => ({
    ts: new Date(2026, 0, 1, 0, i).toISOString(),
    slippagePips: 0.2 + (i % 5) * 0.02,
    latencyMs: 200 + (i % 7) * 10,
    rejected: i % 20 === 0
  }));
  const out = computeExecutionCalibrationFromTelemetry(rows, {
    enabled: true,
    telemetryMinRecords: 150,
    targetRejectRate: 0.025,
    targetSlippagePips: 0.28,
    targetLatencyMs: 280
  });
  assert.equal(out.ready, true);
  assert.ok(Number.isFinite(out.rejectRateAdj));
  assert.ok(Number.isFinite(out.slippageAdj));
  assert.ok(Number.isFinite(out.latencyAdj));
});

