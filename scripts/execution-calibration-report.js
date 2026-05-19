import { loadState } from "../src/data/store.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { computeExecutionCalibration } from "../src/services/executionCalibration.js";

const state = loadState();
const out = computeExecutionCalibration(state, DEFAULT_CONFIG.executionCalibration || {});
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  trades: Array.isArray(state.trades) ? state.trades.length : 0,
  calibration: out
}, null, 2));
