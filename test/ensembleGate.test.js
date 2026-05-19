import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEnsembleGate } from "../src/services/ensembleGate.js";

function mk(signal) {
  return { signal };
}

test("ensemble gate passes when profile actions agree", () => {
  const out = evaluateEnsembleGate({
    primarySignal: { action: "BUY" },
    candidates: [
      mk({ action: "BUY", confidence: 0.61, metrics: { expectedValuePips: 0.2, rr: 1.3 } }),
      mk({ action: "BUY", confidence: 0.6, metrics: { expectedValuePips: 0.22, rr: 1.2 } }),
      mk({ action: "BUY", confidence: 0.63, metrics: { expectedValuePips: 0.24, rr: 1.35 } })
    ],
    cfg: { enabled: true, minProfiles: 3, minAgreementRatio: 0.66 }
  });
  assert.equal(out.allowed, true);
});

test("ensemble gate blocks when profile actions disagree", () => {
  const out = evaluateEnsembleGate({
    primarySignal: { action: "BUY" },
    candidates: [
      mk({ action: "BUY", confidence: 0.62, metrics: { expectedValuePips: 0.25, rr: 1.2 } }),
      mk({ action: "SELL", confidence: 0.58, metrics: { expectedValuePips: 0.18, rr: 1.1 } }),
      mk({ action: "HOLD", confidence: 0.4, metrics: { expectedValuePips: 0.02, rr: 0.8 } })
    ],
    cfg: { enabled: true, minProfiles: 3, minAgreementRatio: 0.66 }
  });
  assert.equal(out.allowed, false);
});

