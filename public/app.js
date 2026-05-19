const $ = (id) => document.getElementById(id);
const chartState = {
  candles: [],
  candlesTf: null,
  positions: [],
  trades: [],
  news: [],
  newsTab: "all",
  tf: "1m"
};
const TF_STORAGE_KEY = "fx_chart_tf";
const JST_TZ = "Asia/Tokyo";
const LOT_UNIT = 1000;
let EST_FEE_BPS = 0;
let BASELINE_SPREAD_PIPS = 0.18;
let BROKER_LABEL = "SBI FXトレード";
let lastMidPrice = null;
let latestTicker = null;
let chartRefreshBusy = false;
let chartRequestSeq = 0;
let signalRefreshBusy = false;
let lastSignalRefreshMs = 0;
const SIGNAL_REFRESH_MIN_MS = 1000;
let syncRefreshBusy = false;
let lastSyncRefreshMs = 0;
const SYNC_REFRESH_MIN_MS = 1200;
const chartRuntime = {
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  ma10Series: null,
  ma25Series: null,
  ma75Series: null,
  priceLines: [],
  resizeObserver: null,
  fallbackMode: false
};
let reportAblationText = "fullOff,semiOff,aggressiveOff";
const runtimeDiag = {
  autoStatus: null,
  executionStats: null,
  learningStatus: null
};
const CHART_VIEW_BARS = {
  "1m": 72,
  "5m": 84,
  "15m": 96,
  "1h": 220,
  "1d": 220
};
const CHART_BAR_SPACING = {
  "1m": 8.8,
  "5m": 8.2,
  "15m": 7.8,
  "1h": 3.8,
  "1d": 5.2
};
const CHART_PRICE_PADDING_PIPS = {
  "1m": 2.5,
  "5m": 4.0,
  "15m": 6.0,
  "1h": 34.0,
  "1d": 72.0
};
const CHART_MIN_SPAN_PIPS = {
  "1m": 4,
  "5m": 10,
  "15m": 24,
  "1h": 280,
  "1d": 420
};
const CHART_PRICE_SCALE_MARGINS = {
  "1m": { top: 0.08, bottom: 0.12 },
  "5m": { top: 0.08, bottom: 0.12 },
  "15m": { top: 0.09, bottom: 0.13 },
  "1h": { top: 0.16, bottom: 0.24 },
  "1d": { top: 0.14, bottom: 0.2 }
};

function normalizeExecutionModeUi(mode) {
  const m = String(mode || "PAPER_LIVE").toUpperCase();
  return m === "LIVE" ? "LIVE" : "PAPER_LIVE";
}

function executionModeLabel(mode) {
  const m = normalizeExecutionModeUi(mode);
  if (m === "LIVE") return "本番（実注文）";
  return "ライブ相場 + 注文シミュレーション";
}

function getActiveExecutionModeForView() {
  const selected = $("autoExecutionMode")?.value;
  return normalizeExecutionModeUi(selected || runtimeDiag.autoStatus?.autoExecutionMode || "PAPER_LIVE");
}

function fmt(n, digits = 2) {
  if (window.formatNumber) return window.formatNumber(n, digits);
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Number(n).toFixed(digits);
}

function formatJPY(value, options = {}) {
  if (window.formatJpy) return window.formatJpy(value, options);
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const prefix = options.approx ? "約" : "";
  return `${prefix}${Math.round(n).toLocaleString("ja-JP")}円`;
}

function formatUnits(units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const rounded = Math.round(n);
  if (rounded < 10000) return `${rounded.toLocaleString("ja-JP")}通貨`;
  return `${(rounded / 10000).toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  })}万通貨`;
}

function formatPercent(value, digits = 1) {
  if (window.formatPercentValue) return window.formatPercentValue(value, digits);
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${fmt(n * 100, digits)}%`;
}

function formatReasonSummary(value) {
  if (!value || typeof value !== "object") return "-";
  const entries = Object.entries(value)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) return "-";
  return entries.map(([reason, count]) => `${translateReasonJa(reason)}:${count}`).join(" / ");
}

function actionJa(action) {
  if (action === "BUY") return "買い";
  if (action === "SELL") return "売り";
  if (action === "HOLD") return "見送り";
  if (action === "NEUTRAL") return "中立";
  return action || "-";
}

function regimeJa(regime) {
  const r = String(regime || "");
  if (r === "TREND_UP") return "上昇トレンド";
  if (r === "TREND_DOWN") return "下降トレンド";
  if (r === "RANGE") return "レンジ";
  if (r === "HIGH_VOLATILITY") return "高ボラティリティ";
  return r || "-";
}

function rationaleJa(text) {
  return translateReasonJa(text);
}

const REASON_TRANSLATIONS = [
  ["blocked: No trade signal", "取引シグナルなしのため見送り"],
  ["Range edge not confirmed", "レンジ端の優位性が未確認"],
  ["RANGE_TOO_WIDE", "レンジ幅が広すぎます"],
  ["Range too wide", "レンジ幅が広すぎます"],
  ["Not range regime", "レンジ相場ではありません"],
  ["price in middle of range", "レンジ中央付近です"],
  ["spread too wide for range momentum", "レンジ勢い判定にはスプレッドが広すぎます"],
  ["not close enough to lower edge", "レンジ下限に十分近くありません"],
  ["not close enough to upper edge", "レンジ上限に十分近くありません"],
  ["no bullish candle close", "陽線確定がありません"],
  ["no bearish candle close", "陰線確定がありません"],
  ["spread too wide for early reversal", "早期反転狙いにはスプレッドが広すぎます"],
  ["confidence below floor", "信頼度が最低基準未満"],
  ["edge below cost-aware threshold", "コスト考慮後の優位性が不足"],
  ["spread too high", "スプレッドが広すぎます"],
  ["execution stress too high", "約定ストレスが高すぎます"],
  ["Insufficient data", "データ不足"],
  ["No trade signal", "取引シグナルなし"],
  ["overextendedEntry", "伸び切った位置"],
  ["validPullbackEntry", "有効な押し目候補"],
  ["noPullbackEntry", "押し目未確認"],
  ["lateTrendEntry", "トレンド後半の遅いエントリー"],
  ["missingCurrentPrice", "現在価格なし"],
  ["PROBE_CANDIDATE", "小ロット検討候補"],
  ["WEAK_HOLD", "弱いため見送り"],
  ["NO_EDGE", "優位性なし"],
  ["OVEREXTENDED", "伸び切り"],
  ["BLOCKED", "ブロック"],
  ["PASS", "通過"],
  ["HOLD", "見送り"],
  ["BUY", "買い候補"],
  ["SELL", "売り候補"],
  ["LIVE_HTTP_GMO", "GMO HTTP価格"],
  ["LIVE_DISCONNECTED", "リアルタイム未接続"],
  ["HTTP_POLL", "HTTP取得"],
  ["PAPER_LIVE", "デモライブ"],
  ["SIMULATED", "シミュレーション"],
  ["fallback", "代替SL"],
  ["signal", "シグナルSL"],
  ["pre-trade guard", "取引前ガード"],
  ["entry evidence weak", "エントリー根拠不足"],
  ["no actionable signal", "実行可能なシグナルなし"],
  ["final sizing guard blocked", "最終ロット制御でブロック"],
  ["market closed", "市場クローズ"],
  ["reentry guard", "再エントリー制御"],
  ["execution tail gate", "約定品質ガード"],
  ["walk-forward gate", "ウォークフォワード検証"],
  ["expectancy gate", "期待値ゲート"],
  ["context validation", "文脈検証"],
  ["bandit guard hold", "バンディット制御による見送り"],
  ["pattern quality", "パターン品質"],
  ["benchmark gate", "ベンチマーク判定"],
  ["anomaly block", "異常検知ブロック"],
  ["High-impact news risk lock", "重要ニュース保護"],
  ["High volatility spread safeguard", "高ボラ時スプレッド保護"],
  ["position size below minimum", "最小取引数量未満"],
  ["risk cap below minimum size", "リスク上限で最小数量未満"],
  ["Daily stop reached", "日次損失上限に到達"],
  ["expected value", "期待値"],
  ["risk/reward", "損益比率"],
  ["blocked", "ブロック"]
];

function translateReasonJa(value) {
  if (value === null || value === undefined || value === "") return "-";
  let s = Array.isArray(value)
    ? value.map((x) => translateReasonJa(x)).join("、")
    : String(value);
  for (const [en, ja] of REASON_TRANSLATIONS) {
    s = s.replaceAll(en, ja);
  }
  return s;
}

function statusJa(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pass") return "通過";
  if (s === "warning") return "注意";
  if (s === "blocked") return "ブロック";
  if (s === "hold") return "見送り";
  if (s === "probe") return "小ロット候補";
  if (s === "trade") return "取引";
  return translateReasonJa(status || "-");
}

function stageNameJa(name) {
  const table = {
    market_input: "市場データ",
    signal_generation: "シグナル生成",
    multi_timeframe: "複数時間足確認",
    entry_evidence: "エントリー根拠",
    trend_up_entry_quality: "エントリー位置",
    pre_trade_guard: "取引前ガード",
    reentry_guard: "再エントリー制御",
    position_sizing: "ロット計算",
    execution_tail_gate: "約定品質確認",
    final_decision: "最終判断"
  };
  return table[String(name || "")] || translateReasonJa(name || "-");
}

function statusToneClass(value) {
  const s = String(value || "").toLowerCase();
  if (["buy", "running", "true", "pass", "trade", "good"].includes(s)) return "tone-good";
  if (["sell"].includes(s)) return "tone-sell";
  if (["blocked", "block", "error", "false", "bad"].includes(s)) return "tone-bad";
  if (["warning", "pending", "cooldown", "warn"].includes(s)) return "tone-warn";
  if (["probe", "info"].includes(s)) return "tone-info";
  return "tone-neutral";
}

function scoreLevel(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return { label: "-", cls: "tone-neutral" };
  if (n >= 0.75) return { label: "強い", cls: "tone-good" };
  if (n >= 0.6) return { label: "候補", cls: "tone-info" };
  if (n >= 0.45) return { label: "弱い", cls: "tone-warn" };
  return { label: "見送り", cls: "tone-bad" };
}

function setToneText(id, value, toneValue = value) {
  const el = window.getElSafe ? window.getElSafe(id) : $(id);
  if (!el) return;
  el.textContent = value;
  el.classList.remove("tone-good", "tone-sell", "tone-bad", "tone-warn", "tone-info", "tone-neutral");
  el.classList.add(statusToneClass(toneValue));
}

function sourceJa(source) {
  if (source === "auto") return "自動";
  if (source === "manual") return "手動";
  return source || "-";
}

function tfJa(tf) {
  if (tf === "5m") return "5分足";
  if (tf === "15m") return "15分足";
  if (tf === "1h") return "1時間足";
  if (tf === "1d") return "日足";
  return "1分足";
}

function newsHeadlineJa(item) {
  if (item?.headlineJa) return item.headlineJa;
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const score = Number(item?.sentimentScore || 0);
  const impact = item?.impact || "MEDIUM";
  const type = tags.includes("GEOPOLITICAL")
    ? "地政学ニュース"
    : (tags.includes("POLITICAL")
      ? "政治ニュース"
      : (tags.includes("MACRO") ? "経済指標ニュース" : "為替関連ニュース"));
  const dir = score >= 0.2 ? "ドル円上方向" : (score <= -0.2 ? "ドル円下方向" : "方向中立");
  return `自動要約: ${type} / 重要度:${impact} / ${dir}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveNewsFactorJa(item) {
  const h = String(item?.headline || "").toLowerCase();
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  if (h.includes("fomc") || h.includes("federal reserve") || h.includes("frb") || h.includes("fed")) {
    return "米金融政策（FRB/FOMC）";
  }
  if (h.includes("boj") || h.includes("bank of japan") || h.includes("日銀")) {
    return "日銀・日本金融政策";
  }
  if (h.includes("cpi") || h.includes("inflation") || h.includes("雇用") || h.includes("nfp") || h.includes("gdp")) {
    return "米日マクロ指標";
  }
  if (tags.includes("GEOPOLITICAL")) return "地政学リスク";
  if (tags.includes("POLITICAL")) return "政治・政策動向";
  if (tags.includes("MACRO")) return "マクロ経済イベント";
  return "為替関連ヘッドライン";
}

function resolveNewsEffectJa(item) {
  const score = Number(item?.sentimentScore || 0);
  const impact = String(item?.impact || "MEDIUM");
  if (score >= 0.2) {
    return impact === "HIGH"
      ? "ドル円は上振れ圧力。短期は上方向優位だが急変動に注意。"
      : "ドル円は上振れ圧力。短期は押し目買い優位の可能性。";
  }
  if (score <= -0.2) {
    return impact === "HIGH"
      ? "ドル円は下振れ圧力。短期は下方向優位だが急変動に注意。"
      : "ドル円は下振れ圧力。戻り売り優位の可能性。";
  }
  if (impact === "HIGH") return "方向感は中立。重要度が高く短期ボラ拡大の可能性。";
  return "方向感は中立。短期は様子見優先。";
}

function positionUnitsText(qty) {
  const n = Number(qty || 0);
  if (!(n > 0)) return "-";
  return formatUnits(n);
}

function autoLastActionJa(v) {
  const s = String(v || "");
  if (s === "HOLD") return "見送り";
  if (s === "REJECTED") return "注文拒否";
  if (s === "RUNNING") return "稼働中";
  if (s === "STOP_PENDING") return "停止予約中(最適決済待ち)";
  if (s === "STOP_OPTIMAL") return "最適決済完了で停止";
  if (s === "ERROR") return "エラー";
  if (s.startsWith("COOLDOWN:")) return `連敗保護で待機 (${s.split(":")[1] || "-"})`;
  if (s.startsWith("OPEN:")) return `新規建て (${s.split(":").slice(1).join(":")})`;
  if (s.startsWith("CLOSE:")) return `決済 (${s.split(":")[1]}件)`;
  if (s.startsWith("STOP:")) return `停止 (${s.split(":")[1]}件クローズ)`;
  return s || "-";
}

async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function setText(id, value) {
  if (window.setTextSafe) {
    window.setTextSafe(id, value);
    return;
  }
  const el = $(id);
  if (el) el.textContent = value;
}

function judgeText(value, goodCond, warnCond) {
  if (goodCond(value)) return "良好";
  if (warnCond(value)) return "注意";
  return "要警戒";
}

function jaEntryCategory(value) {
  const v = String(value || "").toUpperCase();
  if (v.includes("VALID_PULLBACK")) return "押し目良好";
  if (v.includes("BREAKOUT")) return "ブレイク候補";
  if (v.includes("LATE")) return "遅れ気味";
  if (v.includes("OVEREXTENDED")) return "高値/安値追い注意";
  if (v.includes("NO_PULLBACK")) return "押し目不足";
  if (v.includes("PROBE")) return "低レート検証";
  if (v.includes("WEAK")) return "根拠弱め";
  if (v.includes("STRONG")) return "通常候補";
  if (v.includes("BLOCK")) return "見送り";
  return value || "-";
}

function tradePermissionText(st) {
  const blocked = st?.positionSizingDiagnostics?.blockedReason;
  if (blocked) return "注文不可";
  const score = Number(st?.entryEvidenceScore ?? st?.entryEvidenceBreakdown?.totalScore);
  if (!Number.isFinite(score)) return st?.lastSkipReason ? "見送り中" : "-";
  if (score >= 0.75) return "通常候補";
  if (score >= 0.6) return "低レート候補";
  if (score >= 0.45) return "見送り候補";
  return "根拠不足";
}

function renderDiagnostics() {
  const st = runtimeDiag.autoStatus || {};
  const ex = runtimeDiag.executionStats || {};
  const lm = runtimeDiag.learningStatus || {};
  const modeMap = { BASE: "通常", SEMI: "準攻撃", FULL: "攻撃" };
  const mode = String(st.tradeMode || "-").toUpperCase();
  const rescueStage = Number(st.rollingRescueStage || 0);
  const edgeScore = Number(st.edgeSizing?.edgeScore || 0);
  const execQuality = Number(st.edgeSizing?.executionQualityScore || 0);
  const tailPenalty = Number(st.edgeSizing?.tailPenaltyMultiplier || 1);
  const riskBrake = Number(st.edgeSizing?.modeRiskBrakeMultiplier || 1);
  const expR = Number(st.rollingExpectancy?.expectancyR || 0);
  const pf = Number(st.rollingExpectancy?.profitFactor || 0);
  const p95 = Number(ex.p95PipelineLatencyMs || 0);
  const p99 = Number(ex.p99PipelineLatencyMs || 0);
  const rejectRate = Number(ex.rejectRate || 0);
  const slip95 = Number(ex.p95SlippagePips || 0);
  const entryEvidence = st.entryEvidenceBreakdown || {};
  const entryLocation = st.entryLocationDiagnostics || {};
  const mtf = st.multiTimeframeDiagnostics || {};
  const trendEntry = st.trendUpEntryQuality || {};
  const evidenceScore = Number(st.entryEvidenceScore ?? entryEvidence.totalScore);
  const locationScore = Number(st.entryLocationScore ?? entryLocation.entryLocationScore);
  const mtfScore = Number(st.multiTimeframeScore ?? mtf.multiTimeframeScore);

  setText("diagTradeMode", modeMap[mode] || mode || "-");
  setText("diagRescueStage", rescueStage > 0 ? `第${rescueStage}段階` : "通常");
  setText("diagEdgeScore", `${fmt(edgeScore, 3)} (${judgeText(edgeScore, (v) => v >= 1.2, (v) => v >= 1.0)})`);
  setText("diagExecQuality", `${fmt(execQuality, 3)} (${judgeText(execQuality, (v) => v >= 0.85, (v) => v >= 0.75)})`);
  setText("diagTailPenalty", `${fmt(tailPenalty, 3)} (${judgeText(tailPenalty, (v) => v >= 0.9, (v) => v >= 0.75)})`);
  setText("diagRiskBrake", `${fmt(riskBrake, 3)} (${judgeText(riskBrake, (v) => v >= 0.95, (v) => v >= 0.8)})`);
  setText("diagRolling", `ExpR ${fmt(expR, 3)} / PF ${fmt(pf, 2)}`);
  setText("diagKill", `${fmt((Number(st.killSwitch?.ddRatio || 0) * 100), 2)}% / ${fmt(st.killSwitch?.trailingLosses || 0, 0)}`);
  setText("diagP95P99", `${fmt(p95, 0)} / ${fmt(p99, 0)} ms`);
  setText("diagRejectRate", `${fmt(rejectRate * 100, 2)}% (${judgeText(rejectRate, (v) => v <= 0.05, (v) => v <= 0.1)})`);
  setText("diagSlipP95", `${fmt(slip95, 3)} pips`);
  setText("diagTelemetryN", fmt(ex.sampleSize || 0, 0));
  setText("diagEvidence", `${fmt(evidenceScore, 3)} / ${jaEntryCategory(entryEvidence.finalCategory)}`);
  setText("diagEntryLocation", `${fmt(locationScore, 3)} / ${jaEntryCategory(entryLocation.entryLocationCategory)}`);
  setText("diagMtf", `${fmt(mtfScore, 3)} / 整合 ${fmt(mtf.shortTermAlignmentScore, 3)} / 過熱 ${fmt(mtf.shortTermExhaustionScore, 3)}`);
  setText(
    "diagTrendEntry",
    `${jaEntryCategory(trendEntry.entryTimingCategory || entryLocation.entryLocationCategory)}${trendEntry.entryDelayRisk ? " / 遅れ注意" : ""}${trendEntry.overextendedAtEntry ? " / 過熱注意" : ""}`
  );
  setText("decisionTraceText", JSON.stringify(st.decisionTrace || {}, null, 2));
  setText("sizingTraceText", JSON.stringify(st.sizingTrace || {}, null, 2));
  setText("noActionableTraceText", JSON.stringify(st.noActionableSignalDiagnostics || {}, null, 2));
  const eligibility = st.eligibility || {};
  setText(
    "diagEligibility",
    `モード可否: 通常=${eligibility.base?.eligible ? "可" : "不可"} / 準攻撃=${eligibility.semi?.eligible ? "可" : "不可"} / 攻撃=${eligibility.full?.eligible ? "可" : "不可"}`
  );
  setText(
    "diagLearningMemory",
    `学習メモリ: 件数=${fmt(lm.learningMemory?.totalTrades || 0, 0)} / EWMA期待値=${fmt(lm.learningMemory?.ewmaExpectancyJpy || 0, 1)}円 / EWMA PF=${fmt(lm.learningMemory?.ewmaProfitFactor || 0, 2)}`
  );
}

function renderTicker(t) {
  latestTicker = t;
  setText("bid", fmt(t.bid, 3));
  setText("ask", fmt(t.ask, 3));
  setText("spread", fmt(t.spreadPips, 2));
  const mid = (Number(t.bid) + Number(t.ask)) / 2;
  setText("mid", fmt(mid, 3));
  const delta = lastMidPrice === null ? 0 : (mid - lastMidPrice);
  const deltaPips = delta / 0.01;
  const deltaEl = $("tickDelta");
  if (deltaEl) {
    deltaEl.textContent = `${delta >= 0 ? "+" : ""}${fmt(deltaPips, 2)} pips`;
    deltaEl.style.color = delta >= 0 ? "#dc2626" : "#2563eb";
  }
  renderQuoteBoard(mid, Number(t.spreadPips || 0.2));
  lastMidPrice = mid;
  const ms = t.marketStatus || {};
  const marketOpenEl = $("marketOpen");
  const marketSourceEl = $("marketSource");
  if (marketOpenEl) marketOpenEl.textContent = ms.fxOpen ? "OPEN" : "CLOSE";
  if (marketSourceEl) marketSourceEl.textContent = ms.source || "-";
  const tsText = t.ts ? formatJstDateTime(new Date(t.ts)) : "配信中";
  setText("tickerTs", `${tsText} / ${ms.realtime ? "リアルタイム" : "非リアルタイム"}`);
  const costProfile = $("costProfile");
  if (costProfile) {
    costProfile.textContent = `${BROKER_LABEL} / 基準スプレッド ${fmt(BASELINE_SPREAD_PIPS, 2)} pips / 現在 ${fmt(Number(t.spreadPips || BASELINE_SPREAD_PIPS), 2)} pips`;
  }
  renderPositions(chartState.positions);
  syncChartPriceRangeToLatestTicker();
}

function renderQuoteBoard(mid, spreadPips) {
  const el = $("quoteBoard");
  if (!el || !Number.isFinite(mid)) return;
  const pip = 0.01;
  const spread = Math.max(0.05, Number(spreadPips || 0.2));
  const rows = [];
  for (let i = 3; i >= 1; i -= 1) {
    const p = mid + ((spread / 2) + i * 0.12) * pip;
    const w = 28 + i * 18;
    rows.push({ side: "ASK", price: p, width: w, cls: "ask" });
  }
  rows.push({ side: "ASK", price: mid + (spread / 2) * pip, width: 84, cls: "ask" });
  rows.push({ side: "BID", price: mid - (spread / 2) * pip, width: 84, cls: "bid" });
  for (let i = 1; i <= 3; i += 1) {
    const p = mid - ((spread / 2) + i * 0.12) * pip;
    const w = 28 + i * 18;
    rows.push({ side: "BID", price: p, width: w, cls: "bid" });
  }
  el.innerHTML = rows.map((r) => `
    <div class="quote-row">
      <div class="quote-side ${r.cls}">${r.side}</div>
      <div class="quote-bar ${r.cls}"><i style="width:${Math.min(96, r.width)}%"></i></div>
      <div class="quote-price">${fmt(r.price, 3)}</div>
    </div>
  `).join("");
}

function renderSignal(s) {
  const actionEl = $("action");
  setText("action", actionJa(s.action));
  applySignalTone(actionEl, s.action);
  setText("confidence", fmt((s.confidence || 0) * 100, 1) + "%");
  setText("regime", regimeJa(s.regime));
  setText("signalUpdatedAt", s.ts ? formatJstDateTime(new Date(s.ts)) : "-");
  setText("signalMarketTs", s.marketTimestamp ? formatJstDateTime(new Date(s.marketTimestamp)) : "-");
  setText("signalInputHash", s.decisionInputHash ? String(s.decisionInputHash).slice(0, 12) : "-");
  setText("rationale", rationaleJa(s.rationale || "-"));
  renderHoldReasonTags(s);
  setText("entry", fmt(s.entryPrice, 3));
  setText("sl", fmt(s.stopLossPrice, 3));
  setText("tp", fmt(s.takeProfitPrice, 3));
  setText("learning", s.adaptive
    ? `学習サンプル=${fmt(s.adaptive.sampleSize, 0)} / 期待損益=${fmt(s.adaptive.expectancyJpy, 1)}円 / リスク補正=${fmt(s.adaptive.riskMultiplier, 2)}倍`
    : "-");
  const newsBiasEl = $("newsBias");
  if (s.news) {
    const direction = String(s.news.directionBias || "NEUTRAL");
    const icon = direction === "BUY" ? "▲" : (direction === "SELL" ? "▼" : "■");
    setText("newsBias", `${icon}${actionJa(direction)}（ニューススコア=${fmt(s.news.score, 2)} / 短期リスク=${fmt((s.news.shortTermRiskLevel || 0) * 100, 0)}%）`);
    applySignalTone(newsBiasEl, direction);
  } else {
    setText("newsBias", "-");
    applySignalTone(newsBiasEl, "NEUTRAL");
  }
}

function renderHoldReasonTags(signal) {
  const el = $("holdReasonTags");
  if (!el) return;
  const chips = inferSignalReasonChips(signal);
  el.innerHTML = chips.map((c) => `<span class="reason-chip ${escapeHtml(c.type)}">${escapeHtml(c.label)}</span>`).join("");
}

function inferSignalReasonChips(signal) {
  const text = `${String(signal?.rationale || "")} ${(Array.isArray(signal?.safetyFlags) ? signal.safetyFlags.join(" ") : "")}`.toLowerCase();
  const chips = [];
  const add = (type, label) => {
    if (!chips.some((x) => x.type === type)) chips.push({ type, label });
  };
  if (String(signal?.action || "").toUpperCase() !== "HOLD") {
    add("info", "エントリー条件あり");
    return chips;
  }
  if (text.includes("spread")) add("spread", "スプレッド要因");
  if (text.includes("expectancy") || text.includes("期待値")) add("expectancy", "期待値不足");
  if (text.includes("edge") || text.includes("no trade signal") || text.includes("range edge")) add("edge", "優位性不足");
  if (text.includes("news")) add("news", "ニュース警戒");
  if (text.includes("latency") || text.includes("slippage") || text.includes("reject") || text.includes("execution")) add("execution", "約定条件悪化");
  if (text.includes("kill") || text.includes("drawdown") || text.includes("consecutive") || text.includes("cooldown")) add("risk", "リスク保護");
  if (!chips.length) add("info", "見送り（条件未達）");
  return chips.slice(0, 3);
}

function applySignalTone(el, direction) {
  if (!el) return;
  el.classList.remove("signal-buy", "signal-sell", "signal-neutral");
  if (direction === "BUY") {
    el.classList.add("signal-buy");
    return;
  }
  if (direction === "SELL") {
    el.classList.add("signal-sell");
    return;
  }
  el.classList.add("signal-neutral");
}

function formatSkipReasonTop(summary, status = null) {
  const top = Array.isArray(summary?.top) ? summary.top : [];
  if (!top.length) {
    const last = String(status?.lastSkipReason || "").trim();
    if (last) return `現在: ${rationaleJa(last)}`;
    return "なし";
  }
  return top.slice(0, 3)
    .map((x) => `${rationaleJa(String(x?.reason || "-"))} (${fmt(x?.count || 0, 0)})`)
    .join(" / ");
}

function renderAccount(a) {
  setText("initial", fmt(a.initialBalanceJpy, 0));
  setText("current", fmt(a.currentBalanceJpy, 0));
  const dayPnlEl = $("dayPnl");
  if (dayPnlEl) {
    const v = Number(a.dayPnlJpy || 0);
    dayPnlEl.textContent = `${v >= 0 ? "+" : ""}${fmt(v, 0)}`;
    dayPnlEl.classList.remove("pnl-pos", "pnl-neg");
    dayPnlEl.classList.add(v >= 0 ? "pnl-pos" : "pnl-neg");
  }
}

function renderSummary(m) {
  setText("mTrades", m.totalTrades);
  setText("mWinRate", fmt((m.winRate || 0) * 100, 1) + "%");
  setText("mNet", fmt(m.netProfitJpy, 0));
  setText("mPf", m.profitFactor === null ? "-" : fmt(m.profitFactor, 2));
}

function renderEventImpact(data) {
  const rows = $("eventImpactRows");
  if (!rows) return;
  rows.innerHTML = "";
  const tagItems = Array.isArray(data?.tagItems) ? data.tagItems : [];
  const eventItems = Array.isArray(data?.eventItems) ? data.eventItems : [];
  const merged = [
    ...tagItems.slice(0, 6).map((x) => ({ kind: "tag", key: x.tag, ...x })),
    ...eventItems.slice(0, 8).map((x) => ({ kind: "event", key: x.eventId, ...x }))
  ];
  for (const item of merged) {
    const tr = document.createElement("tr");
    const label = item.kind === "tag" ? `TAG:${item.key}` : `EVT:${item.key}`;
    tr.innerHTML = `
      <td>${label}</td>
      <td>${fmt(item.totalTrades, 0)}</td>
      <td>${fmt((item.winRate || 0) * 100, 1)}%</td>
      <td><span class="pnl-badge ${Number(item.netProfitJpy || 0) >= 0 ? "pnl-pos" : "pnl-neg"}">${fmt(item.netProfitJpy, 2)}</span></td>
      <td>${item.profitFactor === null ? "-" : fmt(item.profitFactor, 2)}</td>
    `;
    rows.appendChild(tr);
  }
  if (!merged.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">イベント連携データなし</td>`;
    rows.appendChild(tr);
  }
}

function renderTrades(items) {
  const rows = $("tradeRows");
  rows.innerHTML = "";
  for (const t of items) {
    const tr = document.createElement("tr");
    const pnlClass = t.netPnlJpy >= 0 ? "pnl-pos" : "pnl-neg";
    const pnlText = `${t.netPnlJpy >= 0 ? "+" : ""}${fmt(t.netPnlJpy, 2)}`;
    tr.innerHTML = `
      <td>${formatJstDateTime(new Date(t.exitTime))}</td>
      <td>${actionJa(t.side)}</td>
      <td>${fmt(t.entryPrice, 3)}</td>
      <td>${fmt(t.exitPrice, 3)}</td>
      <td>${positionUnitsText(t.qty)}</td>
      <td><span class="pnl-badge ${pnlClass}">${pnlText}</span></td>
    `;
    rows.appendChild(tr);
  }
}

function renderPositions(items) {
  const rows = $("positionRows");
  if (!rows) return;
  rows.innerHTML = "";
  let count = 0;
  for (const p of items) {
    if (p.status !== "OPEN") continue;
    count += 1;
    const est = estimateOpenPnlJpy(p, latestTicker);
    const estText = est === null ? "-" : `${est >= 0 ? "+" : ""}${fmt(est, 2)} 円`;
    const estClass = est === null ? "" : (est >= 0 ? "pnl-pos" : "pnl-neg");
    const card = document.createElement("article");
    card.className = "position-card";
    card.innerHTML = `
      <div class="position-card-head">
        <strong>${p.side === "LONG" ? "買い" : "売り"}</strong>
        <span>${sourceJa(p.source)}</span>
      </div>
      <div class="position-card-grid">
        <div><span>開始</span><b>${formatJstDateTime(new Date(p.openedAt))}</b></div>
        <div><span>エントリー</span><b>${fmt(p.entryPrice, 3)}</b></div>
        <div><span>取引数量</span><b>${positionUnitsText(p.qty)}</b></div>
        <div><span>評価損益</span><b class="${estClass} ${est !== null ? "pnl-badge" : ""}">${estText}</b></div>
        <div><span>TP</span><b>${fmt(p.takeProfitPrice, 3)}</b></div>
        <div><span>SL</span><b>${fmt(p.stopLossPrice, 3)}</b></div>
        <div><span>予定決済</span><b>${p.closeDueAt ? formatJstTime(new Date(p.closeDueAt)) : "-"}</b></div>
      </div>
      <div class="position-card-actions">
        <button type="button" class="close-pos-btn" data-position-id="${p.id}">決済</button>
      </div>
    `;
    rows.appendChild(card);
  }
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "mono";
    empty.textContent = "現在、保有ポジションはありません。";
    rows.appendChild(empty);
  }
}

function estimateOpenPnlJpy(position, ticker) {
  if (!ticker) return null;
  const qty = Number(position?.qty || 0);
  const entry = Number(position?.entryPrice || 0);
  if (!(qty > 0) || !(entry > 0)) return null;

  const closePx = position.side === "LONG" ? Number(ticker.bid) : Number(ticker.ask);
  if (!Number.isFinite(closePx)) return null;

  const gross = position.side === "LONG"
    ? (closePx - entry) * qty
    : (entry - closePx) * qty;
  const exitFee = ((closePx * qty) * EST_FEE_BPS) / 10000;
  const entryFee = Number(position?.entryFeeJpy || 0);
  return Number((gross - exitFee - entryFee).toFixed(2));
}

function renderNews(items, status) {
  const rows = $("newsRows");
  if (!rows) return;
  rows.innerHTML = "";
  const filtered = filterNewsItems(items, chartState.newsTab).slice(0, 30);
  for (const n of filtered) {
    const ts = n.ts
      ? new Date(n.ts).toLocaleString("ja-JP", {
        timeZone: JST_TZ,
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      })
      : "-";
    const impact = String(n.impact || "MEDIUM");
    const factor = resolveNewsFactorJa(n);
    const effect = resolveNewsEffectJa(n);
    const source = String(n.source || "-").replace(/^https?:\/\//, "");
    const country = String(n.country || "GLOBAL");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="news-time">${escapeHtml(ts)}</td>
      <td><span class="news-impact-badge news-impact-${impact.toLowerCase()}">${escapeHtml(impact)}</span></td>
      <td class="news-summary-cell">
        <div class="news-factor">要因: ${escapeHtml(factor)}</div>
        <div class="news-effect">影響: ${escapeHtml(effect)}</div>
      </td>
      <td class="news-source">${escapeHtml(source)}<br><span class="news-country">${escapeHtml(country)}</span></td>
    `;
    rows.appendChild(tr);
  }
  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">該当ニュースはありません</td>`;
    rows.appendChild(tr);
  }

  const st = $("newsStatus");
  if (st && status) {
    const base = status.lastSuccessAt
      ? `更新=${formatJstTime(new Date(status.lastSuccessAt), true)} 取得=${status.lastFetchedCount}件 新規反映=${status.lastInsertedCount}件 重複=${status.lastMatchedCount || 0}件 判定反映中=${status.decisionActiveCount || 0}件`
      : "収集中...";
    st.textContent = status.lastError ? `${base} エラー=${status.lastError}` : base;
  }
}

function filterNewsItems(items, tab) {
  const list = Array.isArray(items) ? items : [];
  const sourceCountry = (n) => {
    const s = String(n?.source || "").toLowerCase();
    if (s.includes("nhk.or.jp") || s.includes("jiji.com")) return "JP";
    if (s.includes("federalreserve.gov") || s.includes("whitehouse.gov") || s.includes("treasury.gov") || s.includes("bls.gov") || s.includes("bea.gov")) return "US";
    return "GLOBAL";
  };
  if (tab === "jp") {
    return list.filter((n) => String(n.country || sourceCountry(n)).includes("JP"));
  }
  if (tab === "us") {
    return list.filter((n) => String(n.country || sourceCountry(n)).includes("US"));
  }
  if (tab === "high") {
    return list.filter((n) => String(n.impact || "") === "HIGH");
  }
  return list;
}

function renderChart(candles, positions = [], trades = [], tf = chartState.tf) {
  if (!candles.length) return;
  if (!ensureChartReady()) return;
  const normalized = normalizeCandlesForChart(candles);
  const tfCandles = aggregateCandlesForTimeframe(normalized, tf);
  const trimmedCandles = trimChartView(tfCandles, tf);
  const viewCandles = (tf === "1h" || tf === "1d")
    ? sanitizeCandlesForDisplay(trimmedCandles, tf)
    : trimmedCandles;
  if (chartRuntime.fallbackMode) {
    renderFallbackChart(viewCandles, positions, trades, tf);
    updateChartInfo(viewCandles, tf);
    return;
  }

  const candleData = buildColoredCandleData(viewCandles, tf);
  const ma10Data = buildMaData(viewCandles, 10);
  const ma25Data = buildMaData(viewCandles, 25);
  const ma75Data = buildMaData(viewCandles, 75);

  const volumeData = candleData.map((c) => ({
    time: c.time,
    value: Math.max(1, Number(((Math.abs(Number(c.high) - Number(c.low)) / 0.01) * 100).toFixed(0))),
    color: c._isUp ? "rgba(255,90,87,0.28)" : "rgba(63,169,255,0.28)"
  }));

  try {
    chartRuntime.candleSeries.setData(candleData);
    chartRuntime.volumeSeries.setData(volumeData);
    chartRuntime.ma10Series.setData(ma10Data);
    chartRuntime.ma25Series.setData(ma25Data);
    chartRuntime.ma75Series.setData(ma75Data);
    applyChartViewport(tf, candleData, viewCandles, {
      ma10Data,
      ma25Data,
      ma75Data
    });
    updateChartMeta();
  } catch (err) {
    chartRuntime.fallbackMode = true;
    renderFallbackChart(viewCandles, positions, trades, tf);
    const meta = $("chartMeta");
    if (meta) meta.textContent = `描画を安定化するためフォールバック表示中: ${String(err?.message || err)}`;
    return;
  }
  // Hide entry/exit overlays for cleaner chart readability.
  syncPriceLines([]);
  if (typeof chartRuntime.candleSeries.setMarkers === "function") {
    chartRuntime.candleSeries.setMarkers([]);
  }

  const title = $("chartTitle");
  if (title) title.textContent = `価格チャート(${tfJa(tf)})`;
  updateChartHeader(candles);
  updateChartInfo(viewCandles, tf);
}

function clearChartSeriesForLoading() {
  if (chartRuntime.fallbackMode) return;
  if (!chartRuntime.chart) return;
  try {
    chartRuntime.candleSeries?.setData?.([]);
    chartRuntime.volumeSeries?.setData?.([]);
    chartRuntime.ma10Series?.setData?.([]);
    chartRuntime.ma25Series?.setData?.([]);
    chartRuntime.ma75Series?.setData?.([]);
    syncPriceLines([]);
    if (typeof chartRuntime.candleSeries?.setMarkers === "function") {
      chartRuntime.candleSeries.setMarkers([]);
    }
  } catch {
    // no-op; next render will recover.
  }
}

function resetChartViewportForTf(tf) {
  if (!chartRuntime.chart) return;
  const barSpacing = Number(CHART_BAR_SPACING[tf] || 8);
  const margins = CHART_PRICE_SCALE_MARGINS[tf] || CHART_PRICE_SCALE_MARGINS["1m"];
  chartRuntime.chart.timeScale().applyOptions({
    barSpacing,
    rightOffset: 2
  });
  chartRuntime.chart.priceScale("right").applyOptions({
    autoScale: true,
    scaleMargins: margins
  });
  if (typeof chartRuntime.chart.timeScale().fitContent === "function") {
    chartRuntime.chart.timeScale().fitContent();
  }
}

function ensureChartReady() {
  if (chartRuntime.chart) return true;
  const container = $("priceChart");
  if (!container) return false;
  const LW = window.LightweightCharts;
  if (!LW || typeof LW.createChart !== "function") {
    chartRuntime.fallbackMode = true;
    if (!$("priceChartSvg")) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("id", "priceChartSvg");
      svg.setAttribute("viewBox", "0 0 700 300");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.width = "100%";
      svg.style.height = "100%";
      container.innerHTML = "";
      container.appendChild(svg);
    }
    return true;
  }

  chartRuntime.chart = LW.createChart(container, {
    width: container.clientWidth || 700,
    height: container.clientHeight || 300,
    layout: {
      background: { color: "#0b1220" },
      textColor: "#94a3b8"
    },
    grid: {
      vertLines: { color: "rgba(31,41,55,0.85)" },
      horzLines: { color: "rgba(31,41,55,0.85)" }
    },
    rightPriceScale: {
      borderColor: "#334155",
      // GMO風に価格帯を読みやすくするため、余白をややタイト化。
      scaleMargins: { top: 0.06, bottom: 0.22 }
    },
    timeScale: {
      borderColor: "#334155",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 3,
      barSpacing: 8,
      tickMarkFormatter: (time) => formatChartTickJst(time)
    },
    localization: {
      locale: "ja-JP",
      timeFormatter: (time) => formatChartTimeJst(time)
    },
    handleScroll: false,
    handleScale: false,
    crosshair: {
      vertLine: { color: "rgba(148,163,184,0.5)" },
      horzLine: { color: "rgba(148,163,184,0.5)" }
    }
  });

  chartRuntime.candleSeries = chartRuntime.chart.addCandlestickSeries({
    upColor: "#ff4d57",
    downColor: "#3aa9ff",
    borderVisible: true,
    wickUpColor: "#ff4d57",
    wickDownColor: "#3aa9ff",
    borderUpColor: "#ff4d57",
    borderDownColor: "#3aa9ff",
    priceLineVisible: true
  });
  chartRuntime.volumeSeries = chartRuntime.chart.addHistogramSeries({
    color: "rgba(148,163,184,0.25)",
    priceFormat: { type: "volume" },
    priceScaleId: "volume"
  });
  chartRuntime.chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 }
  });

  chartRuntime.ma10Series = chartRuntime.chart.addLineSeries({ color: "#f0875b", lineWidth: 1.8, priceLineVisible: false });
  chartRuntime.ma25Series = chartRuntime.chart.addLineSeries({ color: "#95e45f", lineWidth: 1.8, priceLineVisible: false });
  chartRuntime.ma75Series = chartRuntime.chart.addLineSeries({ color: "#62dff0", lineWidth: 1.8, priceLineVisible: false });
  chartRuntime.chart.subscribeCrosshairMove((param) => {
    const point = param?.seriesData?.get?.(chartRuntime.candleSeries);
    if (!point) return;
    const time = formatChartTime(param.time);
    const text = `${time} O:${fmt(point.open, 3)} H:${fmt(point.high, 3)} L:${fmt(point.low, 3)} C:${fmt(point.close, 3)}`;
    const el = $("chartInfo");
    if (el) el.textContent = text;
  });

  chartRuntime.resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    chartRuntime.chart.applyOptions({
      width: Math.max(320, Math.floor(rect.width)),
      height: Math.max(220, Math.floor(rect.height))
    });
  });
  chartRuntime.resizeObserver.observe(container);
  return true;
}

function renderFallbackChart(candles, positions = [], trades = [], tf = chartState.tf) {
  const svg = $("priceChartSvg");
  if (!svg) return;
  const w = 700;
  const h = 300;
  const padLeft = 24;
  const padRight = 56;
  const padTop = 10;
  const padBottom = 24;
  const vr = buildVisiblePriceRange(candles, tf) || {
    from: Math.min(...candles.map((c) => Number(c.low))),
    to: Math.max(...candles.map((c) => Number(c.high)))
  };
  const min = Number(vr.from);
  const max = Number(vr.to);
  const span = Math.max(0.0001, max - min);
  const toY = (v) => h - padBottom - ((Number(v) - min) / span) * (h - padTop - padBottom);
  const step = (w - padLeft - padRight) / Math.max(1, candles.length - 1);
  const colored = buildColoredCandleData(candles, tf);
  let html = `<rect x="0" y="0" width="${w}" height="${h}" fill="#0b1220"/>`;
  for (let i = 0; i < colored.length; i += 1) {
    const c = colored[i];
    const x = padLeft + i * step;
    const color = c._isUp ? "#ff4d57" : "#3aa9ff";
    const yH = toY(c.high);
    const yL = toY(c.low);
    const yO = toY(c.open);
    const yC = toY(c.close);
    html += `<line x1="${x}" y1="${yH}" x2="${x}" y2="${yL}" stroke="${color}" stroke-width="1"/>`;
    html += `<rect x="${x - 2}" y="${Math.min(yO, yC)}" width="4" height="${Math.max(1, Math.abs(yC - yO))}" fill="${color}"/>`;
  }
  for (const p of positions.filter((p) => p.status === "OPEN")) {
    html += `<line x1="${padLeft}" y1="${toY(p.entryPrice)}" x2="${w - padRight}" y2="${toY(p.entryPrice)}" stroke="#38bdf8" stroke-dasharray="3 3"/>`;
  }
  const marks = trades.slice(0, 12);
  for (const t of marks) {
    const idx = Math.max(0, candles.length - 1 - marks.indexOf(t) * 2);
    const x = padLeft + idx * step;
    html += `<circle cx="${x}" cy="${toY(t.exitPrice || t.entryPrice)}" r="2.2" fill="${t.netPnlJpy >= 0 ? "#22c55e" : "#ef4444"}"/>`;
  }
  html += `<text x="${padLeft}" y="14" fill="#94a3b8" font-size="10">Fallback ${tf}</text>`;
  svg.innerHTML = html;
  const meta = $("chartMeta");
  if (meta) meta.textContent = "RSI/MACDはライブラリ読み込み時のみ表示されます";
}

function toUnixTime(ts) {
  const ms = new Date(ts || Date.now()).getTime();
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

function normalizeCandlesForChart(candles) {
  const merged = new Map();
  for (const c of candles) {
    let t = toUnixTime(c.ts);
    if (!Number.isFinite(t) || t <= 0) t = Math.floor(Date.now() / 1000);
    const key = String(t);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (![open, high, low, close].every((v) => Number.isFinite(v))) continue;
    merged.set(key, {
      time: t,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close
    });
  }
  return Array.from(merged.values())
    .sort((a, b) => a.time - b.time)
    .map((c) => ({
      time: c.time,
      open: Number(c.open),
      high: Number(Math.max(c.high, c.open, c.close).toFixed(6)),
      low: Number(Math.min(c.low, c.open, c.close).toFixed(6)),
      close: Number(c.close)
    }));
}

function buildColoredCandleData(candles, tf) {
  return candles.map((c, i) => {
    const prev = candles[i - 1];
    const open = Number(c.open);
    const close = Number(c.close);
    const prevClose = Number(prev?.close);
    // Keep wick/body direction visually separated even on doji candles.
    let isUp = close > open;
    if (Math.abs(close - open) < 1e-9) {
      if (Number.isFinite(prevClose)) isUp = close >= prevClose;
      else isUp = true;
    }
    if (tf === "1d" && Number.isFinite(prevClose)) {
      isUp = close >= prevClose;
    }
    const color = isUp ? "#ff4d57" : "#2f9dff";
    return {
      time: c.time,
      open,
      high: Number(c.high),
      low: Number(c.low),
      close,
      color,
      borderColor: color,
      wickColor: color,
      _isUp: isUp
    };
  });
}

function mapCandlesForTf(candles, tf) {
  if (tf !== "1d") return candles;
  return candles.map((c) => ({
    ...c,
    time: toBusinessDayJst(c.time)
  }));
}

function aggregateCandlesForTimeframe(candles, tf) {
  const src = Array.isArray(candles) ? candles : [];
  if (!src.length) return [];
  if (tf === "1d") return mapCandlesForTf(src, tf);
  // API returns already bucketed candles per tf; avoid client-side re-aggregation drift.
  return src;
}

function sanitizeCandlesForDisplay(candles, tf) {
  const src = Array.isArray(candles) ? candles : [];
  if (!src.length) return [];
  const multipliers = { "1m": 18, "5m": 14, "15m": 10, "1h": 7, "1d": 5 };
  const floors = { "1m": 0.02, "5m": 0.035, "15m": 0.06, "1h": 0.12, "1d": 0.32 };
  const mult = Number(multipliers[tf] || 12);
  const floorAbs = Number(floors[tf] || 0.04);
  const ranges = src
    .map((c) => Number(c.high) - Number(c.low))
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const medianRange = ranges.length ? ranges[Math.floor(ranges.length / 2)] : floorAbs;
  const maxRange = Math.max(floorAbs, medianRange * mult);
  return src.map((c) => {
    const open = Number(c.open);
    const close = Number(c.close);
    let high = Number(c.high);
    let low = Number(c.low);
    if (![open, close, high, low].every(Number.isFinite)) return c;
    const center = (open + close) / 2;
    if ((high - low) > maxRange) {
      high = Math.min(high, center + maxRange * 0.5);
      low = Math.max(low, center - maxRange * 0.5);
    }
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    return {
      ...c,
      high: Number(high.toFixed(6)),
      low: Number(low.toFixed(6))
    };
  });
}

function trimChartView(candles, tf) {
  const bars = Math.max(40, Number(CHART_VIEW_BARS[tf] || 90));
  return candles.slice(-bars);
}

function applyChartViewport(tf, candleData, sourceCandles, overlays = {}) {
  if (!chartRuntime.chart || !Array.isArray(candleData) || !candleData.length) return;
  const barSpacing = Number(CHART_BAR_SPACING[tf] || 8);
  const margins = CHART_PRICE_SCALE_MARGINS[tf] || CHART_PRICE_SCALE_MARGINS["1m"];
  chartRuntime.chart.timeScale().applyOptions({
    barSpacing,
    rightOffset: 2
  });
  chartRuntime.chart.priceScale("right").applyOptions({
    // Keep fixed visible range to avoid off-screen candles on one-sided trends.
    autoScale: false,
    scaleMargins: margins
  });
  const rightPadBars = 2;
  chartRuntime.chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, candleData.length - Number(CHART_VIEW_BARS[tf] || 90)),
    to: candleData.length - 1 + rightPadBars
  });
  const visibleRange = buildVisiblePriceRange(sourceCandles, tf, overlays, latestTicker);
  if (!visibleRange) {
    chartRuntime.chart.priceScale("right").applyOptions({
      autoScale: true,
      scaleMargins: margins
    });
    if (typeof chartRuntime.chart.timeScale().fitContent === "function") {
      chartRuntime.chart.timeScale().fitContent();
    }
    return;
  }
  if (typeof chartRuntime.chart.priceScale("right").setVisibleRange === "function") {
    chartRuntime.chart.priceScale("right").setVisibleRange(visibleRange);
  }
}

function syncChartPriceRangeToLatestTicker() {
  if (!chartRuntime.chart || !Array.isArray(chartState.candles) || !chartState.candles.length) return;
  const normalized = normalizeCandlesForChart(chartState.candles);
  const tfCandles = aggregateCandlesForTimeframe(normalized, chartState.tf);
  const trimmedCandles = trimChartView(tfCandles, chartState.tf);
  const viewCandles = (chartState.tf === "1h" || chartState.tf === "1d")
    ? sanitizeCandlesForDisplay(trimmedCandles, chartState.tf)
    : trimmedCandles;
  if (!viewCandles.length) return;
  const ma10Data = buildMaData(viewCandles, 10);
  const ma25Data = buildMaData(viewCandles, 25);
  const ma75Data = buildMaData(viewCandles, 75);
  const visibleRange = buildVisiblePriceRange(viewCandles, chartState.tf, {
    ma10Data,
    ma25Data,
    ma75Data
  }, latestTicker);
  if (visibleRange && typeof chartRuntime.chart.priceScale("right").setVisibleRange === "function") {
    chartRuntime.chart.priceScale("right").setVisibleRange(visibleRange);
  }
}

function buildVisiblePriceRange(candles, tf, overlays = {}, ticker = null) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  for (const c of candles) {
    const low = Number(c?.low);
    const high = Number(c?.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (low < minPrice) minPrice = low;
    if (high > maxPrice) maxPrice = high;
  }
  const overlaySeries = [overlays.ma10Data, overlays.ma25Data, overlays.ma75Data];
  for (const series of overlaySeries) {
    if (!Array.isArray(series)) continue;
    for (const p of series) {
      const v = Number(p?.value);
      if (!Number.isFinite(v)) continue;
      if (v < minPrice) minPrice = v;
      if (v > maxPrice) maxPrice = v;
    }
  }
  // Include latest tick to keep chart following fast moves before candle aggregation catches up.
  const tickBid = Number(ticker?.bid);
  const tickAsk = Number(ticker?.ask);
  const tickMid = Number.isFinite(tickBid) && Number.isFinite(tickAsk) ? (tickBid + tickAsk) / 2 : Number.NaN;
  if (Number.isFinite(tickBid)) {
    if (tickBid < minPrice) minPrice = tickBid;
    if (tickBid > maxPrice) maxPrice = tickBid;
  }
  if (Number.isFinite(tickAsk)) {
    if (tickAsk < minPrice) minPrice = tickAsk;
    if (tickAsk > maxPrice) maxPrice = tickAsk;
  }
  if (Number.isFinite(tickMid)) {
    if (tickMid < minPrice) minPrice = tickMid;
    if (tickMid > maxPrice) maxPrice = tickMid;
  }
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;
  const lastCloseRaw = Number(candles[candles.length - 1]?.close);
  const center = Number.isFinite(tickMid)
    ? tickMid
    : (Number.isFinite(lastCloseRaw) ? lastCloseRaw : (minPrice + maxPrice) / 2);
  const distUp = Math.max(0, maxPrice - center);
  const distDown = Math.max(0, center - minPrice);
  const halfSpanRaw = Math.max(distUp, distDown, (maxPrice - minPrice) * 0.5, 0.001);
  const minSpan = Math.max(0.001, (Number(CHART_MIN_SPAN_PIPS[tf] || 12) * 0.01));
  const halfSpanWithFloor = Math.max(halfSpanRaw, minSpan * 0.5);
  const baseSpan = Math.max(0.001, halfSpanWithFloor * 2);
  const minPad = (Number(CHART_PRICE_PADDING_PIPS[tf] || 2.5) * 0.01);
  const spanPaddingRate = tf === "1d" ? 0.28 : (tf === "1h" ? 0.34 : 0.14);
  const halfPad = Math.max(minPad, baseSpan * spanPaddingRate * 0.5);
  const halfSpan = halfSpanWithFloor + halfPad;
  return {
    from: Number((center - halfSpan).toFixed(6)),
    to: Number((center + halfSpan).toFixed(6))
  };
}

function toBusinessDayJst(unixSec) {
  const d = new Date(Number(unixSec) * 1000);
  const p = getJstParts(d);
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day)
  };
}

function buildMaData(candles, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) {
      out.push({
        time: candles[i].time,
        value: Number((sum / period).toFixed(6))
      });
    }
  }
  return out;
}

function buildRsiData(candles, period = 14) {
  if (candles.length < period + 1) return [];
  const closes = candles.map((c) => c.close);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out = [];
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = ((avgGain * (period - 1)) + up) / period;
    avgLoss = ((avgLoss * (period - 1)) + down) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    out.push({
      time: candles[i].time,
      value: Number(rsi.toFixed(4))
    });
  }
  return out;
}

function buildMacdData(candles, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  const closes = candles.map((c) => c.close);
  const emaShort = calcEma(closes, shortPeriod);
  const emaLong = calcEma(closes, longPeriod);
  const macdRaw = closes.map((_, i) => {
    if (emaShort[i] === null || emaLong[i] === null) return null;
    return emaShort[i] - emaLong[i];
  });
  const signalRaw = calcEma(macdRaw.map((v) => (v === null ? 0 : v)), signalPeriod);

  const macdLine = [];
  const signalLine = [];
  const histogram = [];
  for (let i = 0; i < candles.length; i += 1) {
    const m = macdRaw[i];
    const s = signalRaw[i];
    if (m === null || s === null) continue;
    const time = candles[i].time;
    const hist = m - s;
    macdLine.push({ time, value: Number(m.toFixed(6)) });
    signalLine.push({ time, value: Number(s.toFixed(6)) });
    histogram.push({
      time,
      value: Number(hist.toFixed(6)),
      color: hist >= 0 ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)"
    });
  }
  return { macdLine, signalLine, histogram };
}

function calcEma(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (ema === null) ema = v;
    else ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function formatChartTime(time) {
  if (time === undefined || time === null) return "-";
  if (typeof time === "number") return formatJstDateTime(new Date(time * 1000));
  if (typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return String(time);
}

function formatChartTimeJst(time) {
  return formatChartTickJst(time);
}

function formatChartTickJst(time) {
  if (time === undefined || time === null) return "-";
  if (typeof time === "number") {
    const p = getJstDateTimeParts(new Date(time * 1000));
    return `${p.hour}:${p.minute}`;
  }
  if (typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    return `${time.year}/${String(time.month).padStart(2, "0")}/${String(time.day).padStart(2, "0")}`;
  }
  return String(time);
}

function updateChartInfo(candles, tf) {
  const el = $("chartInfo");
  if (!el || !candles.length) return;
  const first = candles[0];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const diff = Number(last.close) - Number(prev.close);
  const pips = diff / 0.01;
  const from = formatRangeTime(resolveCandleTimestamp(first), tf);
  const to = formatRangeTime(resolveCandleTimestamp(last), tf);
  el.textContent = `${tfJa(tf)} / 期間: ${from} - ${to} / 最新: O:${fmt(last.open, 3)} H:${fmt(last.high, 3)} L:${fmt(last.low, 3)} C:${fmt(last.close, 3)} (${diff >= 0 ? "+" : ""}${fmt(pips, 2)} pips)`;
}

function resolveCandleTimestamp(candle) {
  if (!candle || typeof candle !== "object") return null;
  if (candle.ts) return candle.ts;
  if (typeof candle.time === "number") return new Date(candle.time * 1000).toISOString();
  if (candle.time && typeof candle.time === "object" && "year" in candle.time && "month" in candle.time && "day" in candle.time) {
    const y = String(candle.time.year).padStart(4, "0");
    const m = String(candle.time.month).padStart(2, "0");
    const d = String(candle.time.day).padStart(2, "0");
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  return null;
}

function formatRangeTime(ts, tf) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (tf === "1d") {
    const p = getJstParts(d);
    const y = p.year;
    const m = p.month;
    const day = p.day;
    return `${y}-${m}-${day} 00:00`;
  }
  return formatJstDateTime(d);
}

function formatJstDateTime(d, short = false) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: short ? undefined : "2-digit",
    hour12: false
  }).format(d);
}

function getJstParts(d) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: map.year || "0000",
    month: map.month || "01",
    day: map.day || "01"
  };
}

function getJstDateTimeParts(d) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: map.year || "0000",
    month: map.month || "01",
    day: map.day || "01",
    hour: map.hour || "00",
    minute: map.minute || "00",
    second: map.second || "00"
  };
}

function formatJstTime(d, withSeconds = false) {
  const p = getJstDateTimeParts(d);
  return withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

function updateChartMeta(rsiData, macd) {
  const el = $("chartMeta");
  if (!el) return;
  el.innerHTML = '移動平均 <span class="ma10">移動平均1(10)</span> <span class="ma25">移動平均2(25)</span> <span class="ma75">移動平均3(75)</span>';
}

function updateChartHeader(candles) {
  const last = candles[candles.length - 1];
  if (!last) return;
  const d = new Date(last.ts || Date.now());
  const p = getJstDateTimeParts(d);
  const dateEl = $("chartDate");
  const timeEl = $("chartTime");
  const openEl = $("chartOpen");
  const highEl = $("chartHigh");
  const lowEl = $("chartLow");
  const closeEl = $("chartClose");
  if (dateEl) dateEl.textContent = `${String(p.year).slice(-2)}/${p.month}/${p.day}`;
  if (timeEl) timeEl.textContent = `${p.hour}:${p.minute}`;
  if (openEl) openEl.textContent = fmt(last.open, 3);
  if (highEl) highEl.textContent = fmt(last.high, 3);
  if (lowEl) lowEl.textContent = fmt(last.low, 3);
  if (closeEl) closeEl.textContent = fmt(last.close, 3);
}

function syncPriceLines(positions) {
  for (const line of chartRuntime.priceLines) {
    chartRuntime.candleSeries.removePriceLine(line);
  }
  chartRuntime.priceLines = [];

  const openPositions = positions.filter((p) => p.status === "OPEN");
  for (const p of openPositions) {
    chartRuntime.priceLines.push(chartRuntime.candleSeries.createPriceLine({
      price: Number(p.entryPrice),
      color: "#38bdf8",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `Entry ${fmt(p.entryPrice, 3)}`
    }));
    if (p.takeProfitPrice) {
      chartRuntime.priceLines.push(chartRuntime.candleSeries.createPriceLine({
        price: Number(p.takeProfitPrice),
        color: "#22c55e",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `TP ${fmt(p.takeProfitPrice, 3)}`
      }));
    }
    if (p.stopLossPrice) {
      chartRuntime.priceLines.push(chartRuntime.candleSeries.createPriceLine({
        price: Number(p.stopLossPrice),
        color: "#f43f5e",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `SL ${fmt(p.stopLossPrice, 3)}`
      }));
    }
  }
}

function buildTradeMarkers(trades) {
  return trades.slice(0, 30).map((t) => ({
    time: toUnixTime(t.exitTime || t.entryTime),
    position: t.side === "BUY" ? "belowBar" : "aboveBar",
    color: t.netPnlJpy >= 0 ? "#22c55e" : "#ef4444",
    shape: "circle",
    text: t.side === "BUY" ? "B" : "S"
  }));
}

async function refreshSignal() {
  const signal = await json("/api/v1/assistant/recommendation");
  renderSignal(signal);
}

async function refreshSignalRealtime(force = false) {
  const now = Date.now();
  if (!force && (signalRefreshBusy || now - lastSignalRefreshMs < SIGNAL_REFRESH_MIN_MS)) return;
  signalRefreshBusy = true;
  try {
    await refreshSignal();
    lastSignalRefreshMs = Date.now();
  } finally {
    signalRefreshBusy = false;
  }
}

async function refreshRealtimeSync(force = false) {
  const now = Date.now();
  if (!force && (syncRefreshBusy || now - lastSyncRefreshMs < SYNC_REFRESH_MIN_MS)) return;
  syncRefreshBusy = true;
  try {
    await Promise.all([
      refreshAutoStatus(),
      refreshExecutionStats(),
      refreshAccount(),
      refreshAnalytics(),
      refreshTrades(),
      refreshPositions(),
      refreshNews(),
      refreshDailyLearningStatus()
    ]);
    lastSyncRefreshMs = Date.now();
  } finally {
    syncRefreshBusy = false;
  }
}

async function refreshAccount() {
  const mode = encodeURIComponent(getActiveExecutionModeForView());
  const account = await json(`/api/v1/account?mode=${mode}`);
  renderAccount(account);
}

async function refreshAnalytics() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const [summary, eventImpact, report200] = await Promise.all([
    json(`/api/v1/analytics/summary?from=${date}&to=${date}`),
    json("/api/v1/analytics/event-impact?minTrades=2"),
    json("/api/v1/analytics/report-200")
  ]);
  renderSummary(summary);
  renderEventImpact(eventImpact);
  const bench = $("benchmarkStatus");
  if (bench) {
    if (!report200.ok) {
      bench.textContent = `ベンチ判定: 保留 (${report200.available || 0}/${report200.requirement || 200})`;
    } else {
      bench.textContent = `ベンチ判定: ${report200.pass ? "合格" : "未達"} / 勝率=${fmt((report200.summary?.winRate || 0) * 100, 1)}% PF=${report200.summary?.profitFactor === null ? "-" : fmt(report200.summary?.profitFactor, 2)} DD=${fmt(report200.summary?.maxDrawdownJpy || 0, 0)}`;
    }
  }
}

async function refreshSettings() {
  const settings = await json("/api/v1/settings");
  const autoRisk = $("autoRiskPercentPerTrade");
  const autoInterval = $("autoIntervalSec");
  if (autoRisk) autoRisk.value = String(Math.round(Number(settings.autoRiskPercentPerTrade || settings.maxRiskPercentPerTrade || 1)));
  if (autoInterval) autoInterval.value = Number(settings.autoIntervalSec || 0.3);
  setRiskSettingsForm(settings);
  renderPositionSizing(settings.positionSizingPreview || settings.positionSizingDiagnostics || null);
  BROKER_LABEL = String(settings.brokerLabel || settings.brokerProfile || "SBI FXトレード");
  BASELINE_SPREAD_PIPS = Number(settings.baselineSpreadPips || 0.18);
  EST_FEE_BPS = Number(settings.effectiveFeeBps || 0);
  const costProfile = $("costProfile");
  if (costProfile) {
    costProfile.textContent = `${BROKER_LABEL} / 基準スプレッド ${fmt(BASELINE_SPREAD_PIPS, 2)} pips`;
  }
  const modeSelect = $("autoExecutionMode");
  const modeHint = $("autoExecutionModeHint");
  const liveWarning = $("autoLiveWarning");
  const mode = normalizeExecutionModeUi(settings.autoExecutionMode);
  if (modeSelect) modeSelect.value = mode;
  if (modeHint) {
    modeHint.textContent = `現在: ${executionModeLabel(mode)}`;
  }
  if (liveWarning) {
    const liveReady = Boolean(settings?.orderExecution?.mode === "LIVE_HTTP" && settings?.orderExecution?.manualLiveEnabled);
    liveWarning.textContent = liveReady
      ? "本番注文のサーバー設定: 有効"
      : "本番注文のサーバー設定: 未有効（現在はPAPER_LIVEで運用）";
    liveWarning.classList.toggle("is-live-ready", liveReady);
    liveWarning.classList.toggle("is-live-disabled", !liveReady);
  }
}

function setRiskSettingsForm(settings) {
  const fields = {
    balanceJPY: Math.round(Number(settings.balanceJPY ?? settings.positionSizing?.balanceJPY ?? 10000)),
    sizingMode: String(settings.sizingMode ?? settings.positionSizing?.sizingMode ?? "riskPercent"),
    riskPercentPerTrade: Number(settings.riskPercentPerTrade ?? settings.positionSizing?.riskPercentPerTrade ?? 5),
    riskAmountJPY: Math.round(Number(settings.riskAmountJPY ?? settings.positionSizing?.riskAmountJPY ?? 500)),
    maxEffectiveLeverage: Number(settings.maxEffectiveLeverage ?? settings.positionSizing?.maxEffectiveLeverage ?? 20),
    maxUnits: Math.round(Number(settings.maxUnits ?? settings.positionSizing?.maxUnits ?? 50000))
  };
  for (const [id, value] of Object.entries(fields)) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = String(value);
  }
}

function collectRiskSettingsPayload() {
  return {
    balanceJPY: Number($("balanceJPY")?.value),
    sizingMode: $("sizingMode")?.value || "riskPercent",
    riskPercentPerTrade: Number($("riskPercentPerTrade")?.value),
    riskAmountJPY: Number($("riskAmountJPY")?.value),
    maxEffectiveLeverage: Number($("maxEffectiveLeverage")?.value),
    maxUnits: Number($("maxUnits")?.value)
  };
}

function renderPositionSizing(diag) {
  const d = diag || {};
  const cs = d.capitalScalingDiagnostics || runtimeDiag.autoStatus?.capitalScaling?.diagnostics || {};
  setText("capitalTier", cs.activeTierLabel || cs.activeTierId || "-");
  setText("candidateTier", cs.candidateTierLabel || cs.candidateTierId || "-");
  const required = Number(cs.promotionRequiredTrades || 30);
  const done = Number(cs.tradesSinceCandidateTierReached || 0);
  setText("promotionProgress", cs.promotionEligible ? "昇格条件達成" : `あと${Math.max(0, required - done)}取引`);
  setText("allowedModes", Array.isArray(cs.allowedModes) ? cs.allowedModes.join(" / ") : "-");
  setText("fullUnlockStatus", cs.fullUnlockStatus === "NORMAL"
    ? "通常解放"
    : (cs.fullUnlockStatus === "TRIAL" ? "試験解放" : "ロック中"));
  setText("riskBalance", d.balanceJPY ? formatJPY(d.balanceJPY) : "-");
  setText("riskAmount", d.riskAmountJPY ? formatJPY(d.riskAmountJPY) : "-");
  setText("riskPercent", Number.isFinite(Number(d.riskPercentPerTrade)) ? `${fmt(Number(d.riskPercentPerTrade), 1)}%` : "-");
  setText("riskEstimatedLoss", d.estimatedLossJPY ? formatJPY(d.estimatedLossJPY, { approx: true }) : "-");
  setText("riskUnits", d.displayUnitsText || formatUnits(d.calculatedUnits));
  setText("riskMargin", d.requiredMarginJPY ? formatJPY(d.requiredMarginJPY, { approx: true }) : "-");
  setText("riskExposure", d.estimatedExposureJPY ? formatJPY(d.estimatedExposureJPY, { approx: true }) : "-");
  setText("riskLeverage", Number.isFinite(Number(d.effectiveLeverage)) ? `${fmt(Number(d.effectiveLeverage), 1)}倍` : "-");
  setText("riskStopLoss", Number.isFinite(Number(d.stopLossPips)) ? `${fmt(Number(d.stopLossPips), 1)}pips` : "-");
  const warnings = [];
  const lev = Number(d.effectiveLeverage || 0);
  const balance = Number(d.balanceJPY || 0);
  const risk = Number(d.riskAmountJPY || 0);
  if (lev >= 5) warnings.push("危険: 実効レバレッジが5倍以上");
  else if (lev >= 3) warnings.push("注意: 実効レバレッジが3倍以上");
  if (balance > 0 && risk >= balance * 0.03) warnings.push("危険: 1回の許容損失が資産の3%以上");
  else if (balance > 0 && risk >= balance * 0.02) warnings.push("注意: 1回の許容損失が資産の2%以上");
  if (d.cappedByMaxUnits || d.cappedByLeverage) warnings.push("上限により取引数量を調整");
  if (d.blockedReason) warnings.push(`注文ブロック: ${d.blockedReason}`);
  if (cs.promotionBlockedReasons?.length) warnings.push(`昇格確認中: ${cs.promotionBlockedReasons.join(", ")}`);
  if (cs.demotionReasons?.length) warnings.push(`段階降格: ${cs.demotionReasons.join(", ")}`);
  const el = $("riskWarning");
  if (el) {
    el.textContent = warnings.length ? warnings.join(" / ") : "リスク設定は通常範囲です";
    el.classList.remove("risk-warn", "risk-danger");
    if (warnings.some((x) => x.startsWith("危険") || x.includes("ブロック"))) el.classList.add("risk-danger");
    else if (warnings.length) el.classList.add("risk-warn");
  }
}

function renderReasonTags(id, items, emptyText = "-") {
  const el = $(id);
  if (!el) return;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) {
    el.innerHTML = `<span class="reason-chip info">${escapeHtml(emptyText)}</span>`;
    return;
  }
  el.innerHTML = list
    .slice(0, 8)
    .map((x) => `<span class="reason-chip info">${escapeHtml(translateReasonJa(x))}</span>`)
    .join("");
}

function renderDecisionTimeline(trace) {
  const el = $("decisionTimeline");
  if (!el) return;
  const stages = Array.isArray(trace?.stages) ? trace.stages : [];
  if (!stages.length) {
    el.innerHTML = `<p class="mono">判断プロセスはまだありません。</p>`;
    return;
  }
  el.innerHTML = stages.map((stage) => {
    const status = String(stage?.status || "-").toLowerCase();
    const reason = stage?.details?.reason || stage?.details?.finalReason || stage?.details?.blockedReason || "";
    return `
      <div class="timeline-step ${escapeHtml(statusToneClass(status))}">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <div class="timeline-head">
            <strong>${escapeHtml(stageNameJa(stage?.name))}</strong>
            <span class="status-pill ${escapeHtml(statusToneClass(status))}">${escapeHtml(statusJa(status))}</span>
          </div>
          ${reason ? `<p>${escapeHtml(translateReasonJa(reason))}</p>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function renderMonitoringCards(st) {
  const trace = st.decisionTrace || {};
  const finalStage = Array.isArray(trace.stages)
    ? trace.stages.find((x) => x?.name === "final_decision")
    : null;
  const candidateAction = trace.candidateAction || st.candidateAction || st.assistantSignal?.action || "-";
  const finalAction = trace.finalAction || finalStage?.details?.finalAction || st.lastAction || "-";
  const finalReason = trace.finalReason || finalStage?.details?.finalReason || st.lastSkipReason || "-";
  const market = st.marketStatus || {};

  setToneText("conclusionAction", actionJa(finalAction), finalAction);
  setText("conclusionReason", translateReasonJa(finalReason));
  setToneText("conclusionRealtime", market.realtime ? "リアルタイム" : "非リアルタイム", market.realtime ? "true" : "false");
  setToneText("conclusionSource", translateReasonJa(st.marketRealtimeSource || market.source || "-"), market.realtime ? "pass" : "warning");
  setToneText("candAction", actionJa(candidateAction), candidateAction);
  setToneText("finalAction", actionJa(finalAction), finalAction);
  setText("finalReason", translateReasonJa(finalReason));

  const mid = Number(market.mid ?? latestTicker?.mid ?? ((Number(latestTicker?.bid) + Number(latestTicker?.ask)) / 2));
  setText("mktPrice", Number.isFinite(mid) ? fmt(mid, 3) : "-");
  setText("mktBidAsk", `${fmt(latestTicker?.bid ?? market.bid, 3)} / ${fmt(latestTicker?.ask ?? market.ask, 3)}`);
  setText("mktSpread", Number.isFinite(Number(latestTicker?.spreadPips ?? market.spreadPips)) ? `${fmt(latestTicker?.spreadPips ?? market.spreadPips, 2)} pips` : "-");
  setText("mktSource", `${translateReasonJa(st.marketRealtimeSource || market.source || "-")} / ${translateReasonJa(st.marketInputMode || market.inputMode || "-")}`);
  setToneText("mktRealtime", market.realtime ? "配信中" : "未接続", market.realtime ? "true" : "false");
  setText("mktStale", Number.isFinite(Number(market.staleMs)) ? `${fmt(Number(market.staleMs), 0)} ms` : "-");

  const noAction = st.noActionableSignalDiagnostics || {};
  setText("holdReason", translateReasonJa(noAction.reason || st.lastSkipReason || finalReason));
  setText("holdCategory", `分類: ${translateReasonJa(noAction.category || "-")} / 候補: ${actionJa(noAction.candidateSide || candidateAction)}`);
  renderReasonTags("holdFailedReasons", noAction.entryConditionFailedReasons, "条件未達なし");
  const probeReasons = Array.isArray(noAction.probeBlockedReasons) ? noAction.probeBlockedReasons : [];
  setText("holdProbeReasons", probeReasons.length ? `小ロット不可: ${translateReasonJa(probeReasons)}` : "小ロット検証の追加ブロックなし");
  const holdCard = $("holdCard");
  if (holdCard) holdCard.style.display = (String(finalAction).toUpperCase() === "HOLD" || st.lastSkipReason) ? "" : "none";

  const pre = st.preTradeGuard || st.preTradeGuardDiagnostics || st.preTradeGuardResult || null;
  let preText = "preTradeGuard未実行：シグナル生成段階でHOLD";
  let preTone = "hold";
  if (pre && pre.allowed === false) {
    preText = `preTradeGuardでブロック: ${translateReasonJa(pre.reason || pre.blockedReason || "-")}`;
    preTone = "blocked";
  } else if (pre && pre.allowed === true) {
    preText = "preTradeGuard通過";
    preTone = "pass";
  }
  const preEl = $("preTradeGuardInfo");
  if (preEl) {
    preEl.textContent = preText;
    preEl.classList.remove("tone-good", "tone-bad", "tone-warn", "tone-neutral");
    preEl.classList.add(statusToneClass(preTone));
  }

  const entryEvidence = st.entryEvidenceBreakdown || {};
  const entryLocation = st.entryLocationDiagnostics || {};
  const evidenceScore = Number(st.entryEvidenceScore ?? entryEvidence.totalScore);
  const level = scoreLevel(evidenceScore);
  setToneText("entryEvidenceStatus", Number.isFinite(evidenceScore)
    ? `${fmt(evidenceScore, 3)} / ${level.label} / ${jaEntryCategory(entryEvidence.finalCategory)}`
    : "-", level.cls.replace("tone-", ""));
  setText("finalCategory", translateReasonJa(entryEvidence.finalCategory || "-"));
  setText("entryLocationStatus", entryLocation.entryLocationScore !== undefined
    ? `${fmt(entryLocation.entryLocationScore, 3)} / ${jaEntryCategory(entryLocation.entryLocationCategory)}`
    : "-");
  setText("udRatio", Number.isFinite(Number(entryLocation.upsideDownsideRatio)) ? fmt(entryLocation.upsideDownsideRatio, 2) : "-");
  setText("expUp", Number.isFinite(Number(entryLocation.expectedUpsidePips)) ? `${fmt(entryLocation.expectedUpsidePips, 2)} pips` : "-");
  setText("estDown", Number.isFinite(Number(entryLocation.estimatedDownsidePips)) ? `${fmt(entryLocation.estimatedDownsidePips, 2)} pips` : "-");

  const d = st.positionSizingDiagnostics || {};
  setText("riskUnitsApplied", d.displayUnitsText || formatUnits(d.calculatedUnits));
  setText("riskLeverageApplied", Number.isFinite(Number(d.effectiveLeverage)) ? `${fmt(d.effectiveLeverage, 1)} / ${fmt(d.maxEffectiveLeverage, 1)}倍` : "-");
  setText("riskLossApplied", d.estimatedLossJPY ? formatJPY(d.estimatedLossJPY, { approx: true }) : "-");
  setText("riskMarginApplied", d.requiredMarginJPY ? formatJPY(d.requiredMarginJPY, { approx: true }) : "-");
  setText("riskSlSource", `${translateReasonJa(d.stopLossSource || "-")}${d.blockedReason ? ` / ${translateReasonJa(d.blockedReason)}` : ""}`);
  const slWarn = $("slFallbackWarning");
  if (slWarn) slWarn.style.display = d.stopLossFallbackUsed ? "" : "none";
  const levWarn = $("leverageLimitWarning");
  const lev = Number(d.effectiveLeverage);
  const maxLev = Number(d.maxEffectiveLeverage);
  if (levWarn) levWarn.style.display = (d.cappedByLeverage || (Number.isFinite(lev) && Number.isFinite(maxLev) && maxLev > 0 && lev >= maxLev * 0.9)) ? "" : "none";

  renderDecisionTimeline(trace);
}

async function refreshAutoStatus() {
  const st = await json("/api/v1/auto/status");
  runtimeDiag.autoStatus = st;
  renderPositionSizing(st.positionSizingDiagnostics || null);
  renderMonitoringCards(st);
  const autoStatusEl = $("autoStatus");
  const autoWarningEl = $("autoWarning");
  const liveReadinessEl = $("liveReadinessStatus");
  const marketInputModeEl = $("marketInputMode");
  const paperLiveModeEl = $("paperLiveMode");
  const guardMode = String(st.executionTailGate?.mode || "NORMAL");
  const rescueCd = Number(st.rollingRescueCooldownRemainingSec || 0);
  const cooldownSec = Number(st.cooldownRemainingSec || 0);

  let statusTone = "stopped";
  let statusText = "停止中";
  if (st.enabled && st.stopRequested) {
    statusTone = "pending";
    statusText = `停止予約中 (保有:${st.openAutoPositions || 0})`;
  } else if (st.enabled) {
    statusTone = "running";
    statusText = `稼働中 (保有:${st.openAutoPositions || 0})`;
  }
  if (rescueCd > 0 || cooldownSec > 0) {
    statusTone = "cooldown";
  }
  if (String(st.lastAction || "").includes("ERROR") || guardMode.includes("BLOCK")) {
    statusTone = "alert";
  }
  if (autoStatusEl) {
    autoStatusEl.textContent = statusText;
    autoStatusEl.classList.remove("status-running", "status-stopped", "status-pending", "status-cooldown", "status-alert");
    autoStatusEl.classList.add(`status-${statusTone}`);
  }
  const action = autoLastActionJa(st.lastAction);
  const cooldown = Number(st.cooldownRemainingSec || 0) > 0
    ? ` / 待機${Number(st.cooldownRemainingSec)}秒 (${st.cooldownReason || "保護"})`
    : "";
  const rescue = rescueCd > 0 ? ` / rescue待機${rescueCd}秒` : "";
  const reason = st.lastSkipReason ? ` / 理由: ${translateReasonJa(st.lastSkipReason)}` : "";
  const lastRunText = st.lastRunAt ? formatJstDateTime(new Date(st.lastRunAt)) : "-";
  const market = st.marketStatus || {};
  const marketHint = market.source ? ` / ${market.fxOpen ? "市場OPEN" : "市場CLOSE"} / ${market.source}` : "";
  setText("autoLast", `${lastRunText} / ${action}${cooldown}${rescue}${reason}${marketHint}`);
  window.renderBlockingSummary?.(st.blockingSummary);
  const guard = $("autoGuard");
  if (guard) {
    const warmup = Number(st.rollbackWarmupSec || 0);
    const warmText = warmup > 0 ? ` / 学習ウォームアップ${warmup}秒` : "";
    const tailPenalty = Number(st.edgeSizing?.tailPenaltyMultiplier || st.edgeSizing?.tailAwareSizeMultiplier || 1);
    const tailMode = String(st.executionTailGate?.mode || "NORMAL");
    guard.textContent = `${st.anomalyMode || "NORMAL"} / tail=${tailMode} / penalty=${fmt(tailPenalty, 2)}${warmText}`;
  }
  if (marketInputModeEl) {
    marketInputModeEl.textContent = `${st.marketInputMode || st.marketStatus?.inputMode || "-"} / ${st.marketRealtimeSource || st.marketStatus?.source || "-"}`;
  }
  if (paperLiveModeEl) {
    const desired = normalizeExecutionModeUi(st.autoExecutionMode);
    const orderMode = String(st?.orderExecution?.mode || "SIMULATED").toUpperCase();
    const liveEnabled = Boolean(st?.orderExecution?.manualLiveEnabled);
    const effective = desired === "LIVE" && orderMode === "LIVE_HTTP" && liveEnabled
      ? "本番（実注文）"
      : "PAPER_LIVE";
    paperLiveModeEl.textContent = `${executionModeLabel(desired)} / 実際=${effective}`;
  }
  if (liveReadinessEl) {
    const lr = st.liveReadiness || {};
    const ready = Boolean(lr.ready);
    const blockers = Array.isArray(lr.blockers) ? lr.blockers : [];
    const txt = ready
      ? "本番開始可"
      : `未達: ${blockers.length ? translateReasonJa(blockers.slice(0, 2)) : translateReasonJa(lr.reason || "-")}`;
    liveReadinessEl.textContent = txt;
    liveReadinessEl.classList.remove("status-alert", "status-neutral");
    liveReadinessEl.classList.add(ready ? "status-neutral" : "status-alert");
  }
  if (autoWarningEl) {
    const warnings = [];
    if (guardMode.includes("BLOCK")) warnings.push(`約定品質ガード ${guardMode}`);
    if (rescueCd > 0) warnings.push("期待値保護の縮小運用中");
    if (cooldownSec > 0) warnings.push("連敗保護の待機中");
    if (Number(st.executionTailGate?.tailPenaltyMultiplier || 1) < 0.6) warnings.push("サイズ縮小（tail）");
    if (!Boolean(st.liveReadiness?.ready)) warnings.push("本番条件未達");
    autoWarningEl.textContent = warnings.length ? warnings.join(" / ") : "なし";
    autoWarningEl.classList.remove("status-neutral", "status-alert");
    autoWarningEl.classList.add(warnings.length ? "status-alert" : "status-neutral");
  }
  const d = st.positionSizingDiagnostics || {};
  const cs = d.capitalScalingDiagnostics || st.capitalScaling?.diagnostics || {};
  const evidenceScore = Number(st.entryEvidenceScore ?? st.entryEvidenceBreakdown?.totalScore);
  const mtfScore = Number(st.multiTimeframeScore ?? st.multiTimeframeDiagnostics?.multiTimeframeScore);
  const trendQuality = st.trendUpEntryQuality || st.entryLocationDiagnostics || {};
  setText("summaryEquity", formatJPY(st.activeModeAccount?.currentEquityJPY ?? st.activeModeAccount?.currentBalanceJpy ?? d.balanceJPY));
  setText("summaryDayPnl", formatJPY(st.activeModeAccount?.dailyLossJPY ? -Number(st.activeModeAccount.dailyLossJPY) : 0));
  setText("summaryAutoState", `${executionModeLabel(st.autoExecutionMode)} / ${statusText}`);
  setText("summaryNextLoss", d.estimatedLossJPY ? formatJPY(d.estimatedLossJPY, { approx: true }) : "-");
  setText("summaryLeverage", Number.isFinite(Number(d.effectiveLeverage)) ? `${fmt(Number(d.effectiveLeverage), 1)}倍` : "-");
  setText("summaryTier", cs.activeTierLabel || cs.activeTierId || "-");
  const evidenceLevel = scoreLevel(evidenceScore);
  setText("summaryEvidence", Number.isFinite(evidenceScore) ? `${fmt(evidenceScore, 3)} / ${evidenceLevel.label} / ${jaEntryCategory(st.entryEvidenceBreakdown?.finalCategory)}` : "-");
  setText("summaryMtf", Number.isFinite(mtfScore) ? fmt(mtfScore, 3) : "-");
  setText("summaryTrendQuality", jaEntryCategory(trendQuality.entryTimingCategory || trendQuality.entryLocationCategory));
  setText("summaryTradePermission", tradePermissionText(st));
  setText("entryEvidenceStatus", Number.isFinite(evidenceScore) ? `${fmt(evidenceScore, 3)} / ${evidenceLevel.label} / ${jaEntryCategory(st.entryEvidenceBreakdown?.finalCategory)}` : "-");
  setText("multiTimeframeStatus", Number.isFinite(mtfScore) ? `${fmt(mtfScore, 3)} / 整合 ${fmt(st.shortTermAlignmentScore ?? st.multiTimeframeDiagnostics?.shortTermAlignmentScore, 3)}` : "-");
  setText("trendUpQualityStatus", jaEntryCategory(trendQuality.entryTimingCategory || trendQuality.entryLocationCategory));
  setText("entryLocationStatus", st.entryLocationDiagnostics
    ? `${fmt(st.entryLocationDiagnostics.entryLocationScore, 3)} / ${jaEntryCategory(st.entryLocationDiagnostics.entryLocationCategory)}`
    : "-");
  const reentry = st.reentryDiagnostics || st.reentryGuard || {};
  setText(
    "reentryStatus",
    reentry.blocked
      ? `待機中 / 残り${fmt(reentry.cooldownRemainingSec || 0, 0)}秒`
      : (reentry.downgradedToProbeLowRate ? "低レート再開候補" : "通常")
  );
  setText("autoSkipTop", formatSkipReasonTop(st.recentSkipReasons, st));
  renderDiagnostics();
}

async function refreshNews() {
  const [out, st] = await Promise.all([
    json("/api/v1/news?limit=60"),
    json("/api/v1/news/status")
  ]);
  chartState.news = out.items || [];
  renderNews(chartState.news, st);
}

async function refreshDailyLearningStatus() {
  const st = await json("/api/v1/learning/daily/status");
  runtimeDiag.learningStatus = st;
  const el = $("dailyLearningStatus");
  if (!el) return;
  const base = st.lastRunAt
    ? `最終=${formatJstDateTime(new Date(st.lastRunAt))} JST日付=${st.lastDateJst || "-"}`
    : "未実行";
  const rt = st.realtimeShadow || {};
  const rtText = `常時学習=${rt.lastError ? "異常" : "稼働"} 更新=${Number(rt.updates || 0)} open=${rt.hasOpenPosition ? "1" : "0"}`;
  el.textContent = st.lastError ? `${base} / ${rtText} / エラー: ${st.lastError}` : `${base} / ${rtText}`;
  renderDiagnostics();
}

async function refreshExecutionStats() {
  const st = await json("/api/v1/execution/stats");
  runtimeDiag.executionStats = st || {};
  renderDiagnostics();
}

function renderReports(weekly, monthly, ablation) {
  setText("weeklyHardBlock", fmt(weekly?.hardBlockCount || 0, 0));
  setText("weeklyRescue", fmt(weekly?.rescueCount || 0, 0));
  setText("weeklySemiFullShare", `${fmt((weekly?.modeShare?.semiFullShare || 0) * 100, 1)}%`);
  setText("weeklyFullShare", `${fmt((weekly?.modeShare?.fullShare || 0) * 100, 1)}%`);
  setText("monthlyOosPf", monthly?.oos?.profitFactor === null ? "-" : fmt(monthly?.oos?.profitFactor, 2));
  setText("monthlyOosExp", fmt(monthly?.oos?.expectancyR || 0, 3));
  setText("monthlyPositionPf", monthly?.positionProfitFactor === null || monthly?.positionProfitFactor === undefined ? "-" : fmt(monthly.positionProfitFactor, 2));
  setText("monthlyTradeRowPf", monthly?.tradeRowProfitFactor === null || monthly?.tradeRowProfitFactor === undefined ? "-" : fmt(monthly.tradeRowProfitFactor, 2));
  setText("monthlyPositionWinRate", `${fmt((monthly?.positionSummary?.positionWinRate || 0) * 100, 1)}%`);
  setText("monthlyTradeRowWinRate", `${fmt((monthly?.summary?.winRate || 0) * 100, 1)}%`);
  setText("profitOptimizationScore", fmt(monthly?.profitOptimizationScore || 0, 3));
  const go = String(monthly?.lowDdSteadyGate?.goDecision || "-");
  const goEl = $("monthlyGoNoGo");
  if (goEl) {
    goEl.textContent = go;
    goEl.classList.remove("pnl-pos", "pnl-neg");
    if (go === "GO") goEl.classList.add("pnl-pos");
    if (go === "NO-GO") goEl.classList.add("pnl-neg");
  }
  setText("monthlyStress15", fmt(monthly?.stress?.x1_5?.expectancyR || 0, 3));
  const consistency = monthly?.reportConsistencyDiagnostics || {};
  const winRates = consistency.winRateComparison || {};
  const dataSource = monthly?.reportDataSourceDiagnostics || {};
  const newLogic = monthly?.newLogicLooseSummary || monthly?.newLogicSummary || {};
  const newLogicStrict = monthly?.newLogicStrictSummary || {};
  const legacyLogic = monthly?.legacyLogicSummary || {};
  setText("reportApiWinRate", formatPercent(winRates.allTrades?.winRate ?? consistency.apiWinRate));
  setText("reportMonthlyWinRate", formatPercent(winRates.reportTargetTrades?.winRate ?? consistency.reportWinRate ?? monthly?.tradeRowWinRate));
  setText("reportNewLogicWinRate", formatPercent(winRates.newLogicLoose?.winRate ?? newLogic.winRate));
  setText("reportNewLogicStrictWinRate", formatPercent(winRates.newLogicStrict?.winRate ?? newLogicStrict.winRate));
  setText("reportApiTradesCount", `対象: ${Number(winRates.allTrades?.count ?? consistency.apiTradesCount ?? 0).toLocaleString("ja-JP")}件`);
  setText("reportMonthlyTradesCount", `対象: ${Number(winRates.reportTargetTrades?.count ?? consistency.reportTradesCount ?? dataSource.filteredTradeRows ?? 0).toLocaleString("ja-JP")}件`);
  setText("reportNewLogicTradesCount", `対象: ${Number(winRates.newLogicLoose?.count ?? newLogic.totalTrades ?? 0).toLocaleString("ja-JP")}件 / sample small`);
  setText("reportNewLogicStrictTradesCount", `対象: ${Number(winRates.newLogicStrict?.count ?? newLogicStrict.totalTrades ?? 0).toLocaleString("ja-JP")}件 / sample small`);
  setText("reportExcludedRows", `${Number(dataSource.excludedRows ?? 0).toLocaleString("ja-JP")}件`);
  setText("reportExcludedReasonSummary", formatReasonSummary(dataSource.excludedReasonSummary));
  setText("reportDifferenceDetected", consistency.differenceDetected ? "あり" : "なし");
  const latestExit = dataSource.latestTradeExitTime ? new Date(dataSource.latestTradeExitTime) : null;
  setText("reportLatestTradeExitTime", latestExit ? formatJstDateTime(latestExit) : "-");
  setText("reportNewLogicTotalTrades", `${Number(newLogic.totalTrades ?? 0).toLocaleString("ja-JP")}件`);
  setText("reportLegacyLogicTotalTrades", `${Number(legacyLogic.totalTrades ?? 0).toLocaleString("ja-JP")}件`);
  const generated = monthly?.generatedAt || weekly?.generatedAt || null;
  setText("reportGeneratedAt", generated ? `最終更新: ${formatJstDateTime(new Date(generated))}` : "最終更新: -");
  const ablationSummary = ablation
    ? `Ablation(${(ablation.ablation || []).join(",")}): ExpR=${fmt(ablation?.simulated?.expectancyR || 0, 3)} PF=${ablation?.simulated?.profitFactor === null ? "-" : fmt(ablation.simulated.profitFactor, 2)}`
    : "-";
  setText("ablationSummary", ablationSummary);
}

async function refreshReports(ablationText = reportAblationText) {
  const safeAblation = String(ablationText || "").trim();
  if (safeAblation) reportAblationText = safeAblation;
  const [weekly, monthly, ablation] = await Promise.all([
    json("/api/v1/reports/weekly"),
    json("/api/v1/reports/monthly"),
    json(`/api/v1/reports/ablation?ablation=${encodeURIComponent(reportAblationText)}`)
  ]);
  renderReports(weekly, monthly, ablation);
}

async function refreshTrades() {
  const mode = encodeURIComponent(getActiveExecutionModeForView());
  const out = await json(`/api/v1/trades?limit=500&mode=${mode}`);
  chartState.trades = out.items || [];
  renderTrades(chartState.trades);
  if (chartState.candlesTf === chartState.tf) {
    renderChart(chartState.candles, chartState.positions, chartState.trades, chartState.tf);
  }
}

async function refreshPositions() {
  const mode = encodeURIComponent(getActiveExecutionModeForView());
  const out = await json(`/api/v1/positions?mode=${mode}`);
  chartState.positions = out.items || [];
  renderPositions(chartState.positions);
  if (chartState.candlesTf === chartState.tf) {
    renderChart(chartState.candles, chartState.positions, chartState.trades, chartState.tf);
  }
}

async function refreshChart() {
  const requestedTf = String(chartState.tf || "1m");
  const seq = ++chartRequestSeq;
  const limits = {
    // MA75計算の余白を確保しつつ、描画はtrimChartViewで短く見せる。
    "1m": 220,
    "5m": 220,
    "15m": 240,
    "1h": 520,
    "1d": 1000
  };
  const limit = limits[requestedTf] || 180;
  try {
    const out = await json(`/api/v1/market/candles?tf=${encodeURIComponent(requestedTf)}&limit=${limit}`);
    // Ignore stale responses from previous timeframe requests.
    if (seq !== chartRequestSeq || requestedTf !== chartState.tf) return;
    const nextCandles = Array.isArray(out?.candles) ? out.candles : [];
    chartState.candles = nextCandles;
    chartState.candlesTf = requestedTf;
    if (!nextCandles.length) {
      clearChartSeriesForLoading();
      const info = $("chartInfo");
      if (info) info.textContent = `${tfJa(requestedTf)}の足データを読み込み中...`;
    } else {
      renderChart(nextCandles, chartState.positions, chartState.trades, requestedTf);
    }
    const title = $("chartTitle");
    if (title) title.textContent = `価格チャート(${tfJa(requestedTf)})`;
  } catch (err) {
    if (seq !== chartRequestSeq || requestedTf !== chartState.tf) return;
    chartState.candles = [];
    chartState.candlesTf = requestedTf;
    clearChartSeriesForLoading();
    const info = $("chartInfo");
    if (info) info.textContent = `${tfJa(requestedTf)}の読み込みに失敗しました。次の更新で再試行します。`;
    throw err;
  }
}

function bindActions() {
  $("autoExecutionMode")?.addEventListener("change", (e) => {
    const mode = normalizeExecutionModeUi(e?.target?.value);
    const modeHint = $("autoExecutionModeHint");
    if (modeHint) modeHint.textContent = `現在: ${executionModeLabel(mode)}`;
    refreshAll(true).catch(() => {});
  });
  $("tfTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tf-tab");
    if (!btn) return;
    const tf = btn.getAttribute("data-tf");
    if (!tf || tf === chartState.tf) return;
    chartState.tf = tf;
    chartState.candles = [];
    chartState.candlesTf = null;
    chartRequestSeq += 1;
    clearChartSeriesForLoading();
    resetChartViewportForTf(tf);
    localStorage.setItem(TF_STORAGE_KEY, tf);
    document.querySelectorAll(".tf-tab").forEach((el) => el.classList.remove("is-active"));
    btn.classList.add("is-active");
    const title = $("chartTitle");
    if (title) title.textContent = `価格チャート(${tfJa(tf)})`;
    const info = $("chartInfo");
    if (info) info.textContent = `${tfJa(tf)}を読み込み中...`;
    refreshChart().catch(() => {});
  });
  $("newsTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".news-tab");
    if (!btn) return;
    const tab = btn.getAttribute("data-news-tab") || "all";
    chartState.newsTab = tab;
    document.querySelectorAll(".news-tab").forEach((el) => el.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderNews(chartState.news, null);
  });

  $("resetBtn").addEventListener("click", async () => {
    const ok = window.confirm("口座をリセットします。取引履歴・ポジションは初期化されます（学習は保持）。続行しますか？");
    if (!ok) return;
    await json("/api/v1/account/reset", { method: "POST" });
    await Promise.all([refreshAccount(), refreshAnalytics(), refreshTrades(), refreshPositions()]);
  });
  $("learningResetBtn")?.addEventListener("click", async () => {
    const ok = window.confirm("学習状態のみをリセットします（口座・取引履歴は保持）。続行しますか？");
    if (!ok) return;
    await json("/api/v1/learning/reset", { method: "POST" });
    await Promise.all([refreshAutoStatus(), refreshSignal()]);
  });
  $("assetSettingsSaveBtn")?.addEventListener("click", async () => {
    const out = await json("/api/v1/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectRiskSettingsPayload())
    });
    setRiskSettingsForm(out);
    renderPositionSizing(out.positionSizingPreview || null);
    await refreshAutoStatus();
  });

  $("autoStartBtn").addEventListener("click", async () => {
    const selectedMode = normalizeExecutionModeUi($("autoExecutionMode")?.value);
    const status = runtimeDiag.autoStatus || {};
    const liveReady = Boolean(
      String(status?.orderExecution?.mode || "SIMULATED").toUpperCase() === "LIVE_HTTP"
      && status?.orderExecution?.manualLiveEnabled
    );
    if (selectedMode === "LIVE" && !liveReady) {
      window.alert("本番モードはまだ有効化されていません。先にサーバーのLIVE設定とAPIキーを完了してください。");
      return;
    }
    if (selectedMode === "LIVE") {
      const okLive = window.confirm("本番モードで自動売買を開始します。実注文が送信されます。続行しますか？");
      if (!okLive) return;
    }
    const payload = {
      autoRiskPercentPerTrade: Math.round(Number($("autoRiskPercentPerTrade").value)),
      autoIntervalSec: Number($("autoIntervalSec").value),
      autoExecutionMode: selectedMode,
      ...collectRiskSettingsPayload()
    };
    const startResult = await json("/api/v1/auto/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (startResult?.liveFallbackApplied) {
      window.alert(`LIVE条件未達のため、PAPER_LIVEで開始しました。\n理由: ${(startResult?.liveReadiness?.blockers || []).join(", ") || "LIVE条件未達"}`);
    }
    await Promise.all([refreshSettings(), refreshAutoStatus()]);
  });

  $("autoStopBtn").addEventListener("click", async () => {
    const ok = window.confirm("自動売買の停止予約を出します。保有ポジションは最適決済後に停止します。実行しますか？");
    if (!ok) return;
    await json("/api/v1/auto/stop", { method: "POST" });
    await Promise.all([refreshSettings(), refreshAutoStatus(), refreshPositions(), refreshTrades(), refreshAccount(), refreshAnalytics()]);
  });
  $("refreshReportBtn")?.addEventListener("click", async () => {
    const text = $("ablationInput")?.value || reportAblationText;
    await refreshReports(text);
  });
  $("runAblationBtn")?.addEventListener("click", async () => {
    const text = $("ablationInput")?.value || reportAblationText;
    await refreshReports(text);
  });

  $("tradeForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const now = new Date();
    const entryTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const exitTime = now.toISOString();
    const payload = {
      side: fd.get("side"),
      entryPrice: Number(fd.get("entryPrice")),
      exitPrice: Number(fd.get("exitPrice")),
      qty: Number(fd.get("qty")),
      entryTime,
      exitTime,
      assistantAdopted: fd.get("assistantAdopted") === "on"
    };

    const out = await json("/api/v1/trades", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const tradeResult = $("tradeResult");
    if (tradeResult) tradeResult.textContent = `損益: ${fmt(out.trade.netPnlJpy, 2)} 円 / 取引数量: ${positionUnitsText(out.trade.qty)}`;
    await Promise.all([refreshAccount(), refreshAnalytics(), refreshTrades(), refreshPositions()]);
  });

  $("positionRows")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".close-pos-btn");
    if (!btn) return;
    const positionId = btn.getAttribute("data-position-id");
    if (!positionId) return;
    await json(`/api/v1/positions/${positionId}/close`, { method: "POST" });
    await Promise.all([refreshPositions(), refreshTrades(), refreshAccount(), refreshAnalytics(), refreshAutoStatus()]);
  });
}

function startTickerStream() {
  const es = new EventSource("/api/v1/market/stream");
  es.addEventListener("ticker", (e) => {
    const t = JSON.parse(e.data);
    renderTicker(t);
    refreshSignalRealtime(false).catch(() => {});
    refreshRealtimeSync(false).catch(() => {});
    if (!chartRefreshBusy) {
      chartRefreshBusy = true;
      refreshChart().catch(() => {}).finally(() => {
        chartRefreshBusy = false;
      });
    }
  });
  es.onerror = () => {
    es.close();
    setTimeout(startTickerStream, 1500);
  };
}

async function init() {
  const savedTf = localStorage.getItem(TF_STORAGE_KEY);
  if (savedTf && ["1m", "5m", "15m", "1h", "1d"].includes(savedTf)) {
    chartState.tf = savedTf;
    document.querySelectorAll(".tf-tab").forEach((el) => {
      if (el.getAttribute("data-tf") === savedTf) el.classList.add("is-active");
      else el.classList.remove("is-active");
    });
  }
  bindActions();
  startTickerStream();
  await Promise.all([
    refreshSignal(),
    refreshAccount(),
    refreshAnalytics(),
    refreshTrades(),
    refreshPositions(),
    refreshChart(),
    refreshSettings(),
    refreshAutoStatus(),
    refreshExecutionStats(),
    refreshNews(),
    refreshDailyLearningStatus(),
    refreshReports(reportAblationText)
  ]);
  setInterval(() => {
    refreshSignalRealtime(false).catch(() => {});
    refreshRealtimeSync(false).catch(() => {});
  }, 15000);
  setInterval(() => {
    refreshReports(reportAblationText).catch(() => {});
  }, 60000);
}

init().catch((err) => alert(err.message));
