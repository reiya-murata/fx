function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function std(values = []) {
  if (!values.length) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const varV = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(varV);
}

export function evaluateEnsembleGate({ primarySignal, candidates = [], cfg = {} }) {
  if (!cfg?.enabled) {
    return {
      enabled: false,
      allowed: true,
      sizeMultiplier: 1,
      reason: "ensemble gate disabled",
      score: 1
    };
  }
  const list = Array.isArray(candidates) ? candidates : [];
  const minProfiles = Math.max(2, Number(cfg.minProfiles || 3));
  if (list.length < minProfiles) {
    return {
      enabled: true,
      allowed: true,
      pending: true,
      sizeMultiplier: 1,
      reason: `ensemble pending: ${list.length}/${minProfiles}`,
      score: 0.5
    };
  }

  const primaryAction = String(primarySignal?.action || "HOLD");
  const actions = list.map((c) => String(c?.signal?.action || "HOLD"));
  const nonHoldActions = actions.filter((a) => a === "BUY" || a === "SELL");
  const sameActionCount = actions.filter((a) => a === primaryAction).length;
  const agreementRatio = sameActionCount / Math.max(1, list.length);
  const nonHoldRatio = nonHoldActions.length / Math.max(1, list.length);
  const confidenceStd = std(list.map((c) => Number(c?.signal?.confidence || 0)));
  const evStd = std(list.map((c) => Number(c?.signal?.metrics?.expectedValuePips || 0)));
  const rrStd = std(list.map((c) => Number(c?.signal?.metrics?.rr || 0)));

  const minAgreement = clamp(Number(cfg.minAgreementRatio || 0.66), 0.2, 1);
  const maxConfidenceStd = clamp(Number(cfg.maxConfidenceStd || 0.14), 0.01, 1);
  const maxEvStd = clamp(Number(cfg.maxEvStd || 0.55), 0.05, 5);
  const maxRrStd = clamp(Number(cfg.maxRrStd || 0.42), 0.05, 5);

  const disagreementPenalty = clamp((minAgreement - agreementRatio) * 2.2, 0, 1);
  const confidencePenalty = clamp((confidenceStd - maxConfidenceStd) / maxConfidenceStd, 0, 1);
  const evPenalty = clamp((evStd - maxEvStd) / maxEvStd, 0, 1);
  const rrPenalty = clamp((rrStd - maxRrStd) / maxRrStd, 0, 1);
  const score = Number(clamp(1 - disagreementPenalty - confidencePenalty * 0.35 - evPenalty * 0.3 - rrPenalty * 0.3, 0, 1).toFixed(4));
  const sizeMultiplier = Number(clamp(0.25 + score * 0.9, Number(cfg.minSizeMultiplier || 0.25), 1).toFixed(4));

  const reasons = [];
  if (agreementRatio < minAgreement) reasons.push(`agreement low ${agreementRatio.toFixed(3)} < ${minAgreement.toFixed(3)}`);
  if (confidenceStd > maxConfidenceStd) reasons.push(`confidence dispersion high ${confidenceStd.toFixed(3)} > ${maxConfidenceStd.toFixed(3)}`);
  if (evStd > maxEvStd) reasons.push(`ev dispersion high ${evStd.toFixed(3)} > ${maxEvStd.toFixed(3)}`);
  if (rrStd > maxRrStd) reasons.push(`rr dispersion high ${rrStd.toFixed(3)} > ${maxRrStd.toFixed(3)}`);
  if (primaryAction !== "HOLD" && nonHoldRatio < Number(cfg.minActionableRatio || 0.34)) {
    reasons.push(`actionable ratio low ${nonHoldRatio.toFixed(3)}`);
  }

  return {
    enabled: true,
    allowed: reasons.length === 0,
    score,
    sizeMultiplier,
    agreementRatio: Number(agreementRatio.toFixed(4)),
    actionableRatio: Number(nonHoldRatio.toFixed(4)),
    confidenceStd: Number(confidenceStd.toFixed(4)),
    evStd: Number(evStd.toFixed(4)),
    rrStd: Number(rrStd.toFixed(4)),
    reason: reasons.length ? reasons.join("; ") : "ensemble gate pass"
  };
}

