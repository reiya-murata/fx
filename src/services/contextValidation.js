function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseKey(key = "") {
  const out = {};
  for (const part of String(key).split("|")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

function coarseKeyFromContext(contextKey = "") {
  const p = parseKey(contextKey);
  return [
    `reg:${p.reg || "UNKNOWN"}`,
    `sess:${p.sess || "UNK"}`,
    `tag:${p.tag || "GENERAL"}`
  ].join("|");
}

function collectCounts(rows = [], bootstrapContextCounts = null) {
  const exact = new Map();
  const coarse = new Map();
  for (const t of rows) {
    const ctx = String(t?.banditContextKey || "");
    if (!ctx) continue;
    exact.set(ctx, (exact.get(ctx) || 0) + 1);
    const c = coarseKeyFromContext(ctx);
    coarse.set(c, (coarse.get(c) || 0) + 1);
  }
  if (bootstrapContextCounts && typeof bootstrapContextCounts === "object") {
    for (const [ctx, rawCount] of Object.entries(bootstrapContextCounts)) {
      const c = Math.max(0, Number(rawCount || 0));
      if (!(c > 0)) continue;
      exact.set(ctx, (exact.get(ctx) || 0) + c);
      const ck = coarseKeyFromContext(ctx);
      coarse.set(ck, (coarse.get(ck) || 0) + c);
    }
  }
  return { exact, coarse };
}

export function evaluateContextValidation({
  contextKey,
  signal,
  ticker,
  selectedRiskPercent,
  liveTrades,
  shadowTrades,
  bootstrapContextCounts,
  cfg = {}
}) {
  if (!cfg?.enabled) {
    return {
      enabled: false,
      allowed: true,
      mode: "LIVE",
      sizeMultiplier: 1,
      reason: "context validation disabled"
    };
  }
  const key = String(contextKey || "");
  if (!key) {
    return {
      enabled: true,
      allowed: false,
      mode: "VALIDATION_ONLY",
      sizeMultiplier: 0,
      reason: "context key missing"
    };
  }

  const rows = [...(Array.isArray(liveTrades) ? liveTrades : []), ...(Array.isArray(shadowTrades) ? shadowTrades : [])];
  const counts = collectCounts(rows, bootstrapContextCounts);
  const exactCount = Number(counts.exact.get(key) || 0);
  const cKey = coarseKeyFromContext(key);
  const coarseCount = Number(counts.coarse.get(cKey) || 0);
  const minExact = Math.max(1, toNum(cfg.minTradesPerContext, 20));
  const minCoarse = Math.max(minExact, toNum(cfg.minTradesPerCoarseContext, 40));

  if (exactCount >= minExact || coarseCount >= minCoarse) {
    return {
      enabled: true,
      allowed: true,
      validated: true,
      mode: "LIVE",
      sizeMultiplier: 1,
      exactCount,
      coarseCount,
      contextKey: key,
      coarseKey: cKey,
      reason: "context validated"
    };
  }

  const bootstrapAllowed = evaluateBootstrapAllowance(signal, ticker, cfg);
  if (bootstrapAllowed.allowed) {
    const dynamicBootstrapMultiplier = computeBootstrapSizeMultiplier(selectedRiskPercent, cfg);
    return {
      enabled: true,
      allowed: true,
      validated: false,
      mode: "LIVE_LIMITED",
      sizeMultiplier: dynamicBootstrapMultiplier,
      selectedRiskPercent: toNum(selectedRiskPercent, 1),
      exactCount,
      coarseCount,
      contextKey: key,
      coarseKey: cKey,
      reason: bootstrapAllowed.reason
    };
  }

  return {
    enabled: true,
    allowed: false,
    validated: false,
    mode: "VALIDATION_ONLY",
    sizeMultiplier: 0,
    exactCount,
    coarseCount,
    contextKey: key,
    coarseKey: cKey,
    reason: "unvalidated context"
  };
}

function evaluateBootstrapAllowance(signal, ticker, cfg) {
  if (!cfg?.allowBootstrapContexts) return { allowed: false, reason: "bootstrap disabled" };
  const regime = String(signal?.regime || "");
  const allowRegimes = Array.isArray(cfg.bootstrapRegimes) ? cfg.bootstrapRegimes.map(String) : [];
  if (!allowRegimes.includes(regime)) return { allowed: false, reason: "bootstrap regime blocked" };
  const newsRisk = toNum(signal?.news?.shortTermRiskLevel, 0);
  if (newsRisk > toNum(cfg.maxNewsRiskForBootstrap, 0.35)) {
    return { allowed: false, reason: "bootstrap blocked by news risk" };
  }
  const spread = toNum(signal?.metrics?.spreadPips, toNum(ticker?.spreadPips, 0.2));
  if (spread > toNum(cfg.maxSpreadPipsForBootstrap, 0.28)) {
    return { allowed: false, reason: "bootstrap blocked by spread" };
  }
  return { allowed: true, reason: "bootstrap context allowed with limited size" };
}

function computeBootstrapSizeMultiplier(selectedRiskPercent, cfg) {
  const selected = Math.max(0.1, toNum(selectedRiskPercent, 1));
  const cap = resolveBootstrapCap(selected, cfg);
  const ref = Math.max(0.1, toNum(cfg.bootstrapRiskReferencePercent, 5));
  const min = Math.max(0.02, toNum(cfg.bootstrapMinSizeMultiplier, 0.12));
  const scaled = cap * (selected / ref);
  return Number(Math.max(min, Math.min(cap, scaled)).toFixed(4));
}

function resolveBootstrapCap(selectedRiskPercent, cfg) {
  const tiers = Array.isArray(cfg.bootstrapCapByRiskPercent) ? cfg.bootstrapCapByRiskPercent : [];
  const selected = Math.max(0.1, toNum(selectedRiskPercent, 1));
  if (!tiers.length) {
    return Math.max(0.05, toNum(cfg.bootstrapSizeMultiplier, 0.5));
  }
  const sorted = [...tiers]
    .map((t) => ({
      maxRiskPercent: Math.max(0.1, toNum(t?.maxRiskPercent, 100)),
      cap: Math.max(0.02, toNum(t?.cap, toNum(cfg.bootstrapSizeMultiplier, 0.5)))
    }))
    .sort((a, b) => a.maxRiskPercent - b.maxRiskPercent);
  for (const t of sorted) {
    if (selected <= t.maxRiskPercent) return t.cap;
  }
  return sorted[sorted.length - 1].cap;
}
