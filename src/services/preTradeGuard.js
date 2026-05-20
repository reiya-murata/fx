import { detectUsdJpySession } from "./executionProfile.js";

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jstHour(isoTs) {
  const t = new Date(isoTs || Date.now()).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).getUTCHours();
}

function resolveSessionKey(session, ts) {
  const base = String(session || "NY").toUpperCase();
  const h = jstHour(ts);
  if (h >= 5 && h < 7) return "ROLLOVER";
  return base;
}

export function evaluatePreTradeGuard({
  signal,
  ticker,
  executionProfile,
  contextValidation,
  degradationGuard,
  spreadStats = null,
  httpProvider = "",
  marketSource = "",
  marketInputMode = "",
  marketRealtime = false,
  entryLocationDiagnostics = null,
  cfg = {}
}) {
  if (!cfg?.enabled) {
    return {
      enabled: false,
      allowed: true,
      score: 1,
      sizeMultiplier: 1,
      reason: "pre-trade guard disabled"
    };
  }

  const spreadPips = Number(signal?.metrics?.spreadPips ?? ticker?.spreadPips ?? 0);
  const evPips = Number(signal?.metrics?.expectedValuePips ?? 0);
  const costPips = Number(signal?.metrics?.estimatedCostPips ?? 0);
  const confidence = clamp(Number(signal?.confidence || 0), 0, 1);
  const eventRisk = clamp(Number(signal?.news?.shortTermRiskLevel || 0), 0, 1);
  const execStress = clamp(Number(executionProfile?.stress || 0), 0, 4);
  const session = detectUsdJpySession(ticker?.ts || new Date().toISOString());
  const sessionKey = resolveSessionKey(session, ticker?.ts);
  const regime = String(signal?.regime || "UNKNOWN");
  const isHighVol = regime === "HIGH_VOLATILITY";
  const validationMode = String(contextValidation?.mode || "").toUpperCase();
  const degradationAdd = Number(degradationGuard?.minConfidenceAdd || 0);
  const bootstrapCfg = cfg.bootstrapRelax || {};
  const bootstrapModes = Array.isArray(bootstrapCfg.modes) ? bootstrapCfg.modes.map((x) => String(x).toUpperCase()) : [];
  const isBootstrapRelaxActive = Boolean(bootstrapCfg.enabled)
    && bootstrapModes.includes(validationMode);

  // GMO_FX HTTP tick provider relaxation
  const isGmoHttp = String(httpProvider || "").toUpperCase() === "GMO_FX";
  const entryLocationCategory = String(entryLocationDiagnostics?.entryLocationCategory || "");
  const entryLocationScore = Number(entryLocationDiagnostics?.entryLocationScore || 0);
  const isValidPullbackEntry = entryLocationCategory === "validPullbackEntry" && entryLocationScore >= 0.85;
  const executionTailMode = String(executionProfile?.executionTailGate?.mode || "NORMAL").toUpperCase();
  const isNormalExecutionTail = executionTailMode === "NORMAL";

  // Relaxed spread gate for GMO HTTP: allow 0.5pips in normal conditions
  const gmoHttpSpreadRelax = isGmoHttp && isNormalExecutionTail ? 0.15 : 0;
  const gmoHttpExecutionStressRelax = isGmoHttp && isNormalExecutionTail ? 0.35 : 0;
  const gmoHttpConfidenceRelax = isGmoHttp && isValidPullbackEntry && validationMode !== "LIVE" ? -0.05 : 0;

  const baseFloor = clamp(Number(cfg.baseMinConfidence || 0.52), 0.2, 0.95);
  const sessionAdj = Number((cfg.sessionConfidenceFloor || {})[session] || 0);
  const regimeAdj = Number((cfg.regimeConfidenceFloorAdjust || {})[regime] || 0);
  const dynSpreadCfg = cfg.dynamicSpreadGate || {};
  const dynamicSpreadEnabled = Boolean(dynSpreadCfg.enabled);
  const spreadRef = dynamicSpreadEnabled
    ? clamp(
      Math.max(
        Number(dynSpreadCfg.minSpreadFloorPips || 0.2),
        Number(spreadStats?.ewmaSpreadPips || spreadStats?.avgSpreadPips || cfg.spreadReferencePips || 0.18)
          + Number(spreadStats?.spreadStdPips || 0) * Number(dynSpreadCfg.stdMultiplier || 1)
      ),
      0.05,
      Number(dynSpreadCfg.maxSpreadCapPips || 0.45)
    )
    : Number(cfg.spreadReferencePips || 0.18);
  const spreadFloorAdd = clamp((spreadPips - spreadRef) * Number(cfg.spreadFloorSlope || 0.35), 0, 0.2);
  const dynamicConfidenceFloorRaw = clamp(
    baseFloor + sessionAdj + regimeAdj + spreadFloorAdd + eventRisk * Number(cfg.eventRiskFloorSlope || 0.12) + degradationAdd,
    0.2,
    0.97
  );
  const dynamicConfidenceFloor = clamp(
    dynamicConfidenceFloorRaw + (isBootstrapRelaxActive ? Number(bootstrapCfg.confidenceFloorDelta || 0) : 0) + gmoHttpConfidenceRelax,
    0.2,
    0.97
  );
  const sessionThresholds = cfg.sessionThresholds || {};
  const sessionCfg = isHighVol ? {} : (sessionThresholds[sessionKey] || sessionThresholds[session] || {});
  const baseMinNetEdgePips = isBootstrapRelaxActive
    ? Number(bootstrapCfg.minNetEdgePips ?? (cfg.minNetEdgePips || 0.08))
    : Number(sessionCfg.minNetEdgePips ?? cfg.minNetEdgePips ?? 0.08);
  const baseCostBufferMultiplier = Number(sessionCfg.costBufferMultiplier ?? cfg.costBufferMultiplier ?? 0.15);
  const signalStrength = clamp(Number(
    signal?.metrics?.signalStrength
    ?? signal?.signalStrength
    ?? signal?.metrics?.regimeConfidence
    ?? signal?.confidence
    ?? 0
  ), 0, 1);
  const signalAdjust = cfg.signalStrengthAdjust || {};
  const strongThreshold = Number(signalAdjust.strongThreshold ?? 0.75);
  const weakThreshold = Number(signalAdjust.weakThreshold ?? 0.55);
  const strongMultiplier = Number(signalAdjust.strongMultiplier ?? 0.85);
  const weakMultiplier = Number(signalAdjust.weakMultiplier ?? 1.25);
  let minNetEdgePips = baseMinNetEdgePips;
  if (!isHighVol) {
    if (signalStrength >= strongThreshold) minNetEdgePips *= strongMultiplier;
    else if (signalStrength < weakThreshold) minNetEdgePips *= weakMultiplier;
  }
  minNetEdgePips = Number(minNetEdgePips.toFixed(4));
  const edgeAfterBuffer = evPips - costPips * baseCostBufferMultiplier;

  const reasons = [];
  const softReasons = [];
  if (confidence < dynamicConfidenceFloor) {
    softReasons.push(`confidence below floor (${confidence.toFixed(3)} < ${dynamicConfidenceFloor.toFixed(3)})`);
  }
  if (edgeAfterBuffer < minNetEdgePips) {
    softReasons.push(`edge below cost-aware threshold (${edgeAfterBuffer.toFixed(3)} < ${minNetEdgePips.toFixed(3)})`);
  }
  reasons.push(...softReasons);
  const rawMaxSpreadGate = dynamicSpreadEnabled
    ? clamp(
      Math.max(spreadRef, Number(cfg.maxSpreadPips || 0.34)) + gmoHttpSpreadRelax,
      0.1,
      Number(dynSpreadCfg.maxSpreadCapPips || 0.45) + (isGmoHttp ? 0.2 : 0)
    )
    : Number(cfg.maxSpreadPips || 0.34) + gmoHttpSpreadRelax;

  const isGmoFxSource = String(httpProvider).toUpperCase() === "GMO_FX" || String(marketSource).toUpperCase() === "LIVE_HTTP_GMO";
  const isGmoFxHttpPoll = isGmoFxSource && String(marketInputMode).toUpperCase() === "HTTP_POLL";
  const gmoHttpPollRelaxed = isGmoFxSource &&
    String(marketInputMode).toUpperCase() === "HTTP_POLL" &&
    marketRealtime === true &&
    validationMode !== "LIVE";

  const originalSpreadGatePips = rawMaxSpreadGate;
  let appliedSpreadGatePips = originalSpreadGatePips;
  if (isGmoFxHttpPoll) {
    appliedSpreadGatePips = Math.max(appliedSpreadGatePips, 0.5);
  }
  if (gmoHttpPollRelaxed) {
    appliedSpreadGatePips = Math.max(appliedSpreadGatePips, 0.5);
  }

  if (spreadPips > appliedSpreadGatePips) {
    reasons.push(`spread too high (${spreadPips.toFixed(3)}pips > ${appliedSpreadGatePips.toFixed(3)}pips)`);
  }

  const adjustedExecutionStress = Math.max(0, execStress - gmoHttpExecutionStressRelax);
  const originalExecutionStressLimit = Number(cfg.maxExecutionStress || 1.5);
  let appliedExecutionStressLimit = originalExecutionStressLimit;
  if (gmoHttpPollRelaxed) {
    appliedExecutionStressLimit = Math.max(appliedExecutionStressLimit, 2.2);
  }

  if (adjustedExecutionStress > appliedExecutionStressLimit) {
    reasons.push(`execution stress too high (${adjustedExecutionStress.toFixed(3)})`);
  }
  if (!Boolean(cfg.allowBootstrapContext ?? true) && String(contextValidation?.mode || "") === "BOOTSTRAP") {
    reasons.push("bootstrap context disallowed");
  }

  const penalty = clamp(
    Math.max(0, dynamicConfidenceFloor - confidence) * 2.4
      + Math.max(0, minNetEdgePips - edgeAfterBuffer) * 0.9
      + Math.max(0, spreadPips - appliedSpreadGatePips) * 1.2
      + Math.max(0, adjustedExecutionStress - appliedExecutionStressLimit) * 0.5,
    0,
    1.4
  );
  const sizeMultiplier = Number(clamp(1 - penalty * Number(cfg.sizePenaltySlope || 0.55), 0.1, 1).toFixed(4));
  const score = Number(clamp(1 - penalty, 0, 1).toFixed(4));
  const hardReasonCount = reasons.length - softReasons.length;
  const warnOnlyAllowed = Boolean(isBootstrapRelaxActive && bootstrapCfg.warnOnly && hardReasonCount === 0 && softReasons.length > 0);
  const allowed = reasons.length === 0 || warnOnlyAllowed;
  const reason = allowed
    ? (warnOnlyAllowed ? `pre-trade guard warn-only: ${softReasons.join("; ")}` : "pre-trade guard pass")
    : reasons.join("; ");

  return {
    enabled: true,
    allowed,
    session,
    sessionKey,
    regime,
    score,
    sizeMultiplier,
    signalStrength: Number(signalStrength.toFixed(4)),
    minNetEdgePipsApplied: Number(minNetEdgePips.toFixed(4)),
    costBufferMultiplierApplied: Number(baseCostBufferMultiplier.toFixed(4)),
    confidence,
    confidenceFloor: Number(dynamicConfidenceFloor.toFixed(4)),
    edgeAfterBuffer: Number(edgeAfterBuffer.toFixed(4)),
    spreadPips: Number(spreadPips.toFixed(4)),
    spreadGatePips: Number(appliedSpreadGatePips.toFixed(4)),
    originalSpreadGatePips: Number(originalSpreadGatePips.toFixed(4)),
    appliedSpreadGatePips: Number(appliedSpreadGatePips.toFixed(4)),
    spreadReferencePips: Number(spreadRef.toFixed(4)),
    executionStress: Number(execStress.toFixed(4)),
    gmoHttpPollRelaxed: Boolean(gmoHttpPollRelaxed),
    originalExecutionStress: Number(execStress.toFixed(4)),
    appliedExecutionStress: Number(adjustedExecutionStress.toFixed(4)),
    originalExecutionStressLimit: Number(originalExecutionStressLimit.toFixed(4)),
    appliedExecutionStressLimit: Number(appliedExecutionStressLimit.toFixed(4)),
    marketSource: String(marketSource || ""),
    marketInputMode: String(marketInputMode || ""),
    warnOnly: warnOnlyAllowed,
    validationMode,
    spreadGateSource: isGmoHttp ? "GMO_HTTP_RELAXED" : "DEFAULT",
    brokerSpreadRelaxApplied: gmoHttpSpreadRelax > 0,
    executionStressRelaxApplied: gmoHttpExecutionStressRelax > 0,
    rawExecutionStress: Number(execStress.toFixed(4)),
    adjustedExecutionStress: Number(adjustedExecutionStress.toFixed(4)),
    edgeBlockReason: edgeAfterBuffer < minNetEdgePips ? "edge below threshold" : null,
    confidenceRelaxApplied: gmoHttpConfidenceRelax < 0,
    reason
  };
}
