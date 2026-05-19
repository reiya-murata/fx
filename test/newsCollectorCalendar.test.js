import test from "node:test";
import assert from "node:assert/strict";
import { collectNewsOnce } from "../src/services/newsCollector.js";

const SAMPLE = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>US CPI release 13:30 UTC expected: 3.1% actual: 3.4%</title>
    <description>Federal Reserve and inflation outlook update</description>
    <pubDate>Sat, 14 Feb 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test("collector parses event metadata for macro headlines", async () => {
  const result = await collectNewsOnce({
    feeds: ["https://example.com/calendar.xml"],
    fetchImpl: async () => ({ ok: true, text: async () => SAMPLE })
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.impact, "HIGH");
  assert.equal(item.expected, "3.1%");
  assert.equal(item.actual, "3.4%");
  assert.match(String(item.eventTime), /T13:30:00\.000Z$/);
});
