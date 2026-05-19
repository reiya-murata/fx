function toNum(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isFiniteCandle(c) {
  return Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close);
}

export function parseYahooChartCandles(payload) {
  const result = payload?.chart?.result?.[0];
  const ts = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const open = Array.isArray(quote.open) ? quote.open : [];
  const high = Array.isArray(quote.high) ? quote.high : [];
  const low = Array.isArray(quote.low) ? quote.low : [];
  const close = Array.isArray(quote.close) ? quote.close : [];
  const out = [];

  for (let i = 0; i < ts.length; i += 1) {
    const c = {
      open: toNum(open[i]),
      high: toNum(high[i]),
      low: toNum(low[i]),
      close: toNum(close[i]),
      ts: new Date(Number(ts[i]) * 1000).toISOString()
    };
    if (!isFiniteCandle(c)) continue;
    out.push(c);
  }

  out.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return out;
}

export async function fetchUsdJpyHistory(tf = "1m", range = "7d") {
  const interval = normalizeTf(tf);
  const appliedRange = normalizeRange(tf, range);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(appliedRange)}&includePrePost=false&events=div%2Csplits`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "fx-demo-trade-engine/0.1"
    }
  });
  if (!res.ok) {
    throw new Error(`history fetch failed: ${res.status}`);
  }
  const payload = await res.json();
  return parseYahooChartCandles(payload);
}

function normalizeTf(tf) {
  if (tf === "15m") return "15m";
  if (tf === "1h") return "1h";
  if (tf === "1d") return "1d";
  return "1m";
}

function normalizeRange(tf, range) {
  if (range && range !== "auto") return String(range);
  if (tf === "1m") return "7d";
  if (tf === "15m") return "60d";
  if (tf === "1h") return "730d";
  if (tf === "1d") return "10y";
  return "60d";
}
