import { loadState } from "../src/data/store.js";
import { buildMonthlyPerformanceReport } from "../src/services/reporting.js";

const state = loadState();
const report = buildMonthlyPerformanceReport(state, new Date());
console.log(JSON.stringify(report, null, 2));
