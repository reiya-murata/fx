import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const POLICY_PATH = resolve(process.cwd(), "data/rl_policy.json");
const SNAPSHOT_DIR = resolve(process.cwd(), "data/rl_policy_versions");

const DEFAULT_POLICY = {
  version: 1,
  updatedAt: null,
  totalUpdates: 0,
  contexts: {},
  objectivesByTag: {},
  objectiveStatsByTag: {}
};

export function decideBanditGuard({ signal, ticker, config, now = new Date() }) {
  if (!config?.rlBandit?.enabled) {
    return disabledResult();
  }
  if (!signal || signal.action === "HOLD") {
    return {
      ...disabledResult(),
      selectedAction: "HOLD",
      guardHold: true,
      reason: "base-hold"
    };
  }

  const policy = loadPolicy();
  const contextKey = buildContextKey(signal, ticker, now);
  const holdScore = scoreAction(policy, contextKey, "HOLD", config.rlBandit.explorationC);
  const actionScore = scoreAction(policy, contextKey, signal.action, config.rlBandit.explorationC);
  const totalSamples = contextSampleCount(policy, contextKey);
  if (totalSamples < 8) {
    return {
      enabled: true,
      contextKey,
      selectedAction: signal.action,
      guardHold: false,
      reason: "warmup-pass",
      holdScore: round4(holdScore),
      actionScore: round4(actionScore),
      advantage: round4(actionScore - holdScore),
      sizeMultiplier: 1,
      policyVersion: policy.version
    };
  }
  const threshold = Number(config.rlBandit.holdAdvantageThreshold || 0.03);
  const guardHold = actionScore < (holdScore + threshold);
  const advantage = actionScore - holdScore;
  const sizeMultiplier = clamp(
    0.9 + advantage * 0.9,
    Number(config.rlBandit.minSizeMultiplier || 0.5),
    Number(config.rlBandit.maxSizeMultiplier || 1.25)
  );

  return {
    enabled: true,
    contextKey,
    selectedAction: guardHold ? "HOLD" : signal.action,
    guardHold,
    reason: guardHold ? "bandit-hold-guard" : "bandit-pass",
    holdScore: round4(holdScore),
    actionScore: round4(actionScore),
    advantage: round4(advantage),
    sizeMultiplier: round4(sizeMultiplier),
    policyVersion: policy.version
  };
}

export function updateBanditFromTrade({ trade, config }) {
  if (!config?.rlBandit?.enabled) return null;
  const contextKey = String(trade?.banditContextKey || "");
  const action = String(trade?.side || "");
  if (!contextKey || !(action === "BUY" || action === "SELL")) return null;

  const policy = loadPolicy(config);
  const objectiveTag = resolveEventTag(trade?.eventDominantTag);
  const objectiveWeights = resolveObjectiveWeights(policy, config, objectiveTag);
  const reward = normalizedReward(trade, objectiveWeights);
  const isWin = Number(trade?.netPnlJpy || 0) > 0 ? 1 : 0;
  const sampleWeight = computeSampleWeight(trade);
  const baseAlpha = Number(config.rlBandit.baseAlpha || 0.12);
  const alpha = clamp(baseAlpha * sampleWeight, 0.03, 0.35);

  const ctx = policy.contexts[contextKey] || {};
  const prev = ctx[action] || {
    count: 0,
    ewmaReward: 0,
    ewmaWinRate: 0.5,
    totalReward: 0,
    weightedCount: 0,
    lastUpdated: null
  };

  const next = {
    count: Number(prev.count || 0) + 1,
    ewmaReward: round4(alpha * reward + (1 - alpha) * Number(prev.ewmaReward || 0)),
    ewmaWinRate: round4(alpha * isWin + (1 - alpha) * Number(prev.ewmaWinRate || 0.5)),
    totalReward: round4(Number(prev.totalReward || 0) + reward * sampleWeight),
    weightedCount: round4(Number(prev.weightedCount || 0) + sampleWeight),
    lastReward: round4(reward),
    lastWeight: round4(sampleWeight),
    lastUpdated: new Date().toISOString()
  };

  policy.contexts[contextKey] = {
    ...ctx,
    [action]: next
  };
  updateObjectiveByTag(policy, trade, config, objectiveTag, sampleWeight);
  policy.totalUpdates = Number(policy.totalUpdates || 0) + 1;
  policy.updatedAt = new Date().toISOString();
  savePolicy(policy);
  return {
    ...next,
    objectiveTag,
    objectiveWeights
  };
}

export function resetBanditPolicy() {
  savePolicy({
    ...DEFAULT_POLICY,
    contexts: {},
    objectivesByTag: {},
    objectiveStatsByTag: {},
    updatedAt: new Date().toISOString(),
    totalUpdates: 0
  });
}

export function retrainBanditFromTrades({ trades, config, halfLife = 120 }) {
  if (!config?.rlBandit?.enabled) return { trained: 0, skipped: 0, total: 0 };
  const list = Array.isArray(trades) ? [...trades] : [];
  list.sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
  resetBanditPolicy();

  let trained = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (!(t?.banditContextKey && (t.side === "BUY" || t.side === "SELL"))) {
      skipped += 1;
      continue;
    }
    // Recency weighting by half-life in samples.
    const age = Math.max(0, list.length - 1 - i);
    const recencyWeight = Math.pow(0.5, age / Math.max(1, halfLife));
    updateBanditFromTrade({
      trade: {
        ...t,
        signalConfidence: clamp(Number(t.signalConfidence || 0.5) * (0.7 + recencyWeight * 0.6), 0, 1)
      },
      config
    });
    trained += 1;
  }
  return { trained, skipped, total: list.length };
}

export function createPolicySnapshot(label = "") {
  const policy = loadPolicy();
  const safeLabel = sanitizeLabel(label);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${safeLabel || "snapshot"}`;
  const path = resolve(SNAPSHOT_DIR, `${id}.json`);
  const payload = {
    id,
    label: safeLabel || "snapshot",
    createdAt: new Date().toISOString(),
    policy
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return { id, label: payload.label, createdAt: payload.createdAt };
}

export function listPolicySnapshots() {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
  const out = [];
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(SNAPSHOT_DIR, file), "utf8");
      const parsed = JSON.parse(raw);
      out.push({
        id: String(parsed.id || file.replace(/\.json$/, "")),
        label: String(parsed.label || ""),
        createdAt: String(parsed.createdAt || "")
      });
    } catch {
      // ignore unreadable snapshot files
    }
  }
  return out;
}

export function restorePolicySnapshot(id) {
  const safeId = sanitizeLabel(id);
  if (!safeId) return null;
  const path = resolve(SNAPSHOT_DIR, `${safeId}.json`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.policy) return null;
  savePolicy(parsed.policy);
  return {
    id: String(parsed.id || safeId),
    label: String(parsed.label || ""),
    restoredAt: new Date().toISOString()
  };
}

function buildContextKey(signal, ticker, now) {
  const regime = String(signal?.regime || "UNKNOWN");
  const spread = Number(signal?.metrics?.spreadPips ?? ticker?.spreadPips ?? 0.18);
  const ev = Number(signal?.metrics?.expectedValuePips || 0);
  const rr = Number(signal?.metrics?.rr || 1);
  const risk = Number(signal?.news?.shortTermRiskLevel || 0);
  const dominantTag = String(signal?.news?.dominantTag || "GENERAL");
  const eventVec = signal?.news?.eventFeatureVector || {};
  const highImpactRatio = Number(eventVec.highImpactRatio || 0);
  const activeRatio = Number(eventVec.activeRatio || 0);
  const surprise = Number(eventVec.avgAbsSurprise || 0);
  const h = jstHour(now);
  const session = h >= 9 && h < 15 ? "TOKYO" : (h >= 15 && h < 22 ? "LONDON" : "NY");
  return [
    `reg:${regime}`,
    `spr:${bucket(spread, [0.18, 0.3])}`,
    `ev:${bucket(ev, [0.1, 0.4])}`,
    `rr:${bucket(rr, [1.2, 1.6])}`,
    `risk:${bucket(risk, [0.3, 0.6])}`,
    `sess:${session}`,
    `tag:${dominantTag}`,
    `hir:${bucket(highImpactRatio, [0.2, 0.5])}`,
    `act:${bucket(activeRatio, [0.15, 0.4])}`,
    `surp:${bucket(surprise, [0.15, 0.4])}`
  ].join("|");
}

function scoreAction(policy, contextKey, action, explorationC = 0.22) {
  const ctx = policy.contexts[contextKey] || {};
  const a = ctx[action] || {};
  const total = Object.values(ctx).reduce((s, v) => s + Number(v?.count || 0), 0);
  const count = Number(a.count || 0);
  const reward = Number(a.ewmaReward || 0);
  const win = Number(a.ewmaWinRate ?? 0.5);
  const exploit = reward * 0.72 + (win - 0.5) * 0.48;
  const explore = explorationC * Math.sqrt(Math.log(total + 2) / (count + 1));
  return exploit + explore;
}

function contextSampleCount(policy, contextKey) {
  const ctx = policy.contexts?.[contextKey] || {};
  return Object.values(ctx).reduce((s, v) => s + Number(v?.count || 0), 0);
}

function normalizedReward(trade, objective = { profitWeight: 0.6, winWeight: 0.2, drawdownWeight: 0.12, costWeight: 0.08 }) {
  const pnl = Number(trade?.netPnlJpy || 0);
  const holdingSec = Math.max(1, Number(trade?.holdingSeconds || 1));
  const pnlScore = Math.tanh(pnl / 25000);
  const winScore = pnl > 0 ? 1 : (pnl < 0 ? -1 : 0);
  const speedBonus = pnl > 0 ? Math.min(0.12, 30 / holdingSec * 0.02) : 0;
  const peakPnlPips = Number(trade?.peakPnlPips || 0);
  const exitPnlPips = Number(trade?.exitPnlPips || 0);
  const retracePips = Math.max(0, Number(trade?.retracePips || (peakPnlPips - exitPnlPips)));
  const drawdownPenalty = clamp(retracePips / 3.5, 0, 1.3);
  const fee = Math.max(0, Number(trade?.feeJpy || 0));
  const grossAbs = Math.max(1, Math.abs(pnl) + fee);
  const costPenalty = clamp(fee / grossAbs, 0, 1.1);
  const combined = pnlScore * Number(objective.profitWeight || 0.6)
    + winScore * Number(objective.winWeight || 0.2)
    - drawdownPenalty * Number(objective.drawdownWeight || 0.12)
    - costPenalty * Number(objective.costWeight || 0.08);
  return round4(clamp(combined + speedBonus, -1.6, 1.6));
}

function computeSampleWeight(trade) {
  const conf = clamp(Number(trade?.signalConfidence || 0.5), 0, 1);
  const regime = String(trade?.regime || "");
  const pnl = Math.abs(Number(trade?.netPnlJpy || 0));
  const confWeight = 0.7 + conf * 0.7;
  const regimeWeight = regime.includes("HIGH_VOL") ? 0.85 : (regime.includes("TREND") ? 1.08 : 1.0);
  const magnitudeWeight = clamp(0.9 + pnl / 120000, 0.9, 1.8);
  const eventVec = trade?.eventFeatureSnapshot || {};
  const highImpactRatio = Number(eventVec.highImpactRatio || 0);
  const activeRatio = Number(eventVec.activeRatio || 0);
  const surprise = Number(eventVec.avgAbsSurprise || 0);
  const eventWeight = clamp(1 + highImpactRatio * 0.25 + activeRatio * 0.18 + Math.min(0.2, Math.abs(surprise) * 0.25), 0.85, 1.35);
  return round4(clamp(confWeight * regimeWeight * magnitudeWeight * eventWeight, 0.7, 2.2));
}

function jstHour(date) {
  const t = new Date(date?.getTime?.() ?? Date.now()).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).getUTCHours();
}

function bucket(v, th) {
  if (!Number.isFinite(v)) return "UNK";
  if (v < th[0]) return "LOW";
  if (v < th[1]) return "MID";
  return "HIGH";
}

function ensurePolicy() {
  if (existsSync(POLICY_PATH)) return;
  mkdirSync(dirname(POLICY_PATH), { recursive: true });
  writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2));
}

function loadPolicy(config) {
  try {
    ensurePolicy();
    const raw = readFileSync(POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizePolicyObjectives({
      ...DEFAULT_POLICY,
      ...parsed,
      contexts: typeof parsed?.contexts === "object" && parsed.contexts ? parsed.contexts : {}
    }, config);
    return {
      ...normalized
    };
  } catch {
    return normalizePolicyObjectives({ ...DEFAULT_POLICY }, config);
  }
}

function savePolicy(policy) {
  writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
}

function disabledResult() {
  return {
    enabled: false,
    contextKey: null,
    selectedAction: null,
    guardHold: false,
    reason: "disabled",
    holdScore: 0,
    actionScore: 0,
    advantage: 0,
    sizeMultiplier: 1,
    policyVersion: 1
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round4(v) {
  return Number(Number(v || 0).toFixed(4));
}

function sanitizeLabel(v) {
  return String(v || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function normalizePolicyObjectives(policy, config) {
  const tags = ["MACRO", "POLITICAL", "GEOPOLITICAL", "GENERAL"];
  const nextObjectives = {};
  const nextStats = {};
  for (const tag of tags) {
    const merged = resolveObjectiveWeights(policy, config, tag);
    nextObjectives[tag] = merged;
    const prev = policy?.objectiveStatsByTag?.[tag] || {};
    nextStats[tag] = {
      count: Number(prev.count || 0),
      ewmaWinRate: Number(prev.ewmaWinRate ?? 0.5),
      ewmaPnlScore: Number(prev.ewmaPnlScore || 0),
      updatedAt: prev.updatedAt || null
    };
  }
  return {
    ...policy,
    objectivesByTag: nextObjectives,
    objectiveStatsByTag: nextStats
  };
}

function resolveObjectiveWeights(policy, config, tag) {
  const base = config?.rlBandit?.objective || {};
  const byTagCfg = config?.rlBandit?.objectiveByTag?.[tag] || {};
  const learned = policy?.objectivesByTag?.[tag] || {};
  return normalizeWeights({
    profitWeight: Number(learned.profitWeight ?? byTagCfg.profitWeight ?? base.profitWeight ?? 0.7),
    winWeight: Number(learned.winWeight ?? byTagCfg.winWeight ?? base.winWeight ?? 0.3),
    drawdownWeight: Number(learned.drawdownWeight ?? byTagCfg.drawdownWeight ?? base.drawdownWeight ?? 0.12),
    costWeight: Number(learned.costWeight ?? byTagCfg.costWeight ?? base.costWeight ?? 0.08)
  });
}

function normalizeWeights(weights) {
  const p = clamp(Number(weights.profitWeight || 0.6), 0.2, 0.85);
  const w = clamp(Number(weights.winWeight || 0.2), 0.05, 0.55);
  const d = clamp(Number(weights.drawdownWeight || 0.12), 0.05, 0.35);
  const c = clamp(Number(weights.costWeight || 0.08), 0.03, 0.25);
  const sum = p + w + d + c;
  if (sum <= 0) return { profitWeight: 0.6, winWeight: 0.2, drawdownWeight: 0.12, costWeight: 0.08 };
  return {
    profitWeight: round4(p / sum),
    winWeight: round4(w / sum),
    drawdownWeight: round4(d / sum),
    costWeight: round4(c / sum)
  };
}

function resolveEventTag(tag) {
  const t = String(tag || "GENERAL").toUpperCase();
  if (t === "MACRO" || t === "POLITICAL" || t === "GEOPOLITICAL") return t;
  return "GENERAL";
}

function updateObjectiveByTag(policy, trade, config, tag, sampleWeight) {
  const current = resolveObjectiveWeights(policy, config, tag);
  const stat = policy.objectiveStatsByTag?.[tag] || {
    count: 0,
    ewmaWinRate: 0.5,
    ewmaPnlScore: 0,
    updatedAt: null
  };
  const alpha = clamp(Number(config?.rlBandit?.baseAlpha || 0.12) * sampleWeight * 0.8, 0.02, 0.25);
  const pnl = Number(trade?.netPnlJpy || 0);
  const pnlScore = Math.tanh(pnl / 30000);
  const win = pnl > 0 ? 1 : 0;
  const nextWinEwma = alpha * win + (1 - alpha) * Number(stat.ewmaWinRate || 0.5);
  const nextPnlEwma = alpha * pnlScore + (1 - alpha) * Number(stat.ewmaPnlScore || 0);
  const eventVec = trade?.eventFeatureSnapshot || {};
  const highImpact = clamp(Number(eventVec.highImpactRatio || 0), 0, 1);
  const active = clamp(Number(eventVec.activeRatio || 0), 0, 1);
  const retracePips = Math.max(0, Number(trade?.retracePips || 0));
  const fee = Math.max(0, Number(trade?.feeJpy || 0));
  const pnlAbs = Math.max(1, Math.abs(Number(trade?.netPnlJpy || 0)));
  const costRatio = clamp(fee / (pnlAbs + fee), 0, 1);
  const drawdownPressure = clamp(retracePips / 3.5, 0, 1.4);

  const baseProfit = Number(config?.rlBandit?.objectiveByTag?.[tag]?.profitWeight
    ?? config?.rlBandit?.objective?.profitWeight
    ?? 0.7);
  const targetProfit = clamp(
    baseProfit
      + Math.max(0, nextPnlEwma) * 0.18
      - Math.max(0, 0.52 - nextWinEwma) * 0.9
      - highImpact * 0.18
      - active * 0.08,
    0.2,
    0.85
  );
  const baseDrawdown = Number(config?.rlBandit?.objectiveByTag?.[tag]?.drawdownWeight
    ?? config?.rlBandit?.objective?.drawdownWeight
    ?? 0.12);
  const baseCost = Number(config?.rlBandit?.objectiveByTag?.[tag]?.costWeight
    ?? config?.rlBandit?.objective?.costWeight
    ?? 0.08);
  const targetDrawdown = clamp(baseDrawdown + drawdownPressure * 0.18 + highImpact * 0.08, 0.05, 0.35);
  const targetCost = clamp(baseCost + costRatio * 0.18, 0.03, 0.25);
  const targetWin = clamp(1 - targetProfit - targetDrawdown - targetCost, 0.05, 0.55);
  const mix = 0.18;
  const learned = normalizeWeights({
    profitWeight: current.profitWeight * (1 - mix) + targetProfit * mix,
    winWeight: current.winWeight * (1 - mix) + targetWin * mix,
    drawdownWeight: current.drawdownWeight * (1 - mix) + targetDrawdown * mix,
    costWeight: current.costWeight * (1 - mix) + targetCost * mix
  });

  policy.objectivesByTag = {
    ...(policy.objectivesByTag || {}),
    [tag]: {
      ...learned,
      updatedAt: new Date().toISOString()
    }
  };
  policy.objectiveStatsByTag = {
    ...(policy.objectiveStatsByTag || {}),
    [tag]: {
      count: Number(stat.count || 0) + 1,
      ewmaWinRate: round4(nextWinEwma),
      ewmaPnlScore: round4(nextPnlEwma),
      updatedAt: new Date().toISOString()
    }
  };
}
