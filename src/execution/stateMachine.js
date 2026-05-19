import { randomUUID } from "node:crypto";

export function simulateOrderLifecycle({ side, qty, requestedPrice, market, config }) {
  const now = Date.now();
  const orderId = randomUUID();
  const statusHistory = [];

  push("NEW");
  push("PENDING");

  const latencyMs = Math.max(20, Math.round(config.execution.baseLatencyMs + Math.random() * config.execution.latencyJitterMs));

  if (Math.random() < config.execution.rejectProbability) {
    push("REJECTED");
    return {
      order: buildOrder("REJECTED"),
      fills: [],
      executedQty: 0,
      avgFillPrice: null,
      feeJpy: 0,
      slippagePips: 0,
      latencyMs,
      rejected: true
    };
  }

  const bestQuote = side === "BUY" ? market.ask : market.bid;
  const levels = buildBookLevels(side, bestQuote, market.spreadPips, config);
  const fillPlan = consumeDepth(qty, levels);

  let executedQty = fillPlan.executedQty;
  if (executedQty <= 0) {
    push("REJECTED");
    return {
      order: buildOrder("REJECTED"),
      fills: [],
      executedQty: 0,
      avgFillPrice: null,
      feeJpy: 0,
      slippagePips: 0,
      latencyMs,
      rejected: true
    };
  }

  // latency penalty: long decision/execution chain degrades fill
  const latencySlipPips = (latencyMs / 1000) * config.execution.latencySlippagePipsPerSec;
  const randomSlipCap = Math.max(0, Number(config.execution.randomSlippagePips || 0));
  const favorableSlipProbability = clamp(Number(config.execution.favorableSlipProbability || 0.08), 0.01, 0.35);
  const rawRandomSlip = Math.random() * randomSlipCap;
  const stochasticSlipPips = Math.random() < favorableSlipProbability
    ? -rawRandomSlip * 0.45
    : rawRandomSlip;
  const totalSlipPips = clamp(
    latencySlipPips + stochasticSlipPips,
    -Number(config.execution.maxSlippagePips || 1.2),
    Number(config.execution.maxSlippagePips || 1.2)
  );
  const signedSlip = side === "BUY" ? totalSlipPips : -totalSlipPips;

  const fills = fillPlan.parts.map((p, idx) => {
    const price = p.price + signedSlip * config.pipSize;
    const feeJpy = Number((((price * p.qty) * config.execution.feeBps) / 10000).toFixed(2));
    return {
      id: randomUUID(),
      orderId,
      qty: p.qty,
      price: Number(price.toFixed(3)),
      slippagePips: Number((((price - bestQuote) / config.pipSize) * (side === "BUY" ? 1 : -1)).toFixed(3)),
      feeJpy,
      latencyMs,
      ts: new Date(now + latencyMs + idx * 5).toISOString()
    };
  });

  const avgFillPrice = weightedAvg(fills.map((f) => ({ price: f.price, qty: f.qty })));
  const totalFee = Number(fills.reduce((s, f) => s + f.feeJpy, 0).toFixed(2));
  const slippagePips = Number((((avgFillPrice - bestQuote) / config.pipSize) * (side === "BUY" ? 1 : -1)).toFixed(3));

  const partiallyFilled = executedQty < qty;
  push(partiallyFilled ? "PARTIALLY_FILLED" : "FILLED");

  return {
    order: buildOrder(partiallyFilled ? "PARTIALLY_FILLED" : "FILLED"),
    fills,
    executedQty,
    avgFillPrice,
    feeJpy: totalFee,
    slippagePips,
    latencyMs,
    rejected: false
  };

  function push(status) {
    statusHistory.push({ status, ts: new Date().toISOString() });
  }

  function buildOrder(status) {
    return {
      id: orderId,
      side,
      qty,
      requestedPrice,
      status,
      createdAt: new Date(now).toISOString(),
      statusHistory
    };
  }
}

function buildBookLevels(side, bestQuote, spreadPips, config) {
  const levels = [];
  const levelCount = config.execution.depthLevels;
  const baseQty = config.execution.depthBaseQty;
  const pip = config.pipSize;

  for (let i = 0; i < levelCount; i += 1) {
    const levelSlipPips = spreadPips * 0.2 + i * config.execution.depthStepPips;
    const price = side === "BUY"
      ? bestQuote + levelSlipPips * pip
      : bestQuote - levelSlipPips * pip;
    const qty = baseQty * Math.max(0.35, 1 - i * 0.12);
    levels.push({ price, qty: Number(qty.toFixed(3)) });
  }

  return levels;
}

function consumeDepth(requestQty, levels) {
  let remaining = requestQty;
  let executedQty = 0;
  const parts = [];

  for (const lv of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lv.qty);
    if (take <= 0) continue;
    parts.push({ qty: Number(take.toFixed(3)), price: lv.price });
    executedQty += take;
    remaining -= take;
  }

  return {
    executedQty: Number(executedQty.toFixed(3)),
    parts
  };
}

function weightedAvg(rows) {
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  if (totalQty <= 0) return 0;
  const total = rows.reduce((s, r) => s + r.price * r.qty, 0);
  return Number((total / totalQty).toFixed(6));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
