import { LiveWsFeed } from "./liveFeed.js";
import { fetchUsdJpyHistory } from "./history.js";

const MARKET_TZ_OFFSET_MIN = Number(process.env.MARKET_TZ_OFFSET_MIN || 540);
const MARKET_BASE_SPREAD_PIPS = (() => {
  const n = Number(process.env.MARKET_FALLBACK_SPREAD_PIPS || 0.18);
  if (!Number.isFinite(n)) return 0.18;
  return Math.max(0.01, n);
})();
const MARKET_HTTP_POLL_MS = Math.max(500, Number(process.env.MARKET_HTTP_POLL_MS || 1000));
const MARKET_HTTP_REFRESH_SEC = Math.max(1, Number(process.env.MARKET_HTTP_REFRESH_SEC || 1));
const MARKET_HTTP_TICKER_URL = String(process.env.MARKET_HTTP_TICKER_URL || "").trim();
const MARKET_HTTP_TICKER_URLS = String(process.env.MARKET_HTTP_TICKER_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MARKET_HTTP_PROVIDER = String(process.env.MARKET_HTTP_PROVIDER || "GMO_FX").trim().toUpperCase();
const MARKET_HTTP_SYMBOL = String(process.env.MARKET_HTTP_SYMBOL || "USD_JPY").trim();
const MARKET_HTTP_PROVIDER_LABEL = MARKET_HTTP_PROVIDER || (MARKET_HTTP_TICKER_URL || MARKET_HTTP_TICKER_URLS.length ? "CUSTOM_HTTP_TICKER" : "GMO_FX");
const MARKET_GMO_PUBLIC_BASE_URL = String(process.env.MARKET_GMO_PUBLIC_BASE_URL || "https://forex-api.coin.z.com").trim();
const MARKET_HTTP_TIMEOUT_MS = Math.max(1000, Number(process.env.MARKET_HTTP_TIMEOUT_MS || 4000));
const MARKET_HTTP_HEADERS = parseJsonObject(process.env.MARKET_HTTP_HEADERS_JSON || "");
const MARKET_HTTP_BID_KEY = String(process.env.MARKET_HTTP_BID_KEY || "").trim();
const MARKET_HTTP_ASK_KEY = String(process.env.MARKET_HTTP_ASK_KEY || "").trim();
const MARKET_HTTP_MID_KEY = String(process.env.MARKET_HTTP_MID_KEY || "").trim();
const MARKET_HTTP_SPREAD_KEY = String(process.env.MARKET_HTTP_SPREAD_KEY || "").trim();
const MARKET_HTTP_SYMBOL_KEY = String(process.env.MARKET_HTTP_SYMBOL_KEY || "").trim();
const MARKET_HTTP_TIME_KEY = String(process.env.MARKET_HTTP_TIME_KEY || "").trim();
const PAPER_LIVE_MODE = String(process.env.PAPER_LIVE || "0") === "1";
const MARKET_ALLOW_HISTORY_POLL_TRADING = String(process.env.MARKET_ALLOW_HISTORY_POLL_TRADING || "1") === "1";
const MARKET_HISTORY_POLL_REALTIME_GRACE_MS = Math.max(
  5000,
  Number(process.env.MARKET_HISTORY_POLL_REALTIME_GRACE_MS || MARKET_HTTP_REFRESH_SEC * 3000)
);
const MARKET_HTTP_TICK_STALE_MS = Number(process.env.MARKET_HTTP_TICK_STALE_MS)
  ? Math.max(3000, Number(process.env.MARKET_HTTP_TICK_STALE_MS))
  : Math.max(10000, MARKET_HTTP_REFRESH_SEC * 5000 + 3000);
const MARKET_HISTORY_REFRESH_MS = Math.max(
  10000,
  Number(process.env.MARKET_HISTORY_REFRESH_MS || 30000)
);
const HAS_HTTP_TICK_PROVIDER = Boolean(
  MARKET_HTTP_TICKER_URL
  || MARKET_HTTP_TICKER_URLS.length
  || MARKET_HTTP_PROVIDER === "GMO_FX"
);

function toCandle(price, bucketMs = Date.now()) {
  return {
    open: price,
    high: price,
    low: price,
    close: price,
    ts: new Date(bucketMs).toISOString()
  };
}

function floorToBucketMs(ms, bucketMinutes) {
  const bucketMs = Math.max(1, Number(bucketMinutes)) * 60 * 1000;
  const offsetMs = MARKET_TZ_OFFSET_MIN * 60 * 1000;
  return Math.floor((ms + offsetMs) / bucketMs) * bucketMs - offsetMs;
}

function aggregateByMinutes(candles, minutes) {
  const sorted = [...candles].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const out = [];
  let current = null;
  let currentBucket = null;

  for (const c of sorted) {
    const tsMs = new Date(c.ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    const bucket = floorToBucketMs(tsMs, minutes);
    if (!current || bucket !== currentBucket) {
      if (current) out.push(current);
      currentBucket = bucket;
      current = {
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        ts: new Date(bucket).toISOString()
      };
      continue;
    }

    current.high = Math.max(Number(current.high), Number(c.high));
    current.low = Math.min(Number(current.low), Number(c.low));
    current.close = Number(c.close);
  }
  if (current) out.push(current);
  return out;
}

function normalizeCandleForBucket(c, minutes = 1) {
  if (!c || typeof c !== "object") return null;
  const tsMs = new Date(c.ts).getTime();
  const open = Number(c.open);
  const high = Number(c.high);
  const low = Number(c.low);
  const close = Number(c.close);
  if (!Number.isFinite(tsMs)) return null;
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  const safeHigh = Math.max(open, high, low, close);
  const safeLow = Math.min(open, high, low, close);
  const bucketMs = floorToBucketMs(tsMs, minutes);
  return {
    open,
    high: safeHigh,
    low: safeLow,
    close,
    ts: new Date(bucketMs).toISOString()
  };
}

function uniqByTs(candles, minutes = 1) {
  const map = new Map();
  for (const raw of candles) {
    const c = normalizeCandleForBucket(raw, minutes);
    if (!c || !c.ts) continue;
    const prev = map.get(c.ts);
    if (!prev) {
      map.set(c.ts, c);
      continue;
    }
    map.set(c.ts, {
      open: Number(prev.open),
      high: Math.max(Number(prev.high), Number(c.high)),
      low: Math.min(Number(prev.low), Number(c.low)),
      close: Number(c.close),
      ts: c.ts
    });
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

export class MarketHub {
  constructor({ wsUrl = "", wsSubscribeMessage = "" } = {}) {
    this.mode = "live";
    this.lastTick = {
      symbol: "USDJPY",
      bid: 0,
      ask: 0,
      spreadPips: MARKET_BASE_SPREAD_PIPS,
      orderBookImbalance: 0,
      ts: new Date().toISOString()
    };
    this.lastTickMs = Date.now();
    this.historyReady = false;
    this.historyCandles = {
      "1m": [],
      "5m": [],
      "10m": [],
      "15m": [],
      "1h": [],
      "1d": []
    };
    this.candles1m = [];
    this.current1mBucketMs = floorToBucketMs(Date.now(), 1);
    this.current1m = toCandle((this.lastTick.bid + this.lastTick.ask) / 2, this.current1mBucketMs);
    this.feed = new LiveWsFeed({
      url: wsUrl,
      subscribeMessage: wsSubscribeMessage || null
    });
    this.feedState = {
      state: "connecting",
      reason: null,
      updatedAt: new Date().toISOString()
    };
    this.fallbackTimer = null;
    this.fallbackActive = false;
    this.fallbackSource = "DISCONNECTED";
    this.lastHttpRefreshMs = 0;
    this.isHttpRefreshing = false;
    this.syntheticSeed = 1;
    this.lastSyntheticMid = 0;
    this.lastBridgeError = null;
    this.lastHttpAnchorCandleTsMs = 0;
    this.lastHttpAnchorMid = 0;
    this.lastHistoryRefreshMs = 0;
    this.isHistoryRefreshing = false;
  }

  start() {
    this.bootstrapHistory().catch(() => {});
    this.startFallbackTicker(); // P0-1: always-on fallback path for no-WS environments.
    this.feed.start({
      onTick: (tick) => this.consumeTick(tick),
      onStatus: (status) => {
        this.feedState = {
          state: String(status?.state || "unknown"),
          reason: status?.reason || status?.message || null,
          updatedAt: new Date().toISOString()
        };
        this.updateFallbackState();
      }
    });
  }

  stop() {
    this.feed.stop();
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  step() {
    return this.lastTick;
  }

  consumeTick(tick) {
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    // Validate tick: bid and ask must be positive and ask > bid
    if (!(bid > 0) || !(ask > 0) || !(ask > bid)) {
      return;
    }
    this.lastTick = {
      symbol: "USDJPY",
      bid,
      ask,
      spreadPips: Number(tick.spreadPips),
      orderBookImbalance: Number(tick.orderBookImbalance || 0),
      ts: tick.ts || new Date().toISOString()
    };
    this.lastTickMs = Date.now();

    const mid = (this.lastTick.bid + this.lastTick.ask) / 2;
    const tickMsRaw = new Date(this.lastTick.ts).getTime();
    const tickMs = Number.isFinite(tickMsRaw) ? tickMsRaw : Date.now();
    const bucketMs = floorToBucketMs(tickMs, 1);

    if (!this.current1m || !Number.isFinite(this.current1mBucketMs)) {
      this.current1mBucketMs = bucketMs;
      this.current1m = toCandle(mid, bucketMs);
      return;
    }

    if (bucketMs !== this.current1mBucketMs) {
      this.candles1m.push({ ...this.current1m, ts: new Date(this.current1mBucketMs).toISOString() });
      this.candles1m = this.candles1m.slice(-12000);
      this.current1mBucketMs = bucketMs;
      this.current1m = toCandle(mid, bucketMs);
      return;
    }

    this.current1m.high = Math.max(this.current1m.high, mid);
    this.current1m.low = Math.min(this.current1m.low, mid);
    this.current1m.close = mid;
    this.current1m.ts = new Date(this.current1mBucketMs).toISOString();
  }

  getTicker() {
    return this.lastTick;
  }

  getMarketStatus(now = new Date()) {
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const staleMs = Math.max(0, nowMs - Number(this.lastTickMs || 0));
    const fxOpen = PAPER_LIVE_MODE ? true : isFxMarketOpen(nowMs);
    const wsOpen = this.feedState.state === "open";
    const staleLimitMs = this.fallbackSource === "LIVE_HTTP_GMO" || this.fallbackSource === "LIVE_HTTP_SBI" || this.fallbackSource === "LIVE_HTTP_BRIDGE"
      ? MARKET_HTTP_TICK_STALE_MS
      : 3000;
    const stale = staleMs > staleLimitMs;
    const httpPollHistoryOnly = this.fallbackActive && this.fallbackSource === "LIVE_HTTP_POLL";
    const httpAnchorAgeMs = this.lastHttpAnchorCandleTsMs
      ? Math.max(0, nowMs - Number(this.lastHttpAnchorCandleTsMs || 0))
      : Infinity;
    const httpPollCandleCloseRealtime = httpPollHistoryOnly
      && MARKET_ALLOW_HISTORY_POLL_TRADING
      && Number.isFinite(httpAnchorAgeMs)
      && httpAnchorAgeMs <= MARKET_HISTORY_POLL_REALTIME_GRACE_MS;
    const hasValidTickData = this.lastTick && this.lastTick.bid > 0 && this.lastTick.ask > 0 && this.lastTick.ask > this.lastTick.bid;
    const fallbackRealtime = this.fallbackActive && !stale && !httpPollHistoryOnly && hasValidTickData;
    const realtime = (wsOpen && !stale && hasValidTickData) || fallbackRealtime || httpPollCandleCloseRealtime;
    let source = "LIVE_DISCONNECTED";
    if (wsOpen) {
      source = stale ? "LIVE_STALE" : "LIVE_WS";
    } else if (fallbackRealtime) {
      source = this.fallbackSource;
    } else if (httpPollCandleCloseRealtime) {
      source = "LIVE_HTTP_CANDLE_CLOSE";
    } else if (httpPollHistoryOnly) {
      source = "LIVE_HTTP_POLL";
    }
    return {
      mode: this.mode,
      source,
      fxOpen,
      realtime,
      wsState: this.feedState.state,
      wsReason: this.feedState.reason,
      inputMode: wsOpen ? "WS" : (this.fallbackActive ? "HTTP_POLL" : "DISCONNECTED"),
      bridgeConfigured: HAS_HTTP_TICK_PROVIDER,
      bridgeSource: HAS_HTTP_TICK_PROVIDER ? MARKET_HTTP_PROVIDER_LABEL : null,
      httpProvider: MARKET_HTTP_PROVIDER || null,
      httpSymbol: MARKET_HTTP_SYMBOL,
      bridgeError: this.lastBridgeError,
      paperLiveMode: PAPER_LIVE_MODE,
      historyOnlyPoll: httpPollHistoryOnly,
      candleCloseTradingAllowed: httpPollCandleCloseRealtime,
      historyPollTradingEnabled: MARKET_ALLOW_HISTORY_POLL_TRADING,
      historyReady: this.historyReady,
      history1mCount: (this.historyCandles["1m"] || []).length,
      live1mCount: (this.candles1m || []).length + (Number.isFinite(this.current1m?.open) ? 1 : 0),
      lastHistoryRefreshAt: this.lastHistoryRefreshMs ? new Date(this.lastHistoryRefreshMs).toISOString() : null,
      httpAnchorAgeMs: Number.isFinite(httpAnchorAgeMs) ? httpAnchorAgeMs : null,
      historyPollRealtimeGraceMs: MARKET_HISTORY_POLL_REALTIME_GRACE_MS,
      httpTickStaleMs: staleLimitMs,
      realtimeBlockedReason: realtime
        ? null
        : (!hasValidTickData && this.fallbackActive && !httpPollHistoryOnly
          ? "Tick data invalid or missing (bid/ask values)"
          : (httpPollHistoryOnly
          ? (MARKET_ALLOW_HISTORY_POLL_TRADING
            ? "HTTP history polling is candle-close only and the latest candle is outside the realtime grace window; configure MARKET_HTTP_TICKER_URL or MARKET_HTTP_TICKER_URLS for realtime SBI/GMO/custom tick trading"
            : "HTTP history polling is candle-close only; set MARKET_ALLOW_HISTORY_POLL_TRADING=1 for PAPER_LIVE candle-close trading, or configure MARKET_HTTP_TICKER_URL / MARKET_HTTP_TICKER_URLS for realtime tick trading")
          : "Realtime tick source is not connected")),
      lastHttpAnchorCandleAt: this.lastHttpAnchorCandleTsMs ? new Date(this.lastHttpAnchorCandleTsMs).toISOString() : null,
      lastTickAt: this.lastTick?.ts || null,
      staleMs
    };
  }

  getCandles(tf = "1m", limit = 120) {
    const safeLimit = Math.max(10, Math.min(Number(limit) || 120, 12000));
    const hasCurrent = Number.isFinite(this.current1m?.open);
    const live1m = hasCurrent ? [...this.candles1m, { ...this.current1m }] : this.candles1m;
    const base1m = uniqByTs([...(this.historyCandles["1m"] || []), ...live1m], 1);
    if (tf === "1m") return base1m.slice(-safeLimit);
    if (tf === "5m") return aggregateByMinutes(base1m, 5).slice(-safeLimit);
    if (tf === "10m") return aggregateByMinutes(base1m, 10).slice(-safeLimit);
    if (tf === "15m") {
      const merged = uniqByTs([
        ...(this.historyCandles["15m"] || []),
        ...aggregateByMinutes(base1m, 15)
      ], 15);
      return merged.slice(-safeLimit);
    }
    if (tf === "1h") {
      const merged = uniqByTs([
        ...(this.historyCandles["1h"] || []),
        ...aggregateByMinutes(base1m, 60)
      ], 60);
      return merged.slice(-safeLimit);
    }
    if (tf === "1d") {
      const merged = uniqByTs([
        ...(this.historyCandles["1d"] || []),
        ...aggregateByMinutes(base1m, 1440)
      ], 1440);
      return merged.slice(-safeLimit);
    }
    return base1m.slice(-safeLimit);
  }

  getDecisionCandles() {
    return {
      candles1m: this.getCandles("1m", 180),
      candles5m: this.getCandles("5m", 180),
      candles10m: this.getCandles("10m", 180),
      candles15m: this.getCandles("15m", 180)
    };
  }

  async bootstrapHistory() {
    if (this.historyReady) return;
    const tfs = ["1m", "5m", "10m", "15m", "1h", "1d"];
    const results = await Promise.allSettled(tfs.map((tf) => fetchUsdJpyHistory(tf, "auto")));
    for (let i = 0; i < tfs.length; i += 1) {
      const tf = tfs[i];
      const r = results[i];
      if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length > 0) {
        const bucketMinutes = tf === "1m" ? 1 : tf === "5m" ? 5 : tf === "10m" ? 10 : tf === "15m" ? 15 : tf === "1h" ? 60 : tf === "1d" ? 1440 : 1;
        this.historyCandles[tf] = uniqByTs(r.value, bucketMinutes);
      }
    }

    const h1m = this.historyCandles["1m"];
    if (h1m.length > 0) {
      const last = h1m[h1m.length - 1];
      const spreadPips = Number(this.lastTick?.spreadPips || MARKET_BASE_SPREAD_PIPS);
      const spread = spreadPips * 0.01;
      const lastMs = new Date(last.ts).getTime();
      const lastBucket = floorToBucketMs(lastMs, 1);
      this.lastTick = {
        symbol: "USDJPY",
        bid: Number((last.close - spread / 2).toFixed(3)),
        ask: Number((last.close + spread / 2).toFixed(3)),
        spreadPips,
        orderBookImbalance: 0,
        ts: new Date(lastBucket).toISOString()
      };
      this.lastTickMs = lastMs;
      this.lastHttpAnchorCandleTsMs = lastMs;
      this.lastHttpAnchorMid = Number(last.close);
      this.current1mBucketMs = lastBucket;
      this.current1m = toCandle(last.close, lastBucket);
      this.candles1m = [];
    }
    this.historyReady = true;
  }

  startFallbackTicker() {
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = setInterval(() => {
      this.pollFallbackTick().catch(() => {});
    }, MARKET_HTTP_POLL_MS);
    if (typeof this.fallbackTimer.unref === "function") this.fallbackTimer.unref();
  }

  updateFallbackState() {
    const wsState = String(this.feedState?.state || "");
    if (wsState === "open") {
      this.fallbackActive = false;
      this.fallbackSource = "LIVE_WS";
      return;
    }
    if (wsState === "disabled" || wsState === "closed" || wsState === "error" || wsState === "connecting") {
      this.fallbackActive = true;
      if (MARKET_HTTP_TICKER_URL || MARKET_HTTP_TICKER_URLS.length) {
        this.fallbackSource = MARKET_HTTP_PROVIDER === "SBI_FX" ? "LIVE_HTTP_SBI" : "LIVE_HTTP_BRIDGE";
      } else if (MARKET_HTTP_PROVIDER === "GMO_FX") {
        this.fallbackSource = "LIVE_HTTP_GMO";
      } else {
        this.fallbackSource = "LIVE_HTTP_POLL";
      }
    }
  }

  async refreshHttpHistoryCandles({ force = false } = {}) {
    if (this.isHistoryRefreshing) return;
    const nowMs = Date.now();
    const oneMinuteCount = (this.historyCandles["1m"] || []).length + (this.candles1m || []).length;
    const shouldRefresh = force || !this.historyReady || oneMinuteCount < 60 || (nowMs - Number(this.lastHistoryRefreshMs || 0)) >= MARKET_HISTORY_REFRESH_MS;
    if (!shouldRefresh) return;

    this.isHistoryRefreshing = true;
    try {
      const one = await fetchUsdJpyHistory("1m", "1d");
      if (Array.isArray(one) && one.length > 0) {
        this.historyCandles["1m"] = uniqByTs([...(this.historyCandles["1m"] || []), ...one], 1).slice(-12000);
        const last = this.historyCandles["1m"].at(-1);
        if (last && Number.isFinite(Number(last.close))) {
          const lastMsRaw = new Date(last.ts).getTime();
          const lastMs = Number.isFinite(lastMsRaw) ? lastMsRaw : 0;
          if (lastMs > 0) {
            this.lastHttpAnchorCandleTsMs = Math.max(Number(this.lastHttpAnchorCandleTsMs || 0), lastMs);
            this.lastHttpAnchorMid = Number(last.close);
          }
          if ((!this.current1m || !Number.isFinite(Number(this.current1m.open))) && lastMs > 0) {
            const bucketMs = floorToBucketMs(lastMs, 1);
            this.current1mBucketMs = bucketMs;
            this.current1m = toCandle(Number(last.close), bucketMs);
          }
        }
      }
      this.historyReady = (this.historyCandles["1m"] || []).length > 0;
      this.lastHistoryRefreshMs = nowMs;
    } catch (error) {
      this.lastBridgeError = this.lastBridgeError || String(error?.message || error);
      this.lastHistoryRefreshMs = nowMs;
    } finally {
      this.isHistoryRefreshing = false;
    }
  }

  async pollFallbackTick() {
    this.updateFallbackState();
    if (!this.fallbackActive) return;
    const nowMs = Date.now();
    const hasTickProvider = HAS_HTTP_TICK_PROVIDER;
    const refreshMs = hasTickProvider ? MARKET_HTTP_REFRESH_SEC * 1000 : Math.max(MARKET_HTTP_REFRESH_SEC * 1000, 15000);
    const shouldRefresh = (nowMs - this.lastHttpRefreshMs) >= refreshMs;
    if (shouldRefresh && !this.isHttpRefreshing) {
      this.isHttpRefreshing = true;
      try {
        await this.refreshHttpHistoryCandles({ force: !this.historyReady || (this.historyCandles["1m"] || []).length < 60 });
        // Prefer explicit bridge feed (e.g., SBI bridge) when configured.
        const bridgeTick = (MARKET_HTTP_TICKER_URL || MARKET_HTTP_TICKER_URLS.length)
          ? await this.fetchBridgeTick(MARKET_HTTP_TICKER_URL || MARKET_HTTP_TICKER_URLS)
          : null;
        if (bridgeTick) {
          this.fallbackSource = MARKET_HTTP_PROVIDER === "SBI_FX" ? "LIVE_HTTP_SBI" : (MARKET_HTTP_PROVIDER === "GMO_FX" ? "LIVE_HTTP_GMO" : "LIVE_HTTP_BRIDGE");
          const mid = (Number(bridgeTick.bid) + Number(bridgeTick.ask)) / 2;
          this.lastSyntheticMid = mid;
          this.syntheticSeed = Math.max(1, Math.floor(nowMs / 1000) % 2147483647);
          this.consumeTick(bridgeTick);
          this.lastBridgeError = null;
        } else if (MARKET_HTTP_PROVIDER === "GMO_FX") {
          const providerTick = await this.fetchGmoFxTick();
          if (providerTick) {
            this.fallbackSource = "LIVE_HTTP_GMO";
            const mid = (Number(providerTick.bid) + Number(providerTick.ask)) / 2;
            this.lastSyntheticMid = mid;
            this.syntheticSeed = Math.max(1, Math.floor(nowMs / 1000) % 2147483647);
            this.consumeTick(providerTick);
            this.lastBridgeError = null;
          } else {
            this.fallbackSource = "LIVE_HTTP_POLL";
            this.lastBridgeError = this.lastBridgeError || "GMO FX ticker returned no valid USD/JPY quote; falling back to HTTP candle history";
          }
        } else {
          // P0-1: HTTP poll fallback for real-ish anchor updates when WS is unavailable.
          const one = await fetchUsdJpyHistory("1m", "1d");
          const last = Array.isArray(one) && one.length ? one[one.length - 1] : null;
          if (last && Number.isFinite(Number(last.close))) {
            const mid = Number(last.close);
            const lastCandleMsRaw = new Date(last.ts).getTime();
            const lastCandleMs = Number.isFinite(lastCandleMsRaw) ? lastCandleMsRaw : 0;

            this.lastHttpAnchorMid = mid;
            this.lastSyntheticMid = mid;
            this.syntheticSeed = Math.max(1, Math.floor(nowMs / 1000) % 2147483647);

            const spread = Number(this.lastTick?.spreadPips || MARKET_BASE_SPREAD_PIPS);
            const abs = spread * 0.01;

            // HTTP history polling is candle-close data, not a tick stream.
            // Only consume a newly published candle; never synthesize same-minute candles.
            if (lastCandleMs > Number(this.lastHttpAnchorCandleTsMs || 0)) {
              this.lastHttpAnchorCandleTsMs = lastCandleMs;
              this.consumeTick({
                bid: Number((mid - abs / 2).toFixed(3)),
                ask: Number((mid + abs / 2).toFixed(3)),
                spreadPips: spread,
                orderBookImbalance: Number(this.lastTick?.orderBookImbalance || 0),
                ts: new Date(lastCandleMs).toISOString()
              });
            } else if (lastCandleMs === Number(this.lastHttpAnchorCandleTsMs || 0)) {
              this.lastTickMs = nowMs;
              this.lastTick = {
                ...this.lastTick,
                symbol: "USDJPY",
                bid: Number((mid - abs / 2).toFixed(3)),
                ask: Number((mid + abs / 2).toFixed(3)),
                spreadPips: spread,
                orderBookImbalance: Number(this.lastTick?.orderBookImbalance || 0),
                ts: new Date(lastCandleMs).toISOString()
              };
            }
          }
          this.fallbackSource = "LIVE_HTTP_POLL";
        }
        this.lastHttpRefreshMs = nowMs;
      } catch (error) {
        this.lastBridgeError = String(error?.message || error);
        this.lastHttpRefreshMs = nowMs;
      } finally {
        this.isHttpRefreshing = false;
      }
    }
    // Do not synthesize tradable ticks while using the HTTP history poller.
    // GMO/custom bridge ticks are already realtime-ish HTTP quotes, so they can drive PAPER_LIVE.
    // This prevents fake current-minute candles from driving entries when only candle history is available.
    if (this.fallbackSource === "LIVE_HTTP_POLL") return;
    if (this.fallbackSource === "LIVE_HTTP_GMO" || this.fallbackSource === "LIVE_HTTP_SBI" || this.fallbackSource === "LIVE_HTTP_BRIDGE") return;

    const mid = this.nextSyntheticMid();
    const spreadPips = Number(this.lastTick?.spreadPips || MARKET_BASE_SPREAD_PIPS);
    const spreadAbs = spreadPips * 0.01;
    this.consumeTick({
      bid: Number((mid - spreadAbs / 2).toFixed(3)),
      ask: Number((mid + spreadAbs / 2).toFixed(3)),
      spreadPips,
      orderBookImbalance: Number(this.lastTick?.orderBookImbalance || 0),
      ts: new Date().toISOString()
    });
  }

  nextSyntheticMid() {
    const lastBid = Number(this.lastTick?.bid || 0);
    const lastAsk = Number(this.lastTick?.ask || 0);
    const base = Number.isFinite(this.lastSyntheticMid) && this.lastSyntheticMid > 0
      ? this.lastSyntheticMid
      : ((lastBid > 0 && lastAsk > 0) ? (lastBid + lastAsk) / 2 : 150);
    this.syntheticSeed = (this.syntheticSeed * 16807) % 2147483647;
    const r = (this.syntheticSeed - 1) / 2147483646;
    const drift = (r - 0.5) * 0.0045;
    const next = Math.max(80, base + drift);
    this.lastSyntheticMid = next;
    return Number(next.toFixed(3));
  }

  async fetchBridgeTick(urlOrUrls) {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let lastError = null;

    for (const url of urls.filter(Boolean)) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), MARKET_HTTP_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json,text/plain,*/*",
            ...MARKET_HTTP_HEADERS
          },
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`bridge status ${res.status}`);
        const contentType = String(res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text();
        const payload = contentType.includes("application/json")
          ? JSON.parse(text)
          : parseMaybeJsonText(text);
        const tick = normalizeHttpTickPayload(payload);
        if (tick) return tick;
        lastError = new Error("bridge payload did not contain a valid USD/JPY bid/ask/mid quote");
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(t);
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  async fetchGmoFxTick() {
    const symbol = encodeURIComponent(MARKET_HTTP_SYMBOL);
    const urls = [];
    if (MARKET_GMO_PUBLIC_BASE_URL) {
      urls.push(`${MARKET_GMO_PUBLIC_BASE_URL.replace(/\/$/, "")}/public/v1/ticker?symbol=${symbol}`);
    }
    urls.push(`https://forex-api.coin.z.com/public/v1/ticker?symbol=${symbol}`);
    urls.push(`https://api.coin.z.com/public/v1/ticker?symbol=${symbol}`);

    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), MARKET_HTTP_TIMEOUT_MS);
        let payload = null;
        try {
          const res = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: ctrl.signal
          });
          if (!res.ok) throw new Error(`gmo ticker status ${res.status}`);
          payload = await res.json();
        } finally {
          clearTimeout(t);
        }
        const tick = normalizeGmoFxTickPayload(payload);
        if (tick) return tick;
        this.lastBridgeError = `GMO FX ticker payload did not contain a valid ${MARKET_HTTP_SYMBOL} quote`;
      } catch (error) {
        this.lastBridgeError = String(error?.message || error);
      }
    }
    return null;
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseMaybeJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const jsonStart = raw.search(/[\[{]/);
  if (jsonStart >= 0) {
    const sliced = raw.slice(jsonStart);
    try {
      return JSON.parse(sliced);
    } catch {}
  }

  const pairLike = {};
  for (const part of raw.split(/[\n&,;]/)) {
    const [k, v] = part.split(/[=:]/).map((s) => String(s || "").trim());
    if (!k || v == null || v === "") continue;
    pairLike[k] = v;
  }
  return Object.keys(pairLike).length ? pairLike : null;
}

function readByPath(obj, keyPath = "") {
  if (!keyPath) return undefined;
  const keys = String(keyPath).split(".").filter(Boolean);
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function normalizeHttpTickPayload(payload) {
  const rows = flattenPayloadCandidates(payload);
  const symbolNeedle = normalizeSymbolName(MARKET_HTTP_SYMBOL);

  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const symbolRaw = MARKET_HTTP_SYMBOL_KEY ? readByPath(item, MARKET_HTTP_SYMBOL_KEY) : undefined;
    const itemSymbol = normalizeSymbolName(
      symbolRaw
        ?? item.symbol
        ?? item.currencyPair
        ?? item.currencyPairCode
        ?? item.pair
        ?? item.name
        ?? item.instrument
        ?? item.code
        ?? item.productCode
        ?? item.currency
        ?? item.ccyPair
        ?? ""
    );
    if (itemSymbol && symbolNeedle && itemSymbol !== symbolNeedle) continue;

    const bidRaw = MARKET_HTTP_BID_KEY ? readByPath(item, MARKET_HTTP_BID_KEY) : undefined;
    const askRaw = MARKET_HTTP_ASK_KEY ? readByPath(item, MARKET_HTTP_ASK_KEY) : undefined;
    const midRaw = MARKET_HTTP_MID_KEY ? readByPath(item, MARKET_HTTP_MID_KEY) : undefined;
    const spreadRaw = MARKET_HTTP_SPREAD_KEY ? readByPath(item, MARKET_HTTP_SPREAD_KEY) : undefined;

    let bid = Number(
      bidRaw
      ?? item.bid
      ?? item.bestBid
      ?? item.bidPrice
      ?? item.bidRate
      ?? item.bid_price
      ?? item.bid_rate
      ?? item.Bid
      ?? item.BID
      ?? item.buy
      ?? item.buyPrice
      ?? item.buy_price
      ?? item.sellRate
      ?? item.sell_rate
      ?? item.b
      ?? NaN
    );
    let ask = Number(
      askRaw
      ?? item.ask
      ?? item.bestAsk
      ?? item.askPrice
      ?? item.askRate
      ?? item.ask_price
      ?? item.ask_rate
      ?? item.Ask
      ?? item.ASK
      ?? item.sell
      ?? item.sellPrice
      ?? item.sell_price
      ?? item.buyRate
      ?? item.buy_rate
      ?? item.a
      ?? NaN
    );
    const mid = Number(
      midRaw
      ?? item.mid
      ?? item.midPrice
      ?? item.mid_price
      ?? item.price
      ?? item.last
      ?? item.lastPrice
      ?? item.last_price
      ?? item.rate
      ?? item.close
      ?? item.value
      ?? NaN
    );
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) {
      if (!Number.isFinite(mid)) continue;
      const spreadAbs = MARKET_BASE_SPREAD_PIPS * 0.01;
      bid = Number((mid - spreadAbs / 2).toFixed(3));
      ask = Number((mid + spreadAbs / 2).toFixed(3));
    }
    if (!isUsdJpyPrice(bid) || !isUsdJpyPrice(ask)) continue;

    const spreadPipsRaw = Number(spreadRaw ?? ((ask - bid) / 0.01));
    const spreadPips = Math.max(MARKET_BASE_SPREAD_PIPS, Number.isFinite(spreadPipsRaw) ? spreadPipsRaw : MARKET_BASE_SPREAD_PIPS);
    const mid2 = (bid + ask) / 2;
    const spreadAbs2 = spreadPips * 0.01;
    const tsRaw = MARKET_HTTP_TIME_KEY
      ? readByPath(item, MARKET_HTTP_TIME_KEY)
      : (item.ts ?? item.timestamp ?? item.time ?? item.rateTime ?? item.updateTime ?? item.updatedAt ?? item.datetime ?? item.serverTime ?? item.quoteTime);
    const tsMs = new Date(tsRaw || Date.now()).getTime();
    return {
      bid: Number((mid2 - spreadAbs2 / 2).toFixed(3)),
      ask: Number((mid2 + spreadAbs2 / 2).toFixed(3)),
      spreadPips: Number(spreadPips.toFixed(2)),
      orderBookImbalance: 0,
      ts: new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString()
    };
  }

  return null;
}

function flattenPayloadCandidates(payload) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    out.push(value);
    for (const key of ["data", "result", "items", "rates", "prices", "quotes", "tick", "ticker", "body", "payload"]) {
      const child = value[key];
      if (child && typeof child === "object") push(child);
    }
  };
  push(payload);
  return out;
}

function normalizeSymbolName(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isUsdJpyPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 100 && n < 200;
}

function normalizeGmoFxTickPayload(payload) {
  const rows = flattenPayloadCandidates(payload);
  const symbolNeedle = normalizeSymbolName(MARKET_HTTP_SYMBOL);

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rowSymbol = normalizeSymbolName(
      row.symbol
      ?? row.currencyPair
      ?? row.currencyPairCode
      ?? row.pair
      ?? row.name
      ?? row.instrument
      ?? row.code
      ?? ""
    );
    if (rowSymbol && symbolNeedle && rowSymbol !== symbolNeedle) continue;

    const bid = Number(row.bid ?? row.bestBid ?? row.buy ?? row.buyPrice ?? row.bidPrice ?? NaN);
    const ask = Number(row.ask ?? row.bestAsk ?? row.sell ?? row.sellPrice ?? row.askPrice ?? NaN);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) continue;
    if (!isUsdJpyPrice(bid) || !isUsdJpyPrice(ask)) continue;

    const spreadPips = Math.max(MARKET_BASE_SPREAD_PIPS, (ask - bid) / 0.01);
    const mid = (bid + ask) / 2;
    const spreadAbs = spreadPips * 0.01;
    const tsRaw = row.timestamp ?? row.time ?? row.updatedAt ?? row.updateTime ?? row.rateTime ?? row.serverTime;
    const tsMs = new Date(tsRaw || Date.now()).getTime();
    return {
      bid: Number((mid - spreadAbs / 2).toFixed(3)),
      ask: Number((mid + spreadAbs / 2).toFixed(3)),
      spreadPips: Number(spreadPips.toFixed(2)),
      orderBookImbalance: 0,
      ts: new Date(Number.isFinite(tsMs) ? tsMs : Date.now()).toISOString()
    };
  }

  return null;
}

function isFxMarketOpen(nowMs) {
  const t = new Date(nowMs + 9 * 60 * 60 * 1000);
  const dow = t.getUTCDay();
  const hour = t.getUTCHours();
  // JST 기준: 週明け月曜07:00ごろ再開、土曜07:00ごろ終了（目安）
  if (dow === 0) return false;
  if (dow === 6) return hour < 7;
  if (dow === 1) return hour >= 7;
  return true;
}