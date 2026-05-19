function inRange(ts, from, to) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
}

function isValidClosedTrade(trade) {
  if (!trade || typeof trade !== "object") return false;
  if (trade.entryPrice !== undefined && !(Number(trade.entryPrice) > 0)) return false;
  if (trade.exitPrice !== undefined && !(Number(trade.exitPrice) > 0)) return false;
  if (trade.qty !== undefined && !(Number(trade.qty) > 0)) return false;
  if (trade.netPnlJpy !== undefined && !Number.isFinite(Number(trade.netPnlJpy))) return false;
  return true;
}

function summarize(trades) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.netPnlJpy > 0).length;
  const losses = trades.filter((t) => t.netPnlJpy < 0).length;
  const grossProfitJpy = trades.filter((t) => t.netPnlJpy > 0).reduce((s, t) => s + t.netPnlJpy, 0);
  const grossLossJpy = trades.filter((t) => t.netPnlJpy < 0).reduce((s, t) => s + t.netPnlJpy, 0);
  const netProfitJpy = grossProfitJpy + grossLossJpy;

  let peak = 0;
  let curve = 0;
  let maxDrawdownJpy = 0;
  let maxConsecutiveLosses = 0;
  let streakLosses = 0;

  for (const trade of trades) {
    curve += trade.netPnlJpy;
    peak = Math.max(peak, curve);
    maxDrawdownJpy = Math.max(maxDrawdownJpy, peak - curve);

    if (trade.netPnlJpy < 0) {
      streakLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streakLosses);
    } else {
      streakLosses = 0;
    }
  }

  const recoveryFactor = maxDrawdownJpy > 0 ? netProfitJpy / maxDrawdownJpy : null;
  const holding = trades.map((t) => Number(t.holdingSeconds || 0));
  const exposureTimeAvgSeconds = holding.length ? holding.reduce((s, v) => s + v, 0) / holding.length : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades ? wins / totalTrades : 0,
    grossProfitJpy,
    grossLossJpy,
    netProfitJpy,
    profitFactor: grossLossJpy === 0 ? null : grossProfitJpy / Math.abs(grossLossJpy),
    maxDrawdownJpy,
    maxConsecutiveLosses,
    recoveryFactor,
    exposureTimeAvgSeconds
  };
}

export function analyticsSummary(trades, fromDate, toDate) {
  const from = fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : null;
  const to = toDate ? new Date(`${toDate}T23:59:59.999Z`) : null;
  const filtered = trades
    .filter(isValidClosedTrade)
    .filter((t) => inRange(t.exitTime, from, to))
    .sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  return summarize(filtered);
}

export function analyticsByHour(trades) {
  const validTrades = (Array.isArray(trades) ? trades : []).filter(isValidClosedTrade);
  const map = new Map();
  for (let h = 0; h <= 23; h += 1) map.set(h, []);
  for (const trade of validTrades) {
    const h = new Date(trade.exitTime).getUTCHours();
    if (map.has(h)) map.get(h).push(trade);
  }
  return [...map.entries()].map(([hour, bucket]) => ({
    hour,
    trades: bucket.length,
    winRate: bucket.length ? bucket.filter((t) => t.netPnlJpy > 0).length / bucket.length : 0,
    netProfitJpy: bucket.reduce((s, t) => s + t.netPnlJpy, 0)
  }));
}

export function analyticsByWeekday(trades) {
  const validTrades = (Array.isArray(trades) ? trades : []).filter(isValidClosedTrade);
  const map = new Map();
  for (let d = 0; d <= 6; d += 1) map.set(d, []);
  for (const trade of validTrades) {
    const d = new Date(trade.exitTime).getUTCDay();
    if (map.has(d)) map.get(d).push(trade);
  }
  return [...map.entries()].map(([weekday, bucket]) => ({
    weekday,
    trades: bucket.length,
    winRate: bucket.length ? bucket.filter((t) => t.netPnlJpy > 0).length / bucket.length : 0,
    netProfitJpy: bucket.reduce((s, t) => s + t.netPnlJpy, 0)
  }));
}

export function analyticsAssistantImpact(trades) {
  const validTrades = (Array.isArray(trades) ? trades : []).filter(isValidClosedTrade);
  const adopted = validTrades.filter((t) => t.assistantAdopted);
  const notAdopted = validTrades.filter((t) => !t.assistantAdopted);
  const one = (bucket) => ({
    trades: bucket.length,
    winRate: bucket.length ? bucket.filter((t) => t.netPnlJpy > 0).length / bucket.length : 0,
    netProfitJpy: bucket.reduce((s, t) => s + t.netPnlJpy, 0)
  });
  return {
    adopted: one(adopted),
    notAdopted: one(notAdopted)
  };
}

export function analyticsEventImpact(trades, options = {}) {
  const minTrades = Math.max(1, Number(options.minTrades || 3));
  const byEventId = new Map();
  const byTag = new Map();

  for (const t of (Array.isArray(trades) ? trades : []).filter(isValidClosedTrade)) {
    const pnl = Number(t.netPnlJpy || 0);
    const eventIds = Array.isArray(t.linkedEventIds) ? t.linkedEventIds : [];
    const tag = String(t.eventDominantTag || "GENERAL");

    if (eventIds.length) {
      for (const eventId of eventIds) {
        const k = String(eventId);
        if (!k) continue;
        if (!byEventId.has(k)) byEventId.set(k, []);
        byEventId.get(k).push(t);
      }
    }

    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ ...t, netPnlJpy: pnl });
  }

  const eventItems = [...byEventId.entries()]
    .map(([eventId, bucket]) => ({
      eventId,
      ...summarize(bucket)
    }))
    .filter((x) => x.totalTrades >= minTrades)
    .sort((a, b) => b.netProfitJpy - a.netProfitJpy);

  const tagItems = [...byTag.entries()]
    .map(([tag, bucket]) => ({
      tag,
      ...summarize(bucket)
    }))
    .filter((x) => x.totalTrades >= minTrades)
    .sort((a, b) => b.netProfitJpy - a.netProfitJpy);

  return {
    eventItems,
    tagItems,
    totals: {
      trackedEvents: byEventId.size,
      trackedTags: byTag.size
    }
  };
}

export function analyticsValidationReport200(trades, benchmark = {}) {
  const required = Math.max(1, Number(benchmark.minTrades || 200));
  const sorted = [...trades].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  const recent = sorted.slice(-required);
  if (recent.length < required) {
    return {
      ok: false,
      requirement: required,
      available: recent.length,
      message: `${required}トレード未満のため評価不可`
    };
  }

  const summary = summarize(recent);
  const eventImpact = analyticsEventImpact(recent, { minTrades: 5 });
  const checks = {
    winRate: Number(summary.winRate || 0) >= Number(benchmark.winRateMin || 0.5),
    profitFactor: Number(summary.profitFactor || 0) >= Number(benchmark.profitFactorMin || 1.2),
    maxDrawdown: Number(summary.maxDrawdownJpy || 0) <= Number(benchmark.maxDrawdownJpyMax || 120000),
    netProfit: Number(summary.netProfitJpy || 0) >= Number(benchmark.netProfitJpyMin || 0)
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    ok: true,
    pass,
    evaluatedTrades: required,
    summary,
    checks,
    topEventTags: eventImpact.tagItems.slice(0, 6),
    topEventIds: eventImpact.eventItems.slice(0, 10)
  };
}

export function analyticsGatePerformance(trades, auditLogs = [], options = {}) {
  const limit = Math.max(100, Number(options.limit || 3000));
  const logs = [...(Array.isArray(auditLogs) ? auditLogs : [])]
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-limit);
  const allTrades = Array.isArray(trades) ? trades : [];
  const tradeBySignalId = new Map(
    allTrades
      .filter((t) => t?.signalId)
      .map((t) => [String(t.signalId), t])
  );

  const skipBlocks = logs.filter((l) => l?.event === "auto.skip");
  const gateSkipKeys = [
    "ensemble gate",
    "context validation",
    "pre-trade guard",
    "pattern quality",
    "bandit guard hold",
    "no actionable signal"
  ];
  const blockedByKey = Object.fromEntries(gateSkipKeys.map((k) => [k, 0]));
  for (const row of skipBlocks) {
    const reason = String(row?.reason || "");
    if (reason in blockedByKey) blockedByKey[reason] += 1;
  }

  const degradationBlocks = logs.filter((l) => l?.event === "auto.degradation.block").length;
  const killStops = logs.filter((l) => l?.event === "auto.killswitch.stop").length;
  const opened = logs.filter((l) => l?.event === "auto.position.opened");

  const openedTrades = opened
    .map((o) => tradeBySignalId.get(String(o?.signalId || "")))
    .filter(Boolean);
  const openedSummary = summarize(openedTrades);
  const opportunities = opened.length + skipBlocks.length + degradationBlocks + killStops;
  const passRate = opportunities > 0 ? opened.length / opportunities : 0;
  const alerts = [];
  if (opportunities >= 50 && passRate < 0.05) {
    alerts.push("entry pass rate is too low (<5%); likely over-filtering");
  }
  const openedExpectancy = openedSummary.totalTrades > 0
    ? Number((openedSummary.netProfitJpy / openedSummary.totalTrades).toFixed(2))
    : 0;
  if (openedSummary.totalTrades >= 50 && openedExpectancy <= 0) {
    alerts.push("opened-trade expectancy is non-positive; gate stack may not add edge");
  }
  if (blockedByKey["pre-trade guard"] > opened.length * 1.5 && opened.length >= 20) {
    alerts.push("pre-trade guard blocks dominate; threshold may be too strict");
  }

  return {
    opportunities,
    opened: opened.length,
    blocked: {
      ...blockedByKey,
      degradation: degradationBlocks,
      killSwitch: killStops
    },
    passRate,
    alerts,
    openedPerformance: {
      trades: openedSummary.totalTrades,
      winRate: openedSummary.winRate,
      profitFactor: openedSummary.profitFactor,
      netProfitJpy: openedSummary.netProfitJpy,
      maxDrawdownJpy: openedSummary.maxDrawdownJpy,
      expectancyJpy: openedExpectancy
    }
  };
}
