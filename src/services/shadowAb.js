import { analyticsSummary } from "./analytics.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizedProfile(profile) {
  const p = String(profile || "BASELINE").toUpperCase();
  return p || "BASELINE";
}

export function listShadowProfiles(cfg = {}) {
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles.map(normalizedProfile) : ["BASELINE", "CANDIDATE_A"];
  if (!profiles.includes("BASELINE")) profiles.unshift("BASELINE");
  return [...new Set(profiles)];
}

export function buildSignalConfigForProfile(baseConfig, profile = "BASELINE") {
  const p = normalizedProfile(profile);
  if (p === "BASELINE") return baseConfig;
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const byProfile = cfg?.shadowAB?.candidateAdjustmentsByProfile || {};
  const adj = byProfile[p] || {};
  cfg.executionGate.minRiskReward = clamp(
    Number(cfg.executionGate.minRiskReward || 1) + Number(adj.minRiskRewardDelta || 0),
    0.8,
    3
  );
  cfg.executionGate.minExpectedValuePips = clamp(
    Number(cfg.executionGate.minExpectedValuePips || 0) + Number(adj.minExpectedValuePipsDelta || 0),
    -0.2,
    1
  );
  cfg.shadowAB = {
    ...(cfg.shadowAB || {}),
    profileConfidenceDelta: Number(adj.confidenceDelta || 0)
  };
  return cfg;
}

export function applyProfileConfidence(signal, config, profile = "BASELINE") {
  const p = normalizedProfile(profile);
  if (!signal || p === "BASELINE") return signal;
  const delta = Number(config?.shadowAB?.profileConfidenceDelta || 0);
  if (Math.abs(delta) < 1e-9) return signal;
  return {
    ...signal,
    confidence: clamp(Number(signal.confidence || 0.3) + delta, 0.2, 0.98)
  };
}

export function evaluateShadowPromotion(state, cfg = {}, now = new Date().toISOString()) {
  const profiles = listShadowProfiles(cfg);
  const minSamples = Math.max(10, Number(cfg.minSamplesPerProfile || 30));
  const tradesByProfile = state?.tradesByProfile || {};
  const baselineTrades = Array.isArray(tradesByProfile.BASELINE) ? tradesByProfile.BASELINE : [];

  const candidates = profiles
    .filter((p) => p !== "BASELINE")
    .map((p) => {
      const trades = Array.isArray(tradesByProfile[p]) ? tradesByProfile[p] : [];
      return { profile: p, trades };
    });

  const allReady = baselineTrades.length >= minSamples && candidates.every((c) => c.trades.length >= minSamples);
  if (!allReady) {
    return {
      approved: false,
      pending: true,
      bestProfile: "BASELINE",
      reason: "A/B判定待ち",
      comparedSamples: Object.fromEntries([
        ["BASELINE", baselineTrades.length],
        ...candidates.map((c) => [c.profile, c.trades.length])
      ]),
      decidedAt: now
    };
  }

  const base = analyticsSummary(baselineTrades.slice(-minSamples));
  const baseExpectancy = base.totalTrades > 0 ? base.netProfitJpy / base.totalTrades : 0;
  const minExpectancyDiff = Number(cfg.promoteMinExpectancyDiffJpy || 80);
  const maxDdWorsening = Number(cfg.promoteMaxDdWorseningJpy || 12000);

  let bestProfile = "BASELINE";
  let bestScore = -1e9;
  const reports = {};
  for (const c of candidates) {
    const s = analyticsSummary(c.trades.slice(-minSamples));
    const expectancy = s.totalTrades > 0 ? s.netProfitJpy / s.totalTrades : 0;
    const expectancyDiff = expectancy - baseExpectancy;
    const ddDiff = Number(s.maxDrawdownJpy || 0) - Number(base.maxDrawdownJpy || 0);
    const eligible = expectancyDiff >= minExpectancyDiff && ddDiff <= maxDdWorsening;
    const score = expectancyDiff - Math.max(0, ddDiff) * 0.003 + (eligible ? 120 : 0);
    reports[c.profile] = {
      expectancyJpy: Number(expectancy.toFixed(2)),
      winRate: Number((s.winRate || 0).toFixed(4)),
      maxDrawdownJpy: Number(s.maxDrawdownJpy || 0),
      expectancyDiffJpy: Number(expectancyDiff.toFixed(2)),
      drawdownDiffJpy: Number(ddDiff.toFixed(2)),
      eligible
    };
    if (score > bestScore && eligible) {
      bestScore = score;
      bestProfile = c.profile;
    }
  }
  const approved = bestProfile !== "BASELINE";
  return {
    approved,
    pending: false,
    bestProfile,
    reason: approved ? "candidate promoted" : "baseline retained",
    baseline: {
      expectancyJpy: Number(baseExpectancy.toFixed(2)),
      winRate: Number((base.winRate || 0).toFixed(4)),
      maxDrawdownJpy: Number(base.maxDrawdownJpy || 0)
    },
    candidates: reports,
    comparedSamples: Object.fromEntries([
      ["BASELINE", minSamples],
      ...candidates.map((c) => [c.profile, minSamples])
    ]),
    decidedAt: now
  };
}

export function selectProfileByThompson(state, cfg = {}, now = new Date()) {
  const profiles = listShadowProfiles(cfg);
  const tradesByProfile = state?.tradesByProfile || {};
  let bestProfile = "BASELINE";
  let bestSample = -1;
  const draws = {};
  for (const profile of profiles) {
    const trades = Array.isArray(tradesByProfile[profile]) ? tradesByProfile[profile] : [];
    const wins = trades.filter((t) => Number(t.netPnlJpy || 0) > 0).length;
    const losses = Math.max(0, trades.length - wins);
    const sample = pseudoBetaDraw(1 + wins, 1 + losses, `${profile}:${now.toISOString()}`);
    draws[profile] = Number(sample.toFixed(4));
    if (sample > bestSample) {
      bestSample = sample;
      bestProfile = profile;
    }
  }
  return { profile: bestProfile, draws };
}

function pseudoBetaDraw(alpha, beta, seedText) {
  const u1 = seededUnit(seedText, 0);
  const u2 = seededUnit(seedText, 1);
  const mean = alpha / Math.max(1e-9, alpha + beta);
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, u1))) * Math.cos(2 * Math.PI * u2);
  return clamp(mean + z * Math.sqrt(Math.max(1e-9, variance)), 0, 1);
}

function seededUnit(seedText, idx) {
  const s = `${seedText}|${idx}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000000) / 1000000;
}
