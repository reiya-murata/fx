import { normalizeNewsItem } from "./news.js";

const DEFAULT_FEEDS = [
  "https://www.federalreserve.gov/feeds/press_all.xml",
  "https://www.whitehouse.gov/briefing-room/feed/",
  "https://home.treasury.gov/news/press-releases/rss",
  "https://www.bls.gov/feed/bls_latest.rss",
  "https://www.bea.gov/news/rss.xml",
  "https://www3.nhk.or.jp/rss/news/cat5.xml",
  "https://www3.nhk.or.jp/rss/news/cat6.xml",
  "https://www.jiji.com/rss/ranking.rdf",
  "https://www.imf.org/en/News/RSS"
];

const FX_KEYWORDS = [
  "usd",
  "jpy",
  "yen",
  "dollar",
  "fx",
  "forex",
  "fomc",
  "fed",
  "boj",
  "bank of japan",
  "interest rate",
  "cpi",
  "inflation",
  "nfp",
  "employment",
  "gdp",
  "tariff",
  "sanction",
  "trade war",
  "election",
  "prime minister",
  "president",
  "white house",
  "congress",
  "geopolitical",
  "conflict",
  "ドル",
  "円",
  "為替",
  "日銀",
  "日本銀行",
  "財務省",
  "為替介入",
  "政策金利",
  "金融政策",
  "インフレ",
  "雇用",
  "実質賃金",
  "首相",
  "内閣",
  "国債利回り"
];

const HIGH_IMPACT_HINTS = [
  "fomc",
  "rate decision",
  "policy rate",
  "federal reserve",
  "bank of japan",
  "boj",
  "cpi",
  "inflation",
  "nfp",
  "nonfarm",
  "gdp",
  "tariff",
  "sanction",
  "election",
  "geopolitical",
  "conflict",
  "military",
  "日銀",
  "日本銀行",
  "財務省",
  "為替介入",
  "金融政策",
  "政策金利",
  "cpi",
  "雇用統計"
];

const JP_SOURCE_HOSTS = [
  "www3.nhk.or.jp",
  "www.nhk.or.jp",
  "www.jiji.com"
];

const JP_POLICY_HINTS = [
  "日銀",
  "日本銀行",
  "財務省",
  "内閣",
  "首相",
  "政策",
  "金融",
  "金利",
  "為替",
  "円",
  "ドル",
  "介入",
  "インフレ",
  "雇用",
  "景気",
  "国債",
  "経済"
];

export function parseFeedList(value) {
  if (!value) return [...DEFAULT_FEEDS];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function collectNewsOnce({ feeds, fetchImpl = fetch, now = new Date() }) {
  const urls = Array.isArray(feeds) && feeds.length ? feeds : DEFAULT_FEEDS;
  const all = [];

  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          "user-agent": "fx-demo-trade-engine/1.0",
          accept: "application/rss+xml, application/xml, text/xml, */*"
        }
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const entries = extractFeedEntries(xml, url);
      all.push(...entries);
    } catch {
      // Keep collector fault-tolerant; failures are handled by caller metrics.
    }
  }

  const filtered = all
    .filter((entry) => isRelevantEntry(entry))
    .slice(0, 80)
    .map((entry) => normalizeNewsItem({
      source: entry.source,
      country: inferCountry(entry.headline, entry.source),
      currency: "USD/JPY",
      impact: inferImpact(entry.headline, entry.description),
      headline: entry.headline,
      expected: entry.expected,
      actual: entry.actual,
      ts: entry.ts,
      eventTime: entry.eventTime || entry.ts
    }));

  return {
    items: filtered,
    fetchedAt: now.toISOString(),
    feedCount: urls.length
  };
}

function extractFeedEntries(xml, sourceUrl) {
  const source = sourceFromUrl(sourceUrl);
  const out = [];

  const itemBlocks = matchBlocks(xml, "item");
  for (const block of itemBlocks) {
    const headline = decodeXmlEntities(pickTag(block, ["title"]))?.trim();
    if (!headline) continue;
    const description = decodeXmlEntities(pickTag(block, ["description", "content:encoded", "summary"]));
    const ts = parseTime(pickTag(block, ["pubDate", "dc:date", "published", "updated"]));
    const parsed = parseEventMeta(headline, description, ts);
    out.push({ headline, ts, source, sourceUrl, description, ...parsed });
  }

  const entryBlocks = matchBlocks(xml, "entry");
  for (const block of entryBlocks) {
    const headline = decodeXmlEntities(pickTag(block, ["title"]))?.trim();
    if (!headline) continue;
    const description = decodeXmlEntities(pickTag(block, ["summary", "content", "content:encoded"]));
    const ts = parseTime(pickTag(block, ["updated", "published", "dc:date", "pubDate"]));
    const parsed = parseEventMeta(headline, description, ts);
    out.push({ headline, ts, source, sourceUrl, description, ...parsed });
  }

  return out;
}

function matchBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m = re.exec(xml);
  while (m) {
    out.push(m[1]);
    m = re.exec(xml);
  }
  return out;
}

function pickTag(block, tags) {
  for (const tag of tags) {
    const re = new RegExp(`<${escapeTag(tag)}[^>]*>([\\s\\S]*?)<\\/${escapeTag(tag)}>`, "i");
    const m = re.exec(block);
    if (m && m[1]) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  }
  return "";
}

function escapeTag(tag) {
  return tag.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function parseTime(value) {
  const t = new Date(value || Date.now()).toISOString();
  return t;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "auto-feed";
  }
}

function isRelevantEntry(entry) {
  const raw = String(entry?.headline || "");
  const h = raw.toLowerCase();
  if (FX_KEYWORDS.some((key) => raw.includes(key) || h.includes(String(key).toLowerCase()))) return true;
  const source = String(entry?.source || "").toLowerCase();
  const isJpSource = JP_SOURCE_HOSTS.some((host) => source.includes(host));
  if (!isJpSource) return false;
  if (source.includes("jiji.com")) {
    return JP_POLICY_HINTS.some((k) => raw.includes(k));
  }
  // BOJ/MOF/官邸は政策情報を優先ソースとして取り込む
  return true;
}

function inferImpact(headline, description = "") {
  const raw = `${String(headline || "")} ${String(description || "")}`;
  const h = raw.toLowerCase();
  if (HIGH_IMPACT_HINTS.some((key) => raw.includes(key) || h.includes(String(key).toLowerCase()))) return "HIGH";
  if (
    h.includes("minutes") || h.includes("statement") || h.includes("press conference")
    || raw.includes("議事要旨") || raw.includes("声明") || raw.includes("会見")
  ) return "HIGH";
  return "MEDIUM";
}

function inferCountry(headline, source = "") {
  const raw = String(headline || "");
  const h = raw.toLowerCase();
  const s = String(source || "").toLowerCase();
  if (s.includes("nhk.or.jp") || s.includes("jiji.com")) return "JP";
  if (s.includes("federalreserve.gov") || s.includes("whitehouse.gov") || s.includes("treasury.gov") || s.includes("bls.gov") || s.includes("bea.gov")) return "US";
  const hasUs = h.includes("us") || h.includes("federal reserve") || h.includes("fed") || h.includes("white house") || h.includes("treasury") || raw.includes("米");
  const hasJp = h.includes("japan") || h.includes("boj") || h.includes("yen") || h.includes("ministry of finance")
    || raw.includes("日本") || raw.includes("日銀") || raw.includes("財務省") || raw.includes("円");
  if (hasUs && hasJp) return "US/JP";
  if (hasUs) return "US";
  if (hasJp) return "JP";
  return "GLOBAL";
}

function parseEventMeta(headline, description, fallbackTs) {
  const text = `${String(headline || "")} ${String(description || "")}`;
  const lower = text.toLowerCase();
  const expected = findMetricValue(text, "expected");
  const actual = findMetricValue(text, "actual");
  const eventTime = parseEventTime(text, fallbackTs);
  const isMacro = /(cpi|pce|gdp|nfp|employment|policy rate|rate decision|fomc|boj|bank of japan|fed)/i.test(lower);
  return {
    expected,
    actual,
    eventTime: isMacro ? eventTime : fallbackTs
  };
}

function findMetricValue(text, label) {
  const re = new RegExp(`${label}\\s*[:=]\\s*([+-]?[0-9]+(?:\\.[0-9]+)?\\s*%?)`, "i");
  const m = re.exec(String(text || ""));
  return m ? m[1].trim() : null;
}

function parseEventTime(text, fallbackTs) {
  const d = new Date(fallbackTs || Date.now());
  const m = /([01]?[0-9]|2[0-3]):([0-5][0-9])(?:\s*(AM|PM))?(?:\s*(JST|UTC|GMT|ET|EST|EDT))?/i.exec(String(text || ""));
  if (!m) return new Date(fallbackTs || Date.now()).toISOString();
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = String(m[3] || "").toUpperCase();
  const tz = String(m[4] || "UTC").toUpperCase();

  if (ampm === "PM" && hh < 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;

  if (tz === "JST") {
    const utcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh - 9, mm, 0, 0);
    return new Date(utcMs).toISOString();
  }
  if (tz === "ET" || tz === "EST" || tz === "EDT") {
    const utcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh + 5, mm, 0, 0);
    return new Date(utcMs).toISOString();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0)).toISOString();
}
