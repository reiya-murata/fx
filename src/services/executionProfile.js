function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jstHour(isoTs) {
  const t = new Date(isoTs || Date.now()).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).getUTCHours();
}

export function detectUsdJpySession(isoTs) {
  const h = jstHour(isoTs);
  if (h >= 9 && h < 15) return "TOKYO";
  if (h >= 15 && h < 22) return "LONDON";
  return "NY";
}

export function buildExecutionConfig(config, tick) {
  const session = detectUsdJpySession(tick?.ts);
  const profile = config?.execution?.sessionProfile?.[session] || {};
  const spreadPips = Number(tick?.spreadPips || 0.18);
  const spreadStress = clamp((spreadPips - 0.18) / 0.25, 0, 1.6);
  const news = tick?.news || {};
  const risk = clamp(Number(news.shortTermRiskLevel || 0), 0, 1);
  const dominantTag = String(news.dominantTag || "GENERAL").toUpperCase();
  const highImpact = Boolean(news.highImpactEvent || news.shortTermRiskLock);
  const eventProfile = resolveEventProfile(config, dominantTag, highImpact);
  const eventStress = clamp(
    (highImpact ? 0.65 : 0)
      + risk * 0.8
      + Number(eventProfile.stressAdd || 0),
    0,
    2.2
  );
  const stress = clamp(spreadStress + eventStress * 0.55, 0, 2.4);

  const next = JSON.parse(JSON.stringify(config));
  const e = next.execution;

  const spreadMul = clamp(Number(profile.spreadMultiplier || 1) * (1 + stress * 0.22), 0.85, 1.6);
  const latencyMul = clamp(Number(profile.latencyMultiplier || 1) * (1 + stress * 0.28), 0.75, 1.8);
  const eventDepthMul = clamp(Number(eventProfile.depthMul || 1), 0.65, 1.1);
  const eventSlipMul = clamp(Number(eventProfile.slippageMul || 1), 0.9, 1.8);
  const rejectAdd = Number(profile.rejectAdd || 0) + stress * 0.012 + Number(eventProfile.rejectAdd || 0);

  e.baseLatencyMs = Math.round(clamp(e.baseLatencyMs * latencyMul, 25, 1300));
  e.latencyJitterMs = Math.round(clamp(e.latencyJitterMs * (0.9 + stress * 0.35), 10, 1800));
  e.rejectProbability = clamp(e.rejectProbability + rejectAdd, 0.001, 0.25);
  e.depthBaseQty = Math.round(clamp(e.depthBaseQty * (1 - stress * 0.35) * eventDepthMul, 3000, 120000));
  e.depthStepPips = clamp(e.depthStepPips * spreadMul, 0.08, 0.8);
  e.maxSlippagePips = clamp(e.maxSlippagePips * spreadMul * eventSlipMul, 0.12, 2.4);
  e.randomSlippagePips = clamp((Number(e.randomSlippagePips || 0.08) + stress * 0.06) * eventSlipMul, 0.02, 1.2);
  e.favorableSlipProbability = clamp(Number(e.favorableSlipProbability || 0.08) - eventStress * 0.03, 0.01, 0.2);

  return {
    config: next,
    session,
    stress: Number(stress.toFixed(4)),
    spreadStress: Number(spreadStress.toFixed(4)),
    eventStress: Number(eventStress.toFixed(4)),
    eventTag: highImpact ? "HIGH_IMPACT" : dominantTag,
    spreadMul: Number(spreadMul.toFixed(4)),
    latencyMul: Number(latencyMul.toFixed(4)),
    rejectAdd: Number(rejectAdd.toFixed(4))
  };
}

function resolveEventProfile(config, dominantTag, highImpact) {
  const map = config?.execution?.eventProfile || {};
  if (highImpact && map.HIGH_IMPACT) return map.HIGH_IMPACT;
  if (dominantTag === "POLITICAL" && map.POLITICAL) return map.POLITICAL;
  if (dominantTag === "GEOPOLITICAL" && map.GEOPOLITICAL) return map.GEOPOLITICAL;
  return {};
}
