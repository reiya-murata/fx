import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePreTradeGuard } from "../src/services/preTradeGuard.js";

const baseInput = {
  signal: {
    confidence: 0.62,
    regime: "RANGE",
    metrics: {
      spreadPips: 0.2,
      expectedValuePips: 0.22,
      estimatedCostPips: 0.08
    },
    news: { shortTermRiskLevel: 0.1 }
  },
  ticker: { ts: new Date(Date.UTC(2026, 0, 2, 3, 0, 0)).toISOString(), spreadPips: 0.2 },
  executionProfile: { stress: 0.8 },
  contextValidation: { mode: "VALIDATED" },
  degradationGuard: { minConfidenceAdd: 0 }
};

test("pre-trade guard passes healthy setup", () => {
  const out = evaluatePreTradeGuard({
    ...baseInput,
    cfg: {
      enabled: true,
      baseMinConfidence: 0.5,
      minNetEdgePips: 0.05,
      maxSpreadPips: 0.35,
      maxExecutionStress: 1.5
    }
  });
  assert.equal(out.allowed, true);
});

test("pre-trade guard blocks low-confidence/low-edge setup", () => {
  const out = evaluatePreTradeGuard({
    ...baseInput,
    signal: {
      ...baseInput.signal,
      confidence: 0.4,
      metrics: { ...baseInput.signal.metrics, expectedValuePips: 0.02, estimatedCostPips: 0.08 }
    },
    cfg: {
      enabled: true,
      baseMinConfidence: 0.55,
      minNetEdgePips: 0.08,
      maxSpreadPips: 0.35,
      maxExecutionStress: 1.5
    }
  });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /confidence|edge/i);
});

test("pre-trade guard uses dynamic spread gate to avoid over-blocking", () => {
  const out = evaluatePreTradeGuard({
    ...baseInput,
    signal: {
      ...baseInput.signal,
      metrics: { ...baseInput.signal.metrics, spreadPips: 0.3, expectedValuePips: 0.24, estimatedCostPips: 0.08 }
    },
    spreadStats: { avgSpreadPips: 0.26, spreadStdPips: 0.04, ewmaSpreadPips: 0.27 },
    cfg: {
      enabled: true,
      baseMinConfidence: 0.5,
      minNetEdgePips: 0.05,
      maxSpreadPips: 0.34,
      maxExecutionStress: 1.5,
      dynamicSpreadGate: {
        enabled: true,
        stdMultiplier: 1,
        maxSpreadCapPips: 0.45,
        minSpreadFloorPips: 0.2
      }
    }
  });
  assert.equal(out.allowed, true);
  assert.ok(out.spreadGatePips >= 0.3);
});

test("pre-trade guard allows warn-only in bootstrap relax mode", () => {
  const out = evaluatePreTradeGuard({
    ...baseInput,
    signal: {
      ...baseInput.signal,
      confidence: 0.44,
      metrics: { ...baseInput.signal.metrics, expectedValuePips: -0.3, estimatedCostPips: 0.12 }
    },
    contextValidation: { mode: "LIVE_LIMITED" },
    cfg: {
      enabled: true,
      baseMinConfidence: 0.52,
      minNetEdgePips: 0.08,
      maxSpreadPips: 0.34,
      maxExecutionStress: 1.5,
      bootstrapRelax: {
        enabled: true,
        modes: ["BOOTSTRAP", "LIVE_LIMITED"],
        confidenceFloorDelta: -0.06,
        minNetEdgePips: -0.25,
        warnOnly: true
      }
    }
  });
  assert.equal(out.allowed, true);
  assert.equal(out.warnOnly, true);
  assert.match(out.reason, /warn-only/i);
});
