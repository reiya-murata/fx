import { buildAssistantDecision } from "./engine/assistant.js";

function candles(base, count, step = 0.02) {
  const out = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    const drift = i % 4 === 0 ? -step * 0.6 : step;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + step * 0.5;
    const low = Math.min(open, close) - step * 0.5;
    out.push({ open, high, low, close });
    price = close;
  }
  return out;
}

const input = {
  bid: 149.812,
  ask: 149.815,
  spreadPips: 0.2,
  candles1m: candles(149.2, 120, 0.015),
  candles5m: candles(149.0, 120, 0.02),
  candles15m: candles(148.8, 120, 0.03),
  account: {
    currentBalanceJpy: 1000000,
    dayPnlJpy: 8000,
    weekDrawdownJpy: 12000,
    consecutiveLosses: 1
  }
};

const decision = buildAssistantDecision(input);
console.log(JSON.stringify(decision, null, 2));
