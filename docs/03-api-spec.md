# API仕様（MVP）

## 1. 前提
- Base URL: /api/v1
- 認証: MVPでは簡易トークン（将来JWTへ移行）
- 通貨ペアは USDJPY 固定（MVP）

## 2. Market Data

### GET /market/ticker
- response
  - symbol
  - bid
  - ask
  - spread
  - ts

### WS /market/stream
- event: ticker
- payload
  - symbol
  - bid
  - ask
  - spread
  - ts

## 3. Orders

### POST /orders
- request
  - symbol: "USDJPY"
  - side: "BUY" | "SELL"
  - orderType: "MARKET" | "LIMIT" | "STOP"
  - qty: number
  - price?: number
  - stopLoss?: number
  - takeProfit?: number
  - assistantSignalId?: string
- response
  - orderId
  - status

### GET /orders
- query
  - status?
  - page?
  - limit?
- response
  - orders[]

## 4. Positions

### GET /positions
- response
  - positions[]
  - totalUnrealizedPnlJpy

### POST /positions/:id/close
- response
  - tradeId
  - realizedPnlJpy

## 5. Assistant

### GET /assistant/recommendation
- response
  - signalId
  - action: "BUY" | "SELL" | "HOLD"
  - entryPrice
  - stopLossPrice
  - takeProfitPrice
  - confidence
  - rationale

### POST /assistant/signals/:id/adopt
- response
  - adopted: true

## 6. Analytics

### GET /analytics/summary
- query
  - from: YYYY-MM-DD
  - to: YYYY-MM-DD
- response
  - totalTrades
  - wins
  - losses
  - winRate
  - grossProfitJpy
  - grossLossJpy
  - netProfitJpy
  - profitFactor
  - maxDrawdownJpy

### GET /analytics/by-hour
- response
  - items[]
    - hour (0-23)
    - trades
    - winRate
    - netProfitJpy

### GET /analytics/by-weekday
- response
  - items[]
    - weekday (0-6)
    - trades
    - winRate
    - netProfitJpy

### GET /analytics/assistant-impact
- response
  - adopted
    - trades
    - winRate
    - netProfitJpy
  - notAdopted
    - trades
    - winRate
    - netProfitJpy

## 7. Account

### GET /account
- response
  - initialBalanceJpy
  - currentBalanceJpy
  - equityJpy

### POST /account/reset
- response
  - initialBalanceJpy: 1000000
  - currentBalanceJpy
  - resetAt

