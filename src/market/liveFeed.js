export class LiveWsFeed {
  constructor({ url, subscribeMessage = null, heartbeatMs = 20000 } = {}) {
    this.url = url;
    this.subscribeMessage = subscribeMessage;
    this.heartbeatMs = heartbeatMs;
    this.ws = null;
    this.onTick = () => {};
    this.onStatus = () => {};
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closedByUser = false;
  }

  start({ onTick, onStatus } = {}) {
    if (onTick) this.onTick = onTick;
    if (onStatus) this.onStatus = onStatus;
    if (!this.url) {
      this.onStatus({ state: "disabled", reason: "MARKET_WS_URL is missing" });
      return;
    }
    this.closedByUser = false;
    this.connect();
  }

  stop() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  connect() {
    this.onStatus({ state: "connecting", url: this.url });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.onStatus({ state: "open" });
      if (this.subscribeMessage) ws.send(this.subscribeMessage);
      this.startHeartbeat();
    });

    ws.addEventListener("message", (event) => {
      const tick = extractTickFromPayload(String(event.data));
      if (tick) this.onTick(tick);
    });

    ws.addEventListener("close", () => {
      this.onStatus({ state: "closed" });
      clearInterval(this.pingTimer);
      if (!this.closedByUser) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    ws.addEventListener("error", (err) => {
      this.onStatus({ state: "error", message: String(err?.message || "ws error") });
      try { ws.close(); } catch {}
    });
  }

  startHeartbeat() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {}
    }, this.heartbeatMs);
  }
}

const FALLBACK_SPREAD_PIPS = (() => {
  const n = Number(process.env.MARKET_FALLBACK_SPREAD_PIPS || 0.18);
  if (!Number.isFinite(n)) return 0.18;
  return Math.max(0.01, n);
})();

export function extractTickFromPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [payload];

  for (const item of candidates) {
    const tick = extractTick(item);
    if (tick) return tick;
  }
  return null;
}

function extractTick(item) {
  if (!item || typeof item !== "object") return null;
  const topBidFromBook = extractTop(item.bids);
  const topAskFromBook = extractTop(item.asks);
  const bid = num(item.bid ?? item.b ?? item.bestBid ?? item.bidPrice ?? topBidFromBook);
  const ask = num(item.ask ?? item.a ?? item.bestAsk ?? item.askPrice ?? topAskFromBook);
  const mid = num(item.price ?? item.mid ?? item.last);
  const symbol = String(item.symbol ?? item.pair ?? item.s ?? "USDJPY");
  const orderBookImbalance = computeImbalance(item.bids, item.asks);

  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
    const mid = (bid + ask) / 2;
    const rawSpreadPips = (ask - bid) / 0.01;
    const spreadPips = Math.max(FALLBACK_SPREAD_PIPS, rawSpreadPips);
    const spreadAbs = spreadPips * 0.01;
    const adjBid = Number((mid - spreadAbs / 2).toFixed(3));
    const adjAsk = Number((mid + spreadAbs / 2).toFixed(3));
    return {
      symbol,
      bid: adjBid,
      ask: adjAsk,
      spreadPips: Number(spreadPips.toFixed(2)),
      orderBookImbalance,
      ts: new Date().toISOString()
    };
  }

  if (Number.isFinite(mid)) {
    const spread = FALLBACK_SPREAD_PIPS * 0.01;
    const bid2 = Number((mid - spread / 2).toFixed(3));
    const ask2 = Number((mid + spread / 2).toFixed(3));
    return {
      symbol,
      bid: bid2,
      ask: ask2,
      spreadPips: Number((((ask2 - bid2) / 0.01)).toFixed(2)),
      orderBookImbalance,
      ts: new Date().toISOString()
    };
  }

  return null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function extractTop(levels) {
  if (!Array.isArray(levels) || !levels.length) return NaN;
  const top = levels[0];
  if (Array.isArray(top)) return num(top[0]);
  if (top && typeof top === "object") return num(top.price ?? top.p);
  return NaN;
}

function computeImbalance(bids, asks) {
  const b = topDepthQty(bids);
  const a = topDepthQty(asks);
  if (!(b > 0 || a > 0)) return null;
  return Number(((b - a) / Math.max(1, b + a)).toFixed(4));
}

function topDepthQty(levels) {
  if (!Array.isArray(levels)) return 0;
  let sum = 0;
  for (let i = 0; i < Math.min(5, levels.length); i += 1) {
    const lv = levels[i];
    const qty = Array.isArray(lv) ? num(lv[1]) : num(lv?.qty ?? lv?.size ?? lv?.q);
    if (Number.isFinite(qty) && qty > 0) sum += qty;
  }
  return sum;
}
