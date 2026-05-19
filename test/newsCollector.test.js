import test from "node:test";
import assert from "node:assert/strict";
import { collectNewsOnce } from "../src/services/newsCollector.js";

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Fed signals higher rates as US inflation remains elevated</title>
    <pubDate>Sat, 14 Feb 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Local sports update</title>
    <pubDate>Sat, 14 Feb 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test("collectNewsOnce extracts and filters relevant FX headlines", async () => {
  const result = await collectNewsOnce({
    feeds: ["https://example.com/feed.xml"],
    fetchImpl: async () => ({ ok: true, text: async () => SAMPLE_RSS })
  });

  assert.ok(result.items.length >= 1);
  assert.match(result.items[0].headline.toLowerCase(), /fed|inflation|usd/);
  assert.equal(result.items[0].currency, "USD/JPY");
});
