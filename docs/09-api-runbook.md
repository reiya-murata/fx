# API Runbook（ローカル）

## 起動
- `npm start`

## ライブ価格接続（任意）
- `MARKET_FEED_MODE=live`
- `MARKET_WS_URL=wss://...`
- `MARKET_WS_SUBSCRIBE='{\"type\":\"subscribe\", ...}'` (必要な配信先のみ)
- 未接続/切断時は自動でモック価格へフォールバック

## 主要エンドポイント
- `GET /api/v1/health`
- `GET /api/v1/market/ticker`
- `GET /api/v1/market/stream` (SSE)
- `GET /api/v1/market/candles?tf=1m&limit=120`
- `GET /api/v1/assistant/recommendation`
- `GET /api/v1/settings`
- `POST /api/v1/settings`
- `GET /api/v1/auto/status`
- `POST /api/v1/auto/start`
- `POST /api/v1/auto/stop`
- `GET /api/v1/news?limit=30`
- `POST /api/v1/news/ingest`
- `GET /api/v1/positions`
- `POST /api/v1/positions/:id/close`
- `POST /api/v1/orders/execute`
- `GET /api/v1/audit?limit=100`
- `GET /api/v1/trades?limit=50`
- `POST /api/v1/trades`
- `GET /api/v1/account`
- `POST /api/v1/account/reset`
- `GET /api/v1/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/v1/analytics/by-hour`
- `GET /api/v1/analytics/by-weekday`
- `GET /api/v1/analytics/assistant-impact`

## 取引登録サンプル
```bash
curl -X POST 'http://localhost:3000/api/v1/trades' \
  -H 'content-type: application/json' \
  -d '{
    "side": "BUY",
    "entryPrice": 150.000,
    "exitPrice": 150.080,
    "qty": 1000,
    "entryTime": "2026-02-14T12:00:00.000Z",
    "exitTime": "2026-02-14T12:30:00.000Z",
    "assistantAdopted": true
  }'
```

## 永続化
- 状態ファイル: `/Users/reiya/Documents/fx/data/state.json`
- 保存対象:
  - account
  - settings
  - trades
  - orders
  - fills
  - positions
  - assistantSignals
  - newsEvents
  - auditLogs

## UI
- ブラウザで `http://localhost:3000/` を開く
- 画面機能:
  - リアルタイムティッカー表示（SSE）
  - 簡易ラインチャート表示（1分足）
  - AI推奨取得
  - 自動売買モード（開始/停止）
  - 売買方向は自動判定（BUY/SELLをユーザーが選択しない）
  - 自動売買リスク% / 実行間隔 / 自動クローズ時間
  - 推奨初期値: 実行間隔 0.5秒 / 自動クローズ 0.5秒
  - 最小設定: 0.1秒（高頻度は約定コスト増に注意）
  - 自動モードはポジションを保持し、SL/TP/TTLで決済
  - 停止時は自動モードの未決済ポジションをクローズ
  - 自己進化ON/OFFと最大リスク%設定
  - Shadow learning切替
  - ニュース停止ウィンドウ設定（発表前後）
  - ニュース手動投入と提案反映
  - トレード登録
  - 直近トレード履歴表示
  - 未決済ポジション一覧と手動クローズ
  - 口座リセット
  - 当日分析サマリー表示
