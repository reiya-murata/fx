import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MEMORY_PATH = resolve(process.cwd(), "data/learning_memory.json");

const DEFAULT_MEMORY = {
  version: 1,
  updatedAt: null,
  lastProcessedTradeIndex: 0,
  totalTrades: 0,
  ewmaExpectancyJpy: 0,
  ewmaWinRate: 0.5,
  ewmaProfitFactor: 1,
  contextCounts: {}
};

function ensureFile() {
  if (existsSync(MEMORY_PATH)) return;
  mkdirSync(dirname(MEMORY_PATH), { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(DEFAULT_MEMORY, null, 2));
}

export function loadLearningMemory() {
  try {
    ensureFile();
    const raw = readFileSync(MEMORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_MEMORY,
      ...parsed,
      contextCounts: parsed?.contextCounts && typeof parsed.contextCounts === "object" ? parsed.contextCounts : {}
    };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export function saveLearningMemory(memory) {
  writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

export function resetLearningMemory() {
  const next = {
    ...DEFAULT_MEMORY,
    updatedAt: new Date().toISOString()
  };
  saveLearningMemory(next);
  return next;
}

export function updateLearningMemoryFromTrades(trades, options = {}) {
  const alpha = clamp(Number(options.alpha || 0.02), 0.001, 0.4);
  const maxContexts = Math.max(200, Number(options.maxContexts || 3000));
  const memory = loadLearningMemory();
  const list = Array.isArray(trades) ? trades : [];
  const start = Math.max(0, Number(memory.lastProcessedTradeIndex || 0));
  const nextTrades = list.slice(start);
  if (!nextTrades.length) return memory;

  let ewmaExpectancy = Number(memory.ewmaExpectancyJpy || 0);
  let ewmaWinRate = clamp(Number(memory.ewmaWinRate ?? 0.5), 0, 1);
  let ewmaProfitFactor = Math.max(0.01, Number(memory.ewmaProfitFactor || 1));
  const contextCounts = { ...(memory.contextCounts || {}) };
  let totalTrades = Number(memory.totalTrades || 0);

  for (const t of nextTrades) {
    const pnl = Number(t?.netPnlJpy || 0);
    const win = pnl > 0 ? 1 : 0;
    const profit = pnl > 0 ? pnl : 0;
    const lossAbs = pnl < 0 ? Math.abs(pnl) : 0;
    ewmaExpectancy = alpha * pnl + (1 - alpha) * ewmaExpectancy;
    ewmaWinRate = alpha * win + (1 - alpha) * ewmaWinRate;
    const instantPf = lossAbs > 0 ? (profit / lossAbs) : (profit > 0 ? 2 : 1);
    ewmaProfitFactor = alpha * instantPf + (1 - alpha) * ewmaProfitFactor;
    const ctx = String(t?.banditContextKey || "");
    if (ctx) {
      contextCounts[ctx] = Number(contextCounts[ctx] || 0) + 1;
    }
    totalTrades += 1;
  }

  const compacted = compactContextCounts(contextCounts, maxContexts);
  const next = {
    ...memory,
    updatedAt: new Date().toISOString(),
    lastProcessedTradeIndex: list.length,
    totalTrades,
    ewmaExpectancyJpy: Number(ewmaExpectancy.toFixed(4)),
    ewmaWinRate: Number(ewmaWinRate.toFixed(6)),
    ewmaProfitFactor: Number(ewmaProfitFactor.toFixed(6)),
    contextCounts: compacted
  };
  saveLearningMemory(next);
  return next;
}

function compactContextCounts(counts, maxContexts) {
  const rows = Object.entries(counts || {})
    .map(([k, v]) => [k, Number(v || 0)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxContexts);
  return Object.fromEntries(rows);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
