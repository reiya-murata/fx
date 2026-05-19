const POSITIVE_USDJPY = [
  "fed hike",
  "us inflation up",
  "strong us jobs",
  "hawkish fed",
  "boj easing",
  "japan recession",
  "yen weakness",
  "us treasury yields rise",
  "tariff on japan",
  "米金利上昇",
  "利上げ",
  "日銀緩和",
  "円安",
  "米雇用強い",
  "インフレ加速"
];

const NEGATIVE_USDJPY = [
  "fed cut",
  "us recession",
  "weak us jobs",
  "dovish fed",
  "boj tightening",
  "yen strength",
  "risk-off",
  "safe haven yen",
  "geopolitical tension",
  "ceasefire risk-off",
  "利下げ",
  "日銀引き締め",
  "円高",
  "米景気後退",
  "地政学リスク"
];

const POLITICAL_KEYS = [
  "president",
  "white house",
  "prime minister",
  "election",
  "parliament",
  "congress",
  "cabinet",
  "policy",
  "tariff",
  "sanction",
  "trade war",
  "geopolitical",
  "military",
  "conflict",
  "ceasefire",
  "首相",
  "内閣",
  "与党",
  "野党",
  "選挙",
  "政権",
  "関税",
  "制裁"
];

const MACRO_KEYS = [
  "fomc",
  "fed",
  "boj",
  "bank of japan",
  "cpi",
  "pce",
  "inflation",
  "rate decision",
  "policy rate",
  "nfp",
  "nonfarm",
  "employment",
  "gdp",
  "ism",
  "retail sales",
  "treasury",
  "日銀",
  "日本銀行",
  "財務省",
  "金融政策",
  "政策金利",
  "為替介入",
  "雇用統計",
  "実質賃金"
];

const TRANSLATIONS = [
  ["federal reserve", "FRB"],
  ["bank of japan", "日銀"],
  ["boj", "日銀"],
  ["fomc", "FOMC"],
  ["policy rate", "政策金利"],
  ["rate decision", "金利決定"],
  ["inflation", "インフレ"],
  ["cpi", "CPI"],
  ["employment", "雇用"],
  ["nonfarm payrolls", "非農業部門雇用者数"],
  ["nfp", "NFP"],
  ["tariff", "関税"],
  ["sanction", "制裁"],
  ["trade war", "貿易摩擦"],
  ["geopolitical", "地政学"],
  ["conflict", "紛争"],
  ["risk-off", "リスクオフ"],
  ["risk-on", "リスクオン"],
  ["yen", "円"],
  ["dollar", "ドル"],
  ["usd", "ドル"],
  ["jpy", "円"]
];

export function normalizeNewsItem(item) {
  const headline = String(item.headline || "").trim();
  const tags = detectTags(headline);
  const sentimentScore = scoreHeadline(headline);
  return {
    id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ts: item.ts || new Date().toISOString(),
    eventTime: item.eventTime || item.ts || new Date().toISOString(),
    source: item.source || "manual",
    country: item.country || "GLOBAL",
    currency: item.currency || "USD/JPY",
    impact: sanitizeImpact(item.impact),
    expected: item.expected ?? null,
    actual: item.actual ?? null,
    headline,
    headlineJa: item.headlineJa || summarizeHeadlineJa(headline, tags, sentimentScore),
    tags,
    relevanceScore: computeRelevanceScore(headline, tags),
    sentimentScore
  };
}

export function buildNewsContext(newsItems, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const preEventBlockMinutes = Number(options.preEventBlockMinutes ?? 15);
  const postEventBlockMinutes = Number(options.postEventBlockMinutes ?? 15);

  const cutoff = now.getTime() - 6 * 60 * 60 * 1000;
  const recent = newsItems.filter((n) => new Date(n.ts).getTime() >= cutoff);
  if (!recent.length) {
    return {
      score: 0,
      highImpactEvent: false,
      tradingBlocked: false,
      shortTermRiskLock: false,
      shortTermRiskLevel: 0,
      linkedEventIds: [],
      activeEventIds: [],
      dominantTag: "NONE",
      eventFeatureVector: buildEmptyEventVector(),
      directionBias: "NEUTRAL",
      rationale: "短期売買に影響するニュースなし"
    };
  }

  const weighted = recent.map((n) => {
    const impact = impactWeight(n.impact);
    const relevance = clamp(Number(n.relevanceScore || 0.5), 0.2, 1.3);
    const decay = newsTimeDecay(now.getTime() - new Date(n.ts).getTime());
    return Number(n.sentimentScore || 0) * impact * relevance * decay.scoreWeight;
  });
  const scoreRaw = weighted.reduce((s, v) => s + v, 0) / Math.max(1, weighted.length);
  const score = clamp(scoreRaw, -1, 1);
  const highImpactEvent = recent.some((n) => n.impact === "HIGH");

  const tradingBlocked = recent.some((n) => {
    // Use hard block only for scheduled high-impact events; avoid locking on generic headlines.
    const hasScheduleData = hasEventCalendarData(n);
    if (n.impact !== "HIGH" || !hasScheduleData) return false;
    const et = new Date(n.eventTime).getTime();
    const preMs = preEventBlockMinutes * 60 * 1000;
    const postMs = postEventBlockMinutes * 60 * 1000;
    return now.getTime() >= et - preMs && now.getTime() <= et + postMs;
  });

  const shortWindowMs = 45 * 60 * 1000;
  const shortTermRiskSignals = recent.filter((n) => {
    const age = now.getTime() - new Date(n.ts).getTime();
    const tags = Array.isArray(n.tags) ? n.tags : detectTags(n.headline || "");
    return age <= shortWindowMs && (tags.includes("POLITICAL") || tags.includes("GEOPOLITICAL") || tags.includes("MACRO"));
  });
  const shortTermRiskLevel = clamp(
    shortTermRiskSignals.reduce((acc, n) => {
      const ageMs = now.getTime() - new Date(n.ts).getTime();
      const decay = newsTimeDecay(ageMs);
      return acc + impactWeight(n.impact) * clamp(Number(n.relevanceScore || 0.5), 0.2, 1.3) * decay.riskWeight;
    }, 0) / 3,
    0,
    1
  );
  const shortTermRiskLock = shortTermRiskLevel >= 0.72;
  const linkedEvents = buildLinkedEvents(recent, now);
  const linkedEventIds = linkedEvents.map((e) => String(e.id)).slice(0, 8);
  const activeEventIds = linkedEvents.filter((e) => e.isActiveWindow).map((e) => String(e.id)).slice(0, 6);
  const eventFeatureVector = buildEventFeatureVector(linkedEvents);
  const dominantTag = resolveDominantTag(eventFeatureVector);

  let directionBias = "NEUTRAL";
  if (score >= 0.2) directionBias = "BUY";
  if (score <= -0.2) directionBias = "SELL";

  const rationale = tradingBlocked
    ? "重要イベント時間帯のため停止"
    : shortTermRiskLock
      ? "政治/地政学イベントで短期リスク高"
      : highImpactEvent
        ? "重要ニュースを検出"
        : "ニュースを売買判定に反映中";

  return {
    score,
    highImpactEvent,
    tradingBlocked,
    shortTermRiskLock,
    shortTermRiskLevel,
    linkedEventIds,
    activeEventIds,
    dominantTag,
    eventFeatureVector,
    directionBias,
    rationale
  };
}

export function scoreHeadline(headline) {
  const raw = String(headline || "");
  const h = raw.toLowerCase();
  let score = 0;
  for (const key of POSITIVE_USDJPY) {
    if (raw.includes(key) || h.includes(String(key).toLowerCase())) score += 0.35;
  }
  for (const key of NEGATIVE_USDJPY) {
    if (raw.includes(key) || h.includes(String(key).toLowerCase())) score -= 0.35;
  }
  if (h.includes("cpi") && h.includes("us") && h.includes("up")) score += 0.2;
  if (raw.includes("米") && raw.includes("CPI") && (raw.includes("上振れ") || raw.includes("上昇"))) score += 0.2;
  if (h.includes("geopolitical") || h.includes("conflict") || h.includes("military")) score -= 0.22;
  if (raw.includes("地政学") || raw.includes("紛争")) score -= 0.22;
  if (h.includes("tariff") && h.includes("us")) score += 0.1;
  if (raw.includes("関税") && raw.includes("米")) score += 0.1;
  return clamp(score, -1, 1);
}

function detectTags(headline) {
  const raw = String(headline || "");
  const h = raw.toLowerCase();
  const tags = [];
  if (POLITICAL_KEYS.some((k) => raw.includes(k) || h.includes(String(k).toLowerCase()))) tags.push("POLITICAL");
  if (
    h.includes("geopolitical") || h.includes("conflict") || h.includes("military")
    || raw.includes("地政学") || raw.includes("紛争")
  ) tags.push("GEOPOLITICAL");
  if (MACRO_KEYS.some((k) => raw.includes(k) || h.includes(String(k).toLowerCase()))) tags.push("MACRO");
  if (!tags.length) tags.push("GENERAL");
  return tags;
}

function computeRelevanceScore(headline, tags) {
  const raw = String(headline || "");
  const h = raw.toLowerCase();
  let score = 0.45;
  if (
    h.includes("usd") || h.includes("jpy") || h.includes("yen") || h.includes("dollar")
    || raw.includes("ドル") || raw.includes("円") || raw.includes("為替")
  ) score += 0.25;
  if (Array.isArray(tags) && tags.includes("MACRO")) score += 0.2;
  if (Array.isArray(tags) && tags.includes("POLITICAL")) score += 0.15;
  if (Array.isArray(tags) && tags.includes("GEOPOLITICAL")) score += 0.15;
  return clamp(score, 0.2, 1.3);
}

function summarizeHeadlineJa(headline, tags, score) {
  const h = String(headline || "").toLowerCase();
  let ja = String(headline || "");
  for (const [en, jp] of TRANSLATIONS) {
    ja = ja.replace(new RegExp(en, "ig"), jp);
  }

  const tagText = Array.isArray(tags) && tags.length ? tags.join("/") : "GENERAL";
  const dir = score >= 0.2 ? "ドル円上方向" : (score <= -0.2 ? "ドル円下方向" : "方向中立");
  if (ja === headline) {
    return `自動要約: ${tagText} | ${dir} | ${headline}`;
  }
  return `自動要約: ${tagText} | ${dir} | ${ja}`;
}

function impactWeight(impact) {
  if (impact === "HIGH") return 1.5;
  if (impact === "LOW") return 0.7;
  return 1;
}

function sanitizeImpact(impact) {
  if (impact === "HIGH" || impact === "LOW") return impact;
  return "MEDIUM";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildLinkedEvents(recent, now) {
  const nowMs = now.getTime();
  return recent.map((n) => {
    const tsMs = new Date(n.ts || now).getTime();
    const etMs = new Date(n.eventTime || n.ts || now).getTime();
    const ageMin = Math.max(0, (nowMs - tsMs) / 60000);
    const eventDeltaMin = (nowMs - etMs) / 60000;
    const tags = Array.isArray(n.tags) ? n.tags : detectTags(n.headline || "");
    const relevance = clamp(Number(n.relevanceScore || 0.5), 0.2, 1.3);
    const decay = newsTimeDecay(nowMs - tsMs);
    const score = impactWeight(n.impact) * relevance * decay.scoreWeight;
    const hasScheduleData = hasEventCalendarData(n);
    return {
      id: String(n.id || ""),
      impact: n.impact || "MEDIUM",
      tags,
      score: Number(score.toFixed(4)),
      eventDeltaMin: Number(eventDeltaMin.toFixed(2)),
      // Treat active window as strict event window only when event-calendar fields exist.
      isActiveWindow: hasScheduleData && Math.abs(eventDeltaMin) <= 30,
      expected: n.expected ?? null,
      actual: n.actual ?? null,
      surprise: parseSurprise(n.expected, n.actual)
    };
  }).sort((a, b) => b.score - a.score);
}

function hasEventCalendarData(item) {
  const expected = item?.expected;
  const actual = item?.actual;
  return (expected !== null && expected !== undefined && String(expected).trim() !== "")
    || (actual !== null && actual !== undefined && String(actual).trim() !== "");
}

function buildEventFeatureVector(linkedEvents) {
  if (!linkedEvents.length) return buildEmptyEventVector();
  const total = linkedEvents.length;
  const highImpactCount = linkedEvents.filter((e) => e.impact === "HIGH").length;
  const macroCount = linkedEvents.filter((e) => e.tags.includes("MACRO")).length;
  const politicalCount = linkedEvents.filter((e) => e.tags.includes("POLITICAL")).length;
  const geoCount = linkedEvents.filter((e) => e.tags.includes("GEOPOLITICAL")).length;
  const activeCount = linkedEvents.filter((e) => e.isActiveWindow).length;
  const validSurprises = linkedEvents.map((e) => Number(e.surprise)).filter((v) => Number.isFinite(v));
  const absSurpriseAvg = validSurprises.length
    ? validSurprises.reduce((s, v) => s + Math.abs(v), 0) / validSurprises.length
    : 0;
  return {
    totalEvents: total,
    highImpactCount,
    macroCount,
    politicalCount,
    geopoliticalCount: geoCount,
    activeEventCount: activeCount,
    highImpactRatio: Number((highImpactCount / total).toFixed(4)),
    macroRatio: Number((macroCount / total).toFixed(4)),
    politicalRatio: Number((politicalCount / total).toFixed(4)),
    geopoliticalRatio: Number((geoCount / total).toFixed(4)),
    activeRatio: Number((activeCount / total).toFixed(4)),
    avgAbsSurprise: Number(absSurpriseAvg.toFixed(4))
  };
}

function buildEmptyEventVector() {
  return {
    totalEvents: 0,
    highImpactCount: 0,
    macroCount: 0,
    politicalCount: 0,
    geopoliticalCount: 0,
    activeEventCount: 0,
    highImpactRatio: 0,
    macroRatio: 0,
    politicalRatio: 0,
    geopoliticalRatio: 0,
    activeRatio: 0,
    avgAbsSurprise: 0
  };
}

function newsTimeDecay(ageMs) {
  const m = Math.max(0, ageMs / 60000);
  if (m <= 30) {
    return { phase: "IMMEDIATE", scoreWeight: 1, riskWeight: 1.15 };
  }
  if (m <= 120) {
    return { phase: "SHORT", scoreWeight: 0.72, riskWeight: 0.78 };
  }
  return { phase: "LONG", scoreWeight: 0.42, riskWeight: 0.38 };
}

function resolveDominantTag(vec) {
  const pairs = [
    ["MACRO", Number(vec.macroRatio || 0)],
    ["POLITICAL", Number(vec.politicalRatio || 0)],
    ["GEOPOLITICAL", Number(vec.geopoliticalRatio || 0)]
  ];
  pairs.sort((a, b) => b[1] - a[1]);
  if (pairs[0][1] <= 0) return "GENERAL";
  return pairs[0][0];
}

function parseSurprise(expected, actual) {
  const e = parseMetric(expected);
  const a = parseMetric(actual);
  if (!e || !a) return null;
  const targetUnit = e.unit === "UNKNOWN" ? a.unit : e.unit;
  const eNorm = normalizeMetric(e, targetUnit);
  const aNorm = normalizeMetric(a, targetUnit);
  if (!(Number.isFinite(eNorm) && Number.isFinite(aNorm))) return null;
  const denom = Math.max(Math.abs(eNorm), 1e-6);
  return Number(((aNorm - eNorm) / denom).toFixed(6));
}

function parseMetric(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  const m = /([-+]?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  let unit = "INDEX";
  if (s.includes("%")) unit = "PERCENT";
  else if (s.includes("bp") || s.includes("bps")) unit = "BPS";
  else if (/[k]\b/.test(s)) unit = "THOUSAND";
  else if (/[m]\b/.test(s)) unit = "MILLION";
  else if (/[b]\b/.test(s)) unit = "BILLION";
  return { value: n, unit };
}

function normalizeMetric(metric, targetUnit) {
  if (!metric) return Number.NaN;
  const src = metric.unit;
  const v = Number(metric.value);
  if (!Number.isFinite(v)) return Number.NaN;
  if (src === targetUnit) return v;
  if (targetUnit === "PERCENT" && src === "BPS") return v / 100;
  if (targetUnit === "BPS" && src === "PERCENT") return v * 100;
  if (targetUnit === "MILLION" && src === "THOUSAND") return v / 1000;
  if (targetUnit === "THOUSAND" && src === "MILLION") return v * 1000;
  if (targetUnit === "BILLION" && src === "MILLION") return v / 1000;
  if (targetUnit === "MILLION" && src === "BILLION") return v * 1000;
  return v;
}
