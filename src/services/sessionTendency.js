function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jstHour(iso) {
  const t = new Date(iso || Date.now()).getTime();
  const shifted = new Date(t + 9 * 60 * 60 * 1000);
  return shifted.getUTCHours();
}

function toSession(hour) {
  if (hour >= 9 && hour < 15) return "TOKYO";
  if (hour >= 15 && hour < 22) return "LONDON";
  return "NY";
}

export function computeUsdJpySessionTendency(trades, now = new Date()) {
  const h = jstHour(now.toISOString());
  const session = toSession(h);
  const recent = (Array.isArray(trades) ? trades : [])
    .slice(-240)
    .filter((t) => Number.isFinite(Number(t?.netPnlJpy)));
  if (recent.length < 20) {
    return {
      session,
      sampleSize: recent.length,
      directionBias: "NEUTRAL",
      confidenceDelta: 0,
      winRate: 0,
      expectancyJpy: 0
    };
  }

  const inSession = recent.filter((t) => toSession(jstHour(t.exitTime || t.entryTime || now.toISOString())) === session);
  if (inSession.length < 8) {
    return {
      session,
      sampleSize: inSession.length,
      directionBias: "NEUTRAL",
      confidenceDelta: 0,
      winRate: 0,
      expectancyJpy: 0
    };
  }

  const wins = inSession.filter((t) => Number(t.netPnlJpy) > 0).length;
  const winRate = wins / inSession.length;
  const expectancyJpy = inSession.reduce((s, t) => s + Number(t.netPnlJpy), 0) / inSession.length;
  const buyPnls = inSession.filter((t) => t.side === "BUY").map((t) => Number(t.netPnlJpy));
  const sellPnls = inSession.filter((t) => t.side === "SELL").map((t) => Number(t.netPnlJpy));
  const buyAvg = buyPnls.length ? buyPnls.reduce((s, v) => s + v, 0) / buyPnls.length : 0;
  const sellAvg = sellPnls.length ? sellPnls.reduce((s, v) => s + v, 0) / sellPnls.length : 0;
  const dirGap = buyAvg - sellAvg;
  const directionBias = dirGap > 400 ? "BUY" : (dirGap < -400 ? "SELL" : "NEUTRAL");

  const confidenceDelta = clamp((winRate - 0.5) * 0.16 + clamp(expectancyJpy / 3000, -0.08, 0.08), -0.12, 0.12);
  return {
    session,
    sampleSize: inSession.length,
    directionBias,
    confidenceDelta: Number(confidenceDelta.toFixed(4)),
    winRate: Number(winRate.toFixed(4)),
    expectancyJpy: Number(expectancyJpy.toFixed(2))
  };
}

