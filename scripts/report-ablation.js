import { loadState } from "../src/data/store.js";
import { buildAblationReport } from "../src/services/reporting.js";

const state = loadState();
const ablation = process.argv[2] || process.env.ABLATION || "";
const report = buildAblationReport(state, ablation);
console.log(JSON.stringify(report, null, 2));
