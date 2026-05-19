import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPORT_PATH = resolve(process.cwd(), "data/daily_learning_reports.json");

function ensureFile() {
  if (existsSync(REPORT_PATH)) return;
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ items: [] }, null, 2));
}

function loadRaw() {
  ensureFile();
  try {
    const raw = readFileSync(REPORT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export function appendLearningReport(report) {
  const prev = loadRaw();
  const items = [...prev, report].slice(-180);
  writeFileSync(REPORT_PATH, JSON.stringify({ items }, null, 2));
  return report;
}

export function listLearningReports(limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 30), 180));
  const items = loadRaw().slice(-safeLimit).reverse();
  return items;
}
