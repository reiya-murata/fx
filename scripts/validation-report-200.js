import { loadState } from "../src/data/store.js";
import { analyticsValidationReport200 } from "../src/services/analytics.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const state = loadState();
const report = analyticsValidationReport200(state.trades || [], DEFAULT_CONFIG.benchmark);

console.log(JSON.stringify({
  ...report,
  generatedAt: new Date().toISOString(),
  benchmark: DEFAULT_CONFIG.benchmark
}, null, 2));
