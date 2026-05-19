# FX Demo Trade App Blueprint

このリポジトリは、USD/JPY短期トレード向けデモアプリの設計・初期実装用ベースです。

## 初期条件
- 初期資金: 1,000,000円
- 対象: USD/JPY
- 用途: 短期トレード（デモ）

## ドキュメント
- /Users/reiya/Documents/fx/docs/01-product-requirements.md
- /Users/reiya/Documents/fx/docs/02-data-model.md
- /Users/reiya/Documents/fx/docs/03-api-spec.md
- /Users/reiya/Documents/fx/docs/04-analytics-spec.md
- /Users/reiya/Documents/fx/docs/05-implementation-roadmap.md
- /Users/reiya/Documents/fx/docs/06-strategy-spec.md
- /Users/reiya/Documents/fx/docs/07-risk-spec.md
- /Users/reiya/Documents/fx/docs/08-validation-spec.md
- /Users/reiya/Documents/fx/docs/09-api-runbook.md
- /Users/reiya/Documents/fx/docs/10-elite-trading-architecture.md

## DBスキーマ
- /Users/reiya/Documents/fx/db/schema.sql

## 売買エンジン実装（初版）
- /Users/reiya/Documents/fx/src/engine/regime.js
- /Users/reiya/Documents/fx/src/engine/strategy.js
- /Users/reiya/Documents/fx/src/engine/risk.js
- /Users/reiya/Documents/fx/src/engine/assistant.js
- /Users/reiya/Documents/fx/src/config/defaults.js

## 実行方法
- デモ出力: `npm run demo`
- テスト: `npm test`
- API起動: `npm start`
- UI表示: `http://localhost:3000/`
- ライブ接続: `MARKET_WS_URL=wss://... npm start`
- SBI FX想定プロファイル: `BROKER_PROFILE=SBI_FX npm start`
- 手数料の手動上書き(bps): `BROKER_FEE_BPS=0 npm start`
- 自動売買: UIの `Auto Mode` から開始/停止（解除まで継続）

## 次の実装ステップ
1. モック市場データを実データ配信へ置換
2. 永続化をJSONからPostgreSQLへ移行
3. 検証仕様書に沿ってバックテスト・OOS評価を実施
4. UIにローソク足チャートと時間帯別ヒートマップを追加
