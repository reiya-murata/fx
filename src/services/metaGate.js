function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function scoreBoolean(ok) {
  return ok ? 1 : 0;
}

export function evaluateMetaGate(input = {}, cfg = {}) {
  if (!Boolean(cfg.enabled)) {
    return { allowed: true, enabled: false, score: 1, reason: "meta gate disabled", components: {} };
  }
  const w = cfg.weights || {};
  const weights = {
    benchmark: Number(w.benchmark || 0.16),
    walkForward: Number(w.walkForward || 0.22),
    expectancy: Number(w.expectancy || 0.22),
    anomaly: Number(w.anomaly || 0.16),
    bandit: Number(w.bandit || 0.16),
    objective: Number(w.objective || 0.08)
  };
  const totalWeight = Object.values(weights).reduce((s, x) => s + x, 0) || 1;
  const normalizedWeights = Object.fromEntries(
    Object.entries(weights).map(([k, v]) => [k, v / totalWeight])
  );

  const benchmarkScore = scoreBoolean(Boolean(input.benchmarkAllowed));
  const walkForwardScore = input.walkForwardPending
    ? 0.55
    : scoreBoolean(Boolean(input.walkForwardAllowed));
  const expectancyScore = input.expectancyPending
    ? 0.55
    : scoreBoolean(Boolean(input.expectancyAllowed));
  const anomalyScore = scoreBoolean(!Boolean(input.anomalyBlocked));
  const banditAdvantage = Number(input.banditAdvantage || 0);
  const banditScore = clamp(0.5 + banditAdvantage * 1.8 - (input.banditGuardHold ? 0.24 : 0), 0, 1);
  const objectiveScore = clamp(Number(input.objectiveNormalizedScore || 0.5), 0, 1);

  const components = {
    benchmark: Number(benchmarkScore.toFixed(4)),
    walkForward: Number(walkForwardScore.toFixed(4)),
    expectancy: Number(expectancyScore.toFixed(4)),
    anomaly: Number(anomalyScore.toFixed(4)),
    bandit: Number(banditScore.toFixed(4)),
    objective: Number(objectiveScore.toFixed(4))
  };

  const score = Number((
    components.benchmark * normalizedWeights.benchmark
    + components.walkForward * normalizedWeights.walkForward
    + components.expectancy * normalizedWeights.expectancy
    + components.anomaly * normalizedWeights.anomaly
    + components.bandit * normalizedWeights.bandit
    + components.objective * normalizedWeights.objective
  ).toFixed(4));
  const minScore = Number(cfg.minScore || 0.56);
  const allowed = score >= minScore;
  return {
    enabled: true,
    allowed,
    score,
    minScore,
    reason: allowed ? "meta gate pass" : "meta gate score below threshold",
    components
  };
}
