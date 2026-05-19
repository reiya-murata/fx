import { loadState } from "../src/data/store.js";
import { analyticsEventImpact, analyticsSummary } from "../src/services/analytics.js";

const from = process.argv[2] || "";
const to = process.argv[3] || "";

const state = loadState();
const summary = analyticsSummary(state.trades || [], from || undefined, to || undefined);
const eventImpact = analyticsEventImpact(state.trades || [], { minTrades: 2 });

console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  from: from || null,
  to: to || null,
  summary,
  topTags: (eventImpact.tagItems || []).slice(0, 5),
  topEvents: (eventImpact.eventItems || []).slice(0, 10)
}, null, 2));
