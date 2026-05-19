function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function applyBrokerProfile(baseConfig, profileName = "") {
  const cfg = clone(baseConfig || {});
  const name = String(profileName || "DEFAULT").toUpperCase();
  cfg.brokerMeta = {
    profile: name,
    label: name,
    baselineSpreadPips: 0.2,
    avgLatencyMs: Number(cfg.execution?.baseLatencyMs || 280)
  };
  cfg.brokerProfile = {
    ...(cfg.brokerProfile || {}),
    minUnits: Number(cfg.brokerProfile?.minUnits || cfg.positionSizing?.brokerMinUnits || cfg.positionSizing?.minUnits || 100),
    unitStep: Number(cfg.brokerProfile?.unitStep || cfg.positionSizing?.unitStep || 100),
    legalMaxLeverage: 25,
    requiredMarginRate: 0.04
  };

  if (name === "SBI_FX" || name === "SBIFX" || name === "SBI") {
    // SBI FXトレード（USD/JPY）: 1〜100万通貨のスプレッド基準値 0.18（銭）を基準化
    cfg.execution.feeBps = 0;
    cfg.execution.baseLatencyMs = 260;
    cfg.execution.latencyJitterMs = 140;
    cfg.spread.maxPipsNormal = 0.3;
    cfg.spread.highVolatilityPips = 0.6;
    cfg.anomalyGate.spreadPipsHardLimit = 0.9;
    if (cfg.executionCalibration && typeof cfg.executionCalibration === "object") {
      cfg.executionCalibration.targetLatencyMs = 260;
    }
    cfg.brokerMeta = {
      profile: "SBI_FX",
      label: "SBI FXトレード",
      baselineSpreadPips: 0.18,
      avgLatencyMs: 260
    };
    cfg.brokerProfile = {
      ...(cfg.brokerProfile || {}),
      minUnits: 1,
      unitStep: 1,
      legalMaxLeverage: 25,
      requiredMarginRate: 0.04
    };
    cfg.positionSizing = {
      ...(cfg.positionSizing || {}),
      brokerMinUnits: 1,
      minUnits: 1,
      unitStep: 1,
      legalMaxLeverage: 25,
      requiredMarginRate: 0.04
    };
  }

  if (name === "GMO_FX" || name === "GMO" || name === "GMOCOIN") {
    // GMOコイン（外国為替FX）向けの保守的な初期値。
    cfg.execution.feeBps = 0;
    cfg.execution.baseLatencyMs = 220;
    cfg.execution.latencyJitterMs = 130;
    cfg.spread.maxPipsNormal = 0.35;
    cfg.spread.highVolatilityPips = 0.7;
    cfg.anomalyGate.spreadPipsHardLimit = 1.0;
    if (cfg.executionCalibration && typeof cfg.executionCalibration === "object") {
      cfg.executionCalibration.targetLatencyMs = 220;
    }
    if (cfg.auto?.edgeSizing) {
      cfg.auto.edgeSizing.executionQualityP95LatencyRefMs = 760;
      cfg.auto.edgeSizing.executionQualityRejectRateRef = 0.05;
      cfg.auto.edgeSizing.latencyMinMultiplier = 0.7;
    }
    if (cfg.auto?.tailPenalty) {
      cfg.auto.tailPenalty.p95LatencyStartMs = 700;
      cfg.auto.tailPenalty.p95LatencyEndMs = 1100;
      cfg.auto.tailPenalty.rejectRateStart = 0.04;
      cfg.auto.tailPenalty.rejectRateEnd = 0.1;
    }
    if (cfg.auto?.executionTailGate) {
      cfg.auto.executionTailGate.avgPipelineLatencyMsLimit = 680;
      cfg.auto.executionTailGate.p95PipelineLatencyMsLimit = 950;
      cfg.auto.executionTailGate.rejectRateLimit = 0.1;
    }
    cfg.brokerMeta = {
      profile: "GMO_FX",
      label: "GMOコイン FX",
      baselineSpreadPips: 0.2,
      avgLatencyMs: 220
    };
    cfg.brokerProfile = {
      ...(cfg.brokerProfile || {}),
      // GMOクリック証券 FXネオ: UI上の0.1取引単位は内部では1,000通貨。
      minUnits: 1000,
      unitStep: 1000,
      legalMaxLeverage: 25,
      requiredMarginRate: 0.04
    };
    cfg.positionSizing = {
      ...(cfg.positionSizing || {}),
      brokerMinUnits: cfg.brokerProfile.minUnits,
      minUnits: cfg.brokerProfile.minUnits,
      unitStep: cfg.brokerProfile.unitStep,
      legalMaxLeverage: cfg.brokerProfile.legalMaxLeverage,
      requiredMarginRate: cfg.brokerProfile.requiredMarginRate
    };
  }

  if (process.env.BROKER_FEE_BPS !== undefined) {
    const n = Number(process.env.BROKER_FEE_BPS);
    if (Number.isFinite(n)) cfg.execution.feeBps = clamp(n, 0, 20);
  }
  if (process.env.BROKER_AVG_LATENCY_MS !== undefined) {
    const n = Number(process.env.BROKER_AVG_LATENCY_MS);
    if (Number.isFinite(n)) {
      const v = Math.round(clamp(n, 20, 1500));
      cfg.execution.baseLatencyMs = v;
      cfg.brokerMeta.avgLatencyMs = v;
      if (cfg.executionCalibration && typeof cfg.executionCalibration === "object") {
        cfg.executionCalibration.targetLatencyMs = v;
      }
    }
  }

  return cfg;
}
