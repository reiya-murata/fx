import { loadState } from "../src/data/store.js";
import { buildWeeklyFrequencyReport } from "../src/services/reporting.js";

const state = loadState();
const report = buildWeeklyFrequencyReport(state, new Date());
console.log(JSON.stringify(report, null, 2));
