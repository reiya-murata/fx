import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const BOOTSTRAP_CONTEXT_PATH = resolve(process.cwd(), "data/bootstrap_context_samples.json");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadLearnedStats() {
  try {
    if (!existsSync(BOOTSTRAP_CONTEXT_PATH)) return emptyStats();
    const raw = readFileSync(BOOTSTRAP_CONTEXT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const fs = parsed?.featureStats || {};
    const samples = Math.max(0, Number(fs.samples || 0));
    return {
      samples,
      corrEv: toNum(fs.corr_ev_futureRet, 0),
      corrRr: toNum(fs.corr_rr_futureRet, 0),
      corrMom: toNum(fs.corr_mom_futureRet, 0),
      corrConf: toNum(fs.corr_conf_futureRet, 0)
    };
  } catch {
    return emptyStats();
  }
}

export function buildLearnedContext(stats = loadLearnedStats()) {
  const samples = Number(stats.samples || 0);
  if (samples < 60) {
    return {
      ready: false,
      samples,
      confidenceDelta: 0,
      minExpectedValueDelta: 0,
      minRiskRewardDelta: 0,
      weights: { ev: 0, rr: 0, momentum: 0, confidence: 0 }
    };
  }

  const strength = clamp(Math.log10(samples + 1) / 4, 0.15, 0.9);
  const corrEv = clamp(Number(stats.corrEv || 0), -0.6, 0.6);
  const corrRr = clamp(Number(stats.corrRr || 0), -0.6, 0.6);
  const corrMom = clamp(Number(stats.corrMom || 0), -0.6, 0.6);
  const corrConf = clamp(Number(stats.corrConf || 0), -0.6, 0.6);

  // Positive correlation => loosen gate slightly, negative => tighten.
  const minExpectedValueDelta = Number(clamp(-corrEv * 0.16 * strength, -0.08, 0.12).toFixed(4));
  const minRiskRewardDelta = Number(clamp(-corrRr * 0.2 * strength, -0.12, 0.18).toFixed(4));
  const confidenceDelta = Number(clamp((corrConf + corrMom * 0.45) * 0.12 * strength, -0.08, 0.08).toFixed(4));

  return {
    ready: true,
    samples,
    confidenceDelta,
    minExpectedValueDelta,
    minRiskRewardDelta,
    weights: {
      ev: Number((corrEv * strength).toFixed(4)),
      rr: Number((corrRr * strength).toFixed(4)),
      momentum: Number((corrMom * strength).toFixed(4)),
      confidence: Number((corrConf * strength).toFixed(4))
    }
  };
}

function emptyStats() {
  return { samples: 0, corrEv: 0, corrRr: 0, corrMom: 0, corrConf: 0 };
}
