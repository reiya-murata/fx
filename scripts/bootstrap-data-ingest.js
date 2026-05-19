import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchUsdJpyHistory } from "../src/market/history.js";
import { buildAssistantDecision } from "../src/engine/assistant.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { collectNewsOnce, parseFeedList } from "../src/services/newsCollector.js";
import { loadState, saveState } from "../src/data/store.js";

function aggregateBy(candles, groupSize) {
  const out = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const chunk = candles.slice(i, i + groupSize);
    if (!chunk.length) continue;
    out.push({
      open: Number(chunk[0].open),
      high: Math.max(...chunk.map((c) => Number(c.high))),
      low: Math.min(...chunk.map((c) => Number(c.low))),
      close: Number(chunk[chunk.length - 1].close),
      ts: chunk[chunk.length - 1].ts
    });
  }
  return out;
}

function bucket(v, th) {
  if (!Number.isFinite(v)) return "UNK";
  if (v < th[0]) return "LOW";
  if (v < th[1]) return "MID";
  return "HIGH";
}

function jstHour(isoTs) {
  const t = new Date(isoTs || Date.now()).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).getUTCHours();
}

function sessionFromTs(isoTs) {
  const h = jstHour(isoTs);
  if (h >= 9 && h < 15) return "TOKYO";
  if (h >= 15 && h < 22) return "LONDON";
  return "NY";
}

function buildContextKeyFromDecision(decision, ts, spreadPips) {
  const m = decision?.metrics || {};
  const news = decision?.news || {};
  const vec = news.eventFeatureVector || {};
  return [
    `reg:${String(decision?.regime || "UNKNOWN")}`,
    `spr:${bucket(Number(spreadPips || m.spreadPips || 0.18), [0.18, 0.3])}`,
    `ev:${bucket(Number(m.expectedValuePips || 0), [0.1, 0.4])}`,
    `rr:${bucket(Number(m.rr || 1), [1.2, 1.6])}`,
    `risk:${bucket(Number(news.shortTermRiskLevel || 0), [0.3, 0.6])}`,
    `sess:${sessionFromTs(ts)}`,
    `tag:${String(news.dominantTag || "GENERAL")}`,
    `hir:${bucket(Number(vec.highImpactRatio || 0), [0.2, 0.5])}`,
    `act:${bucket(Number(vec.activeRatio || 0), [0.15, 0.4])}`,
    `surp:${bucket(Number(vec.avgAbsSurprise || 0), [0.15, 0.4])}`
  ].join("|");
}

function corr(xs, ys) {
  if (xs.length !== ys.length || xs.length < 30) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

async function main() {
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  const mergeNews = process.argv.includes("--merge-news");
  const maxContexts = Math.max(200, Number(process.env.BOOTSTRAP_MAX_CONTEXTS || 3000));
  const spreadPips = Math.max(0.05, Number(process.env.BOOTSTRAP_SPREAD_PIPS || 0.18));
  const newsFeeds = parseFeedList(process.env.NEWS_FEED_URLS || "");

  const [candles1m, candles15m, candles1h, candles1d, newsResult] = await Promise.all([
    fetchUsdJpyHistory("1m", "7d"),
    fetchUsdJpyHistory("15m", "60d"),
    fetchUsdJpyHistory("1h", "730d"),
    fetchUsdJpyHistory("1d", "10y"),
    collectNewsOnce({ feeds: newsFeeds })
  ]);

  const contextCounts = new Map();
  const featureRows = [];
  for (let i = 180; i < candles1m.length - 5; i += 1) {
    const c1 = candles1m.slice(i - 180, i);
    const c5 = aggregateBy(c1, 5).slice(-180);
    const c15 = aggregateBy(c1, 15).slice(-180);
    const last = c1[c1.length - 1];
    const mid = Number(last.close);
    const spread = spreadPips * DEFAULT_CONFIG.pipSize;
    const bid = Number((mid - spread / 2).toFixed(3));
    const ask = Number((mid + spread / 2).toFixed(3));
    const decision = buildAssistantDecision({
      bid,
      ask,
      spreadPips,
      candles1m: c1,
      candles5m: c5,
      candles15m: c15,
      account: {
        currentBalanceJpy: 1000000,
        dayPnlJpy: 0,
        weekDrawdownJpy: 0,
        consecutiveLosses: 0
      },
      trades: [],
      newsEvents: [],
      enableSelfLearning: false,
      enableWalkForward: false,
      enableNewsFilter: false
    }, DEFAULT_CONFIG);
    if (!(decision?.action === "BUY" || decision?.action === "SELL")) continue;
    const key = buildContextKeyFromDecision(decision, last.ts, spreadPips);
    contextCounts.set(key, (contextCounts.get(key) || 0) + 1);

    const next = candles1m[i + 5];
    if (next) {
      const futureRetPips = Number(((Number(next.close) - mid) / DEFAULT_CONFIG.pipSize).toFixed(4));
      featureRows.push({
        ev: Number(decision?.metrics?.expectedValuePips || 0),
        rr: Number(decision?.metrics?.rr || 1),
        mom: Number(decision?.marketFeatures?.momentumScore || 0),
        conf: Number(decision?.confidence || 0),
        ret: futureRetPips
      });
    }
  }

  const topContexts = [...contextCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxContexts);
  const contextPayload = Object.fromEntries(topContexts);
  const xsEv = featureRows.map((r) => r.ev);
  const xsRr = featureRows.map((r) => r.rr);
  const xsMom = featureRows.map((r) => r.mom);
  const xsConf = featureRows.map((r) => r.conf);
  const ys = featureRows.map((r) => r.ret);
  const featureStats = {
    samples: featureRows.length,
    corr_ev_futureRet: corr(xsEv, ys),
    corr_rr_futureRet: corr(xsRr, ys),
    corr_mom_futureRet: corr(xsMom, ys),
    corr_conf_futureRet: corr(xsConf, ys)
  };

  const marketDataset = {
    generatedAt: new Date().toISOString(),
    symbol: "USDJPY",
    candles: {
      "1m": candles1m,
      "15m": candles15m,
      "1h": candles1h,
      "1d": candles1d
    },
    news: newsResult.items,
    featureStats
  };

  writeFileSync(resolve(process.cwd(), "data/bootstrap_market_dataset.json"), JSON.stringify(marketDataset));
  writeFileSync(resolve(process.cwd(), "data/bootstrap_context_samples.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    symbol: "USDJPY",
    sampleCount: topContexts.reduce((s, [, c]) => s + c, 0),
    distinctContexts: topContexts.length,
    contextCounts: contextPayload,
    featureStats
  }, null, 2));

  if (mergeNews && Array.isArray(newsResult.items) && newsResult.items.length) {
    const state = loadState();
    const dedupe = new Set((state.newsEvents || []).map((n) => `${String(n.headline || "").toLowerCase()}|${n.eventTime || n.ts}`));
    const merged = [...(state.newsEvents || [])];
    let inserted = 0;
    for (const item of newsResult.items) {
      const k = `${String(item.headline || "").toLowerCase()}|${item.eventTime || item.ts}`;
      if (dedupe.has(k)) continue;
      dedupe.add(k);
      merged.push(item);
      inserted += 1;
    }
    saveState({
      ...state,
      newsEvents: merged.slice(-2000)
    });
    console.log(JSON.stringify({ ok: true, insertedNews: inserted, totalNews: merged.length, contexts: topContexts.length }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    files: [
      "data/bootstrap_market_dataset.json",
      "data/bootstrap_context_samples.json"
    ],
    candles: {
      "1m": candles1m.length,
      "15m": candles15m.length,
      "1h": candles1h.length,
      "1d": candles1d.length
    },
    news: newsResult.items.length,
    contexts: topContexts.length
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: String(error?.message || error) }, null, 2));
  process.exit(1);
});
