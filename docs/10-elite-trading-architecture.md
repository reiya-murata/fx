# Elite Trading Architecture（自己進化 + ニュース統合）

## 1. 重要な前提
- どの手法でも「常時利益最大化」を保証はできない。
- 目的は、期待値の正を維持しつつ、損失の尾を制御すること。

## 2. システム構成
- Regime Engine: トレンド/レンジ/高ボラ判定
- Strategy Engine: エントリー/SL/TP候補生成
- Adaptive Engine: 過去取引から閾値とリスク倍率を動的調整
- News Engine: 日米ニュースをスコア化し、方向バイアス・高影響時停止を適用
- Risk Engine: ユーザー指定の最大リスク%内でlot算出
- Analytics Engine: 勝率、PF、DD、採用効果を検証

## 3. 自己進化（オンライン学習）
- 入力: 直近トレード群（PnL、勝率、DD）
- 過学習対策:
  - EWMA平滑化
  - 最小サンプル数未満は調整禁止
  - 1サイクルの変更幅上限
  - Shadow Mode
- 出力:
  - minRiskRewardDelta
  - minExpectedValueDelta
  - confidenceDelta
  - riskMultiplier
- 悪化時は自動で厳格化・リスク縮小
- 改善時は軽微に緩和（過剰最適化防止）

## 4. ニュース統合
- 入力: 日米関連ヘッドライン（impact付き）
- 処理:
  - USDJPY方向スコア化
  - HIGH impact時の取引停止ウィンドウ（発表前後）
- 出力:
  - directionBias（BUY/SELL/NEUTRAL）
  - highImpactEvent（bool）
  - tradingBlocked（bool）

## 5. ユーザー資産連動lot
- ユーザー指定 `maxRiskPercentPerTrade` を基準
- 最終リスク量:
  - userRisk% × adaptive riskMultiplier × 連敗縮小
- これにより、攻めたい/守りたいをユーザーが制御可能

## 6. 実装済みAPI
- `GET/POST /api/v1/settings`
- `POST /api/v1/news/ingest`
- `GET /api/v1/news`
- `GET /api/v1/assistant/recommendation`（adaptive/news反映済み）
- `POST /api/v1/orders/execute`（order -> fill -> position/trade）
- `GET /api/v1/audit`（監査ログ）

## 7. 次の強化
- ニュース自動取得（RSS/API）を定時実行
- 特徴量拡張（スプレッド急拡大率、時間帯、連続性）
- ウォークフォワードで学習パラメータ自動更新
