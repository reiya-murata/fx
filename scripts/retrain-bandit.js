import { loadState } from "../src/data/store.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { retrainBanditFromTrades } from "../src/services/rlBandit.js";

const halfLife = Number(process.argv[2] || 120);
const state = loadState();
const result = retrainBanditFromTrades({
  trades: state.trades || [],
  config: DEFAULT_CONFIG,
  halfLife: Number.isFinite(halfLife) ? halfLife : 120
});

console.log(JSON.stringify({
  ok: true,
  halfLife,
  ...result,
  at: new Date().toISOString()
}, null, 2));
