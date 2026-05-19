export const DEFAULT_CONFIG = {
  symbol: "USDJPY",
  pipSize: 0.01,
  signalVersion: "v1.1.0",
  spread: {
    maxPipsNormal: 0.25,
    highVolatilityPips: 0.4
  },
  trend: {
    shortEmaPeriod: 9,
    longEmaPeriod: 21,
    slopeLookback: 5,
    minTrendEmaGapPips: 0.8
  },
  range: {
    lookbackCandles: 30,
    maxRangePips: 24,
    edgeFactor: 0.18,
    // P0: range entry chance↑ while avoiding noisy spread periods.
    earlyReversalEnabled: true,
    earlyReversalEdgeFactor: 0.24,
    earlyReversalMaxSpreadPips: 0.32,
    momentumBreakout: {
      enabled: true,
      lookbackBars: 5,
      minStructurePairs: 3,
      shortMaPeriod: 5,
      midMaPeriod: 10,
      nearBreakoutPips: 1.2,
      maxSpreadPips: 0.32,
      minExpectedValuePips: -0.45,
      minScore: 5,
      rsiMinBuy: 45,
      rsiMaxBuy: 72,
      rsiMinSell: 28,
      rsiMaxSell: 55
    }
  },
  volatility: {
    atrPeriod: 14,
    highVolMultiplier: 1.7
  },
  executionGate: {
    minExpectedValuePips: -0.02,
    minRiskReward: 1.0
  },
  regimeProfiles: {
    TREND_UP: {
      stopAtrMultiplier: 0.95,
      tpAtrMultiplier: 2.1,
      minRiskRewardDelta: 0.1,
      confidenceDelta: 0.03
    },
    TREND_DOWN: {
      stopAtrMultiplier: 0.95,
      tpAtrMultiplier: 2.1,
      minRiskRewardDelta: 0.1,
      confidenceDelta: 0.03
    },
    RANGE: {
      stopAtrMultiplier: 0.85,
      tpAtrMultiplier: 1.35,
      minRiskRewardDelta: -0.12,
      confidenceDelta: -0.01
    },
    HIGH_VOLATILITY: {
      stopAtrMultiplier: 0.75,
      tpAtrMultiplier: 0.9,
      minRiskRewardDelta: 0.28,
      minExpectedValueDelta: 0.08,
      confidenceDelta: -0.06
    }
  },
  risk: {
    riskPerTrade: 0.005,
    riskPerTradeMax: 0.01,
    dailyStopPercent: 0.025,
    hardStopPercent: 0.03,
    weeklyDrawdownPercent: 0.06,
    consecutiveLossScale: {
      2: 0.75,
      3: 0.5,
      4: 0.2
    }
  },
  execution: {
    baseLatencyMs: 120,
    latencyJitterMs: 220,
    rejectProbability: 0.015,
    partialFillProbability: 0.12,
    maxSlippagePips: 0.8,
    randomSlippagePips: 0.08,
    favorableSlipProbability: 0.08,
    feeBps: 0.15,
    depthLevels: 6,
    depthBaseQty: 40000,
    depthStepPips: 0.18,
    latencySlippagePipsPerSec: 0.05,
    minOrderQty: 1,
    sessionProfile: {
      TOKYO: {
        spreadMultiplier: 1.03,
        latencyMultiplier: 1.02,
        rejectAdd: 0.002
      },
      LONDON: {
        spreadMultiplier: 0.96,
        latencyMultiplier: 0.9,
        rejectAdd: -0.004
      },
      NY: {
        spreadMultiplier: 1.08,
        latencyMultiplier: 1.12,
        rejectAdd: 0.004
      }
    },
    eventProfile: {
      HIGH_IMPACT: {
        stressAdd: 0.6,
        rejectAdd: 0.02,
        slippageMul: 1.35,
        depthMul: 0.75
      },
      POLITICAL: {
        stressAdd: 0.25,
        rejectAdd: 0.006,
        slippageMul: 1.12,
        depthMul: 0.92
      },
      GEOPOLITICAL: {
        stressAdd: 0.35,
        rejectAdd: 0.01,
        slippageMul: 1.2,
        depthMul: 0.88
      }
    }
  },
  positionSizing: {
    balanceJPY: 10000,
    riskPercentPerTrade: 5.0,
    riskAmountJPY: 500,
    sizingMode: "riskPercent",
    selectedRiskProfile: "smallCapitalAggressive",
    maxEffectiveLeverage: 20,
    legalMaxLeverage: 25,
    requiredMarginRate: 0.04,
    minUnits: 1,
    brokerMinUnits: 1,
    unitStep: 1,
    maxUnits: 50000,
    maxRiskAmountJPY: 1000,
    warningRiskPercentPerTrade: 5,
    dangerRiskPercentPerTrade: 10,
    hardBlockRiskPercentPerTrade: 15,
    warningEffectiveLeverage: 15,
    marginLeverage: 25,
    defaultStopLossPips: 3,
    stopLossFallbackPolicy: {
      PAPER_LIVE: "warn_and_use_fallback",
      LIVE: "block"
    }
  },
  brokerProfile: {
    minUnits: 1,
    unitStep: 1,
    legalMaxLeverage: 25,
    requiredMarginRate: 0.04
  },
  capitalScaling: {
    enabled: true,
    mode: "tiered",
    tiers: [
      {
        id: "UNDER_20K",
        label: "1万円〜2万円未満",
        minBalanceJPY: 0,
        maxBalanceJPY: 19999,
        riskPercentPerTrade: 5.0,
        maxRiskPercentPerTrade: 8.0,
        maxEffectiveLeverage: 10,
        allowedModes: ["BASE"],
        fullEnabled: false,
        semiEnabled: false
      },
      {
        id: "TIER_20K_50K",
        label: "2万円〜5万円未満",
        minBalanceJPY: 20000,
        maxBalanceJPY: 49999,
        riskPercentPerTrade: 4.0,
        maxRiskPercentPerTrade: 7.0,
        maxEffectiveLeverage: 15,
        allowedModes: ["BASE", "SEMI"],
        fullEnabled: false,
        semiEnabled: true
      },
      {
        id: "TIER_50K_100K",
        label: "5万円〜10万円未満",
        minBalanceJPY: 50000,
        maxBalanceJPY: 99999,
        riskPercentPerTrade: 3.0,
        maxRiskPercentPerTrade: 6.0,
        maxEffectiveLeverage: 20,
        allowedModes: ["BASE", "SEMI"],
        fullEnabled: false,
        semiEnabled: true,
        fullTrialEnabled: true,
        fullTrialRiskMultiplier: 0.5,
        fullTrialMaxTradesPerDay: 2
      },
      {
        id: "TIER_100K_300K",
        label: "10万円〜30万円未満",
        minBalanceJPY: 100000,
        maxBalanceJPY: 299999,
        riskPercentPerTrade: 2.0,
        maxRiskPercentPerTrade: 4.0,
        maxEffectiveLeverage: 20,
        allowedModes: ["BASE", "SEMI", "FULL"],
        fullEnabled: true,
        semiEnabled: true
      },
      {
        id: "TIER_300K_PLUS",
        label: "30万円以上",
        minBalanceJPY: 300000,
        maxBalanceJPY: null,
        riskPercentPerTrade: 1.0,
        maxRiskPercentPerTrade: 2.0,
        maxEffectiveLeverage: 15,
        allowedModes: ["BASE", "SEMI", "FULL"],
        fullEnabled: true,
        semiEnabled: true
      }
    ],
    promotionRules: {
      requireBalanceAboveTierForTrades: 30,
      requireRollingPFMin: 1.10,
      requireRollingExpectancyPositive: true,
      requireNoDrawdownWarning: true,
      requireNoExecutionStress: true,
      requireNoConsecutiveLossWarning: true
    },
    demotionRules: {
      demoteImmediatelyIfBalanceFallsBelowTier: true,
      demoteOnDrawdownWarning: true,
      demoteOnDailyLossWarning: true,
      demoteOnConsecutiveLosses: 2,
      demoteOnExecutionStress: true,
      demoteOnRollingExpectancyNegative: true
    },
    fullUnlockRules: {
      normalFullMinBalanceJPY: 100000,
      trialFullMinBalanceJPY: 50000,
      trialFullRiskMultiplier: 0.5,
      trialFullMaxTradesPerDay: 2,
      rollingPFMin: 1.20,
      requireRollingExpectancyPositive: true,
      maxDrawdownPct: 6,
      requireNoExecutionStress: true
    }
  },
  riskProfiles: {
    conservative: {
      initialBalanceJPY: 100000,
      riskAmountJPY: 1000,
      maxRiskAmountJPY: 3000,
      warningRiskPercentPerTrade: 2,
      dangerRiskPercentPerTrade: 3,
      hardBlockRiskPercentPerTrade: 5,
      warningEffectiveLeverage: 5,
      maxEffectiveLeverage: 5,
      legalMaxLeverage: 25,
      dailyWarningLossJPY: 1000,
      dailyPauseLossJPY: 2000,
      dailyHardStopLossJPY: 3000,
      maxConsecutiveLossesPerDay: 3,
      pauseLiveBalanceJPY: 50000,
      hardStopLiveBalanceJPY: 30000,
      fullModeMinBalanceJPY: 50000,
      semiModeMinBalanceJPY: 20000
    },
    smallCapitalAggressive: {
      initialBalanceJPY: 10000,
      riskAmountJPY: 500,
      maxRiskAmountJPY: 1000,
      warningRiskPercentPerTrade: 5,
      dangerRiskPercentPerTrade: 10,
      hardBlockRiskPercentPerTrade: 15,
      warningEffectiveLeverage: 15,
      maxEffectiveLeverage: 20,
      legalMaxLeverage: 25,
      dailyWarningLossJPY: 1000,
      dailyPauseLossJPY: 2000,
      dailyHardStopLossJPY: 3000,
      maxConsecutiveLossesPerDay: 3,
      pauseLiveBalanceJPY: 5000,
      hardStopLiveBalanceJPY: 3000,
      fullModeMinBalanceJPY: 50000,
      semiModeMinBalanceJPY: 20000
    }
  },
  brokerIntegration: {
    orderMode: "SIMULATED",
    manualLiveEnabled: false,
    provider: "NONE",
    symbol: "USD_JPY",
    timeoutMs: 6000
  },
  adaptive: {
    minSampleSize: 30,
    ewmaAlpha: 0.12,
    maxRiskStepPerCycle: 0.06,
    shadowMode: false
  },
  news: {
    preEventBlockMinutes: 15,
    postEventBlockMinutes: 15,
    blockOnShortTermRiskLock: false
  },
  auto: {
    killSwitch: {
      enabled: true,
      ddThrottlePercent: 0.07,
      ddStopPercent: 0.1,
      consecutiveLossThrottle: 8,
      consecutiveLossStop: 14,
      throttleRiskMultiplier: 0.5
    },
    rollingExpectancy: {
      enabled: true,
      lookbackTrades: 30,
      minTrades: 25,
      // P0: 運用初期はRolling Rescue停止を抑制し、データ収集を優先する。
      startupNoRescueTrades: 200,
      warningExpectancyR: -0.01,
      warningProfitFactor: 1.03,
      rescueExpectancyR: -0.015,
      rescueProfitFactor: 1.01,
      rescueRiskMultiplier: 0.25,
      rescueCooldownSec: 300,
      // P0: uptime-first staged rescue cooldown/risk.
      rescueStages: [
        { breakdown: 1, cooldownSec: 300, riskMultiplier: 0.25 },
        { breakdown: 2, cooldownSec: 600, riskMultiplier: 0.2 },
        { breakdown: 3, cooldownSec: 1200, riskMultiplier: 0.15 }
      ],
      stopExpectancyR: -0.02,
      stopProfitFactor: 1.0,
      throttleRiskMultiplier: 0.25,
      extremeRiskMultiplier: 0.1,
      stopConsecutiveBreakdown: 3
    },
    executionTailGate: {
      enabled: true,
      lookbackRecords: 1500,
      minSamples: 80,
      avgPipelineLatencyMsLimit: 650,
      p95PipelineLatencyMsLimit: 900,
      p99PipelineLatencyMsLimit: 1200,
      // P0: hard blocks only for severe tails, others handled by size penalty.
      rejectRateLimit: 0.1,
      slippageP95Multiplier: 2.8,
      cooldownSecOnP95Breach: 1800,
      // P2: session-aware override hooks (filled by ops after enough data).
      bySession: {
        TOKYO: {},
        LONDON: {},
        NY: {}
      }
    },
    tailPenalty: {
      enabled: true,
      p95LatencyStartMs: 650,
      p95LatencyEndMs: 1050,
      p95LatencyMinMultiplier: 0.45,
      p99LatencyStartMs: 1050,
      p99LatencyEndMs: 1500,
      p99LatencyMinMultiplier: 0.6,
      slippageStartMultiplier: 1.4,
      slippageEndMultiplier: 2.8,
      slippageMinMultiplier: 0.45,
      rejectRateStart: 0.03,
      rejectRateEnd: 0.1,
      rejectRateMinMultiplier: 0.4,
      minMultiplier: 0.35,
      maxMultiplier: 1,
      bySession: {
        TOKYO: {},
        LONDON: {},
        NY: {}
      }
    },
    noTradeZone: {
      enabled: true,
      // P0: uptime-first; schedule windows are size-down by default.
      hardBlockWindowsJst: [],
      sizeDownWindowsJst: ["05:00-06:30", "08:25-09:10", "14:55-15:20", "11:00-13:30", "00:30-02:00"],
      sizeDownMultiplier: 0.6,
      conditionalMode: {
        enabled: true,
        tailRejectRateBlock: 0.1,
        tailP95LatencyBlockMs: 1050,
        tailSlippageBlockMultiplier: 2.8,
        tailPenaltyHardBlock: 0.55,
        minTailSamplesForHardBlock: 30,
        highImpactSizeDownMultiplier: 0.4
      }
    },
    edgeSizing: {
      enabled: true,
      minMultiplier: 0.5,
      maxMultiplier: 2.0,
      executionQualityP95LatencyRefMs: 700,
      executionQualityRejectRateRef: 0.04,
      latencyMinMultiplier: 0.65
    },
    // P1: LIVE移行は定量条件を満たした時のみ許可。
    liveGoNoGo: {
      enabled: true,
      // P0: 初期運用時はLIVE未達でもPAPER_LIVEへ自動フォールバックして開始を止めない。
      fallbackToPaperLiveOnFail: true,
      minAutoTrades: 200,
      minTelemetrySamples: 150,
      minProfitFactor: 1.05,
      maxDrawdownRatio: 0.08,
      maxP95PipelineLatencyMs: 900,
      maxRejectRate: 0.08,
      maxP95SlippagePips: 0.56
    },
    // P0: dual-mode operation for monthly return targeting with DD control.
    tradeMode: {
      baseLabel: "BASE",
      semiLabel: "SEMI",
      fullLabel: "FULL",
      targetShares: {
        base: 0.75,
        semi: 0.2,
        full: 0.05
      },
      // P0-6: auto-adjust guardrails to avoid premature overfitting.
      tuningGuard: {
        minTradesNoAdjust: 200,
        minTradesWeeklyAdjust: 500,
        weeklyAdjustmentCap: 0.03,
        monthlyAdjustmentCap: 0.05
      },
      semi: {
        enabled: true,
        minEdgeScore: 1.2,
        minExecutionQualityScore: 0.82,
        minTailPenaltyMultiplier: 0.88,
        allowHighEdgeRange: true,
        rangeEdgeScoreThreshold: 1.35,
        preTrade: {
          extraMinNetEdgePips: 0.01
        },
        edgeClamp: { min: 0.8, max: 1.6 }
      },
      full: {
        enabled: true,
        minEdgeScore: 1.35,
        minExecutionQualityScore: 0.9,
        minTailPenaltyMultiplier: 0.95,
        preTrade: {
          extraMinNetEdgePips: 0.03
        },
        edgeClamp: { min: 0.9, max: 2.0 }
      },
      base: {
        edgeClamp: { min: 0.5, max: 1.4 }
      },
      modeDowngrade: {
        fullDisableExpectancyLookback: 20,
        fullDisablePfLookback: 10,
        fullDisableSemiPfLookback: 30,
        fullDisableExpectancyR: 0,
        fullDisablePf: 1.0,
        semiDisablePf: 1.05,
        maxConsecutiveLosses: 4,
        ddBrakes: [
          { ddPercent: 4, maxMode: "SEMI", riskMultiplier: 1.0 },
          { ddPercent: 6, maxMode: "BASE", riskMultiplier: 1.0 },
          { ddPercent: 8, maxMode: "BASE", riskMultiplier: 0.8 },
          { ddPercent: 9, maxMode: "BASE", riskMultiplier: 0.6 }
        ],
        tailMaxScaleEnabled: true
      }
    },
    partialExit: {
      enabled: true,
      firstTakeR: 1.0,
      firstTakePortion: 0.5,
      degradedFirstTakeR: 0.8,
      degradedFirstTakePortion: 0.6,
      minRemainingQty: 1,
      trailAtrMultiplier: 2.4,
      // P0: edge/regime adaptive exit for profit expansion without new ML.
      trendHighEdgeScore: 1.2,
      trendFirstTakePortion: 0.35,
      trendFirstTakeR: 1.2,
      trendTrailAtrMultiplier: 2.8,
      rangeLowEdgeScore: 1.1,
      rangeFirstTakePortion: 0.6,
      rangeFirstTakeR: 0.9,
      rangeTrailAtrMultiplier: 2.0,
      trendDegradedAttenuation: 0.7,
      aggressive: {
        minFirstTakePortion: 0.25,
        maxFirstTakePortion: 0.35,
        minFirstTakeR: 1.2,
        maxFirstTakeR: 1.5,
        minTrailAtrMultiplier: 2.8,
        maxTrailAtrMultiplier: 3.2,
        degradedPortionCap: 0.45
      },
      semiAggressive: {
        minFirstTakePortion: 0.35,
        maxFirstTakePortion: 0.45,
        minFirstTakeR: 1.15,
        maxFirstTakeR: 1.3,
        minTrailAtrMultiplier: 2.6,
        maxTrailAtrMultiplier: 2.9,
        degradedPortionCap: 0.5
      },
      fullAggressive: {
        minFirstTakePortion: 0.2,
        maxFirstTakePortion: 0.3,
        minFirstTakeR: 1.35,
        maxFirstTakeR: 1.6,
        minTrailAtrMultiplier: 3.0,
        maxTrailAtrMultiplier: 3.5,
        degradedPortionCap: 0.45
      }
    },
    entryCooldown: {
      enabled: false,
      lookbackTrades: 8,
      minSampleTrades: 5,
      triggerConsecutiveLosses: 3,
      triggerLossRate: 0.7,
      cooldownSec: 90
    },
    reentryGuard: {
      enabled: true,
      // P1: 利確直後の同方向連打を防ぎ、押し目/戻りを待って再エントリーする。
      cooldownSecAfterTakeProfit: 90,
      cooldownSecAfterTakeProfitTrend: 45,
      cooldownSecAfterTakeProfitRange: 180,
      cooldownSecAfterStopLoss: 360,
      highVolOrSameDirectionCooldownSecMin: 420,
      highVolOrSameDirectionCooldownSecMax: 600,
      minPullbackPips: 1.2,
      minMomentumForImmediateReentry: 0.08,
      minTrendSlope15mPipsForImmediateReentry: 0.18,
      // P1: 直近足が一方向に走っている間の逆張りエントリーを防ぐ。
      trendContinuation: {
        enabled: true,
        lookbackBars1m: 12,
        minDownMovePipsForBuyBlock: 2.2,
        minUpMovePipsForSellBlock: 1.8,
        minReboundPipsForBuy: 0.7,
        minPullbackPipsForSell: 0.7
      }
    },
    expectancyGate: {
      enabled: true,
      lookbackTrades: 48,
      minTrades: 20,
      // P0: 運用初期は期待値ゲートを警告モードにして停止連発を防ぐ。
      startupNoBlockTrades: 200,
      minExpectancyJpy: 80,
      minWinRate: 0.44,
      minProfitFactor: 1.02,
      maxDrawdownJpy: 70000,
      // P0: 初期運用で compressed memory だけを理由に自動売買が停止し続けるのを防ぐ。
      blockOnCompressedMemoryFail: false
    },
    // P0: 初期学習フェーズはリスク縮小の下限を設け、学習用トレード件数を確保する。
    startupRiskRelax: {
      enabled: true,
      maxTrades: 200,
      minRiskFractionOfBase: 0.7
    }
  },
  walkForwardGate: {
    // P0: 運用初期はWFAを警告運用（ブロックしない）。
    enforceForAuto: false,
    blockWhenInsufficient: false,
    lookbackTrades: 320,
    minTrades: 80,
    oosRatio: 0.3,
    minOosWinRate: 0.5,
    minOosProfitFactor: 1.1,
    minOosExpectancyJpy: 0,
    maxOosDrawdownJpy: 90000,
    minScoreImprovement: 0
  },
  metaGate: {
    enabled: true,
    minScore: 0.56,
    weights: {
      benchmark: 0.16,
      walkForward: 0.22,
      expectancy: 0.22,
      anomaly: 0.16,
      bandit: 0.16,
      objective: 0.08
    }
  },
  objective: {
    enabled: true,
    scoreScaleJpy: 1500,
    drawdownScaleJpy: 90000,
    costScaleJpy: 12000,
    lambdaDrawdown: 0.35,
    muCost: 0.15
  },
  confidenceCalibration: {
    enabled: true,
    lookbackTrades: 320,
    minTrades: 40,
    bins: 6,
    shrinkage: 20
  },
  preTradeGuard: {
    enabled: true,
    baseMinConfidence: 0.52,
    sessionConfidenceFloor: {
      TOKYO: 0.02,
      LONDON: 0,
      NY: 0.015
    },
    regimeConfidenceFloorAdjust: {
      HIGH_VOLATILITY: 0.05,
      RANGE: 0.01,
      TREND_UP: 0,
      TREND_DOWN: 0
    },
    spreadReferencePips: 0.18,
    spreadFloorSlope: 0.35,
    eventRiskFloorSlope: 0.12,
    minNetEdgePips: 0.08,
    costBufferMultiplier: 0.15,
    sessionThresholds: {
      TOKYO: { minNetEdgePips: 0.07, costBufferMultiplier: 0.12 },
      LONDON: { minNetEdgePips: 0.09, costBufferMultiplier: 0.18 },
      NY: { minNetEdgePips: 0.10, costBufferMultiplier: 0.20 },
      ROLLOVER: { minNetEdgePips: 0.14, costBufferMultiplier: 0.30 }
    },
    signalStrengthAdjust: {
      strongThreshold: 0.75,
      weakThreshold: 0.55,
      strongMultiplier: 0.85,
      weakMultiplier: 1.25
    },
    maxSpreadPips: 0.34,
    // P0: avoid permanent HOLD in mildly wide-spread sessions.
    dynamicSpreadGate: {
      enabled: true,
      ewmaAlpha: 0.08,
      stdMultiplier: 0.8,
      maxSpreadCapPips: 0.45,
      minSpreadFloorPips: 0.2
    },
    maxExecutionStress: 1.5,
    allowBootstrapContext: true,
    sizePenaltySlope: 0.55,
    // P0: 初期データ不足時（LIVE_LIMITED/BOOTSTRAP）は厳しすぎる閾値を緩和して稼働率を確保。
    bootstrapRelax: {
      enabled: true,
      modes: ["BOOTSTRAP", "LIVE_LIMITED"],
      confidenceFloorDelta: -0.06,
      minNetEdgePips: -0.25,
      warnOnly: true
    }
  },
  degradationGuard: {
    enabled: true,
    lookbackTrades: 36,
    minTrades: 20,
    warningExpectancyJpy: -90,
    warningWinRate: 0.42,
    warningLossStreak: 6,
    warningRiskMultiplier: 0.45,
    severeExpectancyJpy: -260,
    severeWinRate: 0.32,
    severeLossStreak: 9,
    severeRiskMultiplier: 0.25,
    blockOnSevere: false
  },
  ensembleGate: {
    enabled: true,
    minProfiles: 3,
    minAgreementRatio: 0.66,
    minActionableRatio: 0.34,
    maxConfidenceStd: 0.14,
    maxEvStd: 0.55,
    maxRrStd: 0.42,
    minSizeMultiplier: 0.25
  },
  patternQualityGate: {
    enabled: true,
    enforce: false,
    lookbackTrades: 260,
    minTrades: 60,
    minScore: 0.5,
    minSizeMultiplier: 0.85
  },
  contextValidation: {
    enabled: true,
    minTradesPerContext: 20,
    minTradesPerCoarseContext: 40,
    allowBootstrapContexts: true,
    // P0: increase startup execution rate while still capped by context risk tiers.
    bootstrapSizeMultiplier: 0.6,
    bootstrapRiskReferencePercent: 5,
    bootstrapMinSizeMultiplier: 0.12,
    bootstrapCapByRiskPercent: [
      { maxRiskPercent: 2, cap: 0.25 },
      { maxRiskPercent: 5, cap: 0.5 },
      { maxRiskPercent: 10, cap: 0.75 },
      { maxRiskPercent: 100, cap: 0.8 }
    ],
    bootstrapRegimes: ["TREND_UP", "TREND_DOWN", "RANGE"],
    // P0: prevent startup deadlock in live-paper collection; allow limited-size bootstrap contexts.
    maxNewsRiskForBootstrap: 0.55,
    maxSpreadPipsForBootstrap: 0.35
  },
  learningMemory: {
    enabled: true,
    ewmaAlpha: 0.02,
    maxContexts: 3000
  },
  sizing: {
    enabled: true,
    lookbackTrades: 90,
    minTrades: 20,
    maxKellyFraction: 0.35,
    minSizeMultiplier: 0.45,
    maxSizeMultiplier: 1.25,
    drawdownPenaltyScale: 1.2
  },
  capitalAllocation: {
    enabled: true,
    minRiskPercent: 1,
    maxRiskPercent: 10,
    heatLookbackTrades: 40,
    maxHeatPenalty: 0.45,
    objectiveBoost: 0.25
  },
  rlBandit: {
    enabled: true,
    observationMode: true,
    holdAdvantageThreshold: 0.03,
    baseAlpha: 0.12,
    explorationC: 0.22,
    maxSizeMultiplier: 1.25,
    minSizeMultiplier: 0.5,
    guardBypass: {
      enabled: true,
      maxConsecutiveHolds: 20,
      maxHoldSec: 8
    },
    objective: {
      profitWeight: 0.62,
      winWeight: 0.2,
      drawdownWeight: 0.11,
      costWeight: 0.07
    },
    objectiveByTag: {
      MACRO: { profitWeight: 0.7, winWeight: 0.16, drawdownWeight: 0.09, costWeight: 0.05 },
      POLITICAL: { profitWeight: 0.55, winWeight: 0.2, drawdownWeight: 0.17, costWeight: 0.08 },
      GEOPOLITICAL: { profitWeight: 0.5, winWeight: 0.18, drawdownWeight: 0.22, costWeight: 0.1 },
      GENERAL: { profitWeight: 0.62, winWeight: 0.2, drawdownWeight: 0.11, costWeight: 0.07 }
    },
    ops: {
      autoSnapshotEveryTrades: 25,
      autoSnapshotMinIntervalMin: 15,
      rollbackLookbackTrades: 40,
      rollbackMinTrades: 20,
      rollbackWinRateFloor: 0.34,
      rollbackNetLossFloorJpy: -50000,
      rollbackMinIntervalMin: 30
    }
  },
  anomalyGate: {
    spreadPipsHardLimit: 0.55,
    rejectWindowSec: 120,
    rejectCountLimit: 3,
    newsSpikeWindowSec: 300,
    newsSpikeCountLimit: 8,
    blockDurationSec: 120,
    reducedDurationSec: 180,
    reducedSizeMultiplier: 0.35
  },
  benchmark: {
    enforceForAuto: false,
    minTrades: 200,
    winRateMin: 0.5,
    profitFactorMin: 1.2,
    maxDrawdownJpyMax: 120000,
    netProfitJpyMin: 0
  },
  exit: {
    stopAtrMultiplier: 1.0,
    tpAtrMultiplier: 1.8,
    ttlMinutes: 60,
    eventRisk: {
      tightenThreshold: 0.45,
      highRiskThreshold: 0.72,
      maxExtraRiskScore: 0.6,
      earlyExitBoost: 0.18
    },
    learning: {
      enabled: true,
      lookbackTrades: 120,
      minTrades: 20,
      // P1: reduce over-adaptation freedom for exits.
      maxHoldMultiplier: 1.2,
      minHoldMultiplier: 0.85,
      tpAdjustMax: 0.1,
      slAdjustMax: 0.1,
      slowUpdateSmoothing: 0.75
    }
  },
  shadowAB: {
    enabled: true,
    profiles: ["BASELINE", "CANDIDATE_A", "CANDIDATE_B", "CANDIDATE_C"],
    minSamplesPerProfile: 30,
    promoteMinExpectancyDiffJpy: 80,
    promoteMaxDdWorseningJpy: 12000,
    candidateAdjustmentsByProfile: {
      CANDIDATE_A: {
        minRiskRewardDelta: 0.08,
        minExpectedValuePipsDelta: 0.03,
        confidenceDelta: 0.02
      },
      CANDIDATE_B: {
        minRiskRewardDelta: 0.14,
        minExpectedValuePipsDelta: 0.05,
        confidenceDelta: 0.01
      },
      CANDIDATE_C: {
        minRiskRewardDelta: 0.04,
        minExpectedValuePipsDelta: 0.02,
        confidenceDelta: 0.03
      }
    }
  },
  regimeSmoothing: {
    enabled: true,
    lookbackTrades: 40,
    stayBias: 0.16
  },
  trendPullback: {
    enabled: true,
    // P0: reduce opportunity loss while keeping pullback confirmation.
    breakoutBbZ: 3.0,
    retraceBbZ: 1.3,
    minMomentumResume: 0.06,
    // P1: stricter trend entries for better price quality (buy lower / sell higher).
    // Keep moderate thresholds to avoid over-blocking healthy setups.
    minBuyMomentum: 0.01,
    maxBuyEntryBbZ: 1.25,
    buyBbzBypassMomentum: 0.7,
    minTrendSlope15mBuyPips: 0.06,
    maxSellMomentum: -0.01,
    minSellEntryBbZ: -1.25,
    sellBbzBypassMomentum: -0.7,
    maxTrendSlope15mSellPips: -0.06
  },
  executionCalibration: {
    enabled: true,
    lookbackTrades: 200,
    minTrades: 30,
    telemetryLookbackRecords: 5000,
    telemetryMinRecords: 150,
    targetRejectRate: 0.025,
    targetSlippagePips: 0.28,
    targetLatencyMs: 280
  }
};
