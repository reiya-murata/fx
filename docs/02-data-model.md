# データモデル設計（MVP）

## 1. 前提
- DB: PostgreSQL
- 時刻はすべて UTC 保存
- 金額は Decimal（小数精度を維持）

## 2. テーブル一覧
- users
- accounts
- market_ticks
- orders
- fills
- positions
- assistant_signals
- trades
- daily_metrics

## 3. テーブル詳細

### 3.1 users
- id (uuid, pk)
- email (text, unique)
- created_at (timestamptz)

### 3.2 accounts
- id (uuid, pk)
- user_id (uuid, fk -> users.id)
- base_currency (text, default: JPY)
- initial_balance (numeric(18,2), default: 1000000.00)
- current_balance (numeric(18,2))
- created_at (timestamptz)

### 3.3 market_ticks
- id (bigserial, pk)
- symbol (text, index)  # USDJPY
- bid (numeric(12,6))
- ask (numeric(12,6))
- spread (numeric(12,6))
- ts (timestamptz, index)

### 3.4 orders
- id (uuid, pk)
- account_id (uuid, fk -> accounts.id, index)
- symbol (text, index)
- side (text)  # BUY / SELL
- order_type (text)  # MARKET / LIMIT / STOP
- qty (numeric(18,6))
- requested_price (numeric(12,6), nullable)
- status (text)  # PENDING / FILLED / CANCELED / REJECTED
- assistant_signal_id (uuid, nullable, fk -> assistant_signals.id)
- reason_note (text, nullable)
- created_at (timestamptz, index)

### 3.5 fills
- id (uuid, pk)
- order_id (uuid, fk -> orders.id, index)
- fill_price (numeric(12,6))
- fill_qty (numeric(18,6))
- slippage_pips (numeric(10,4), default: 0)
- fee_jpy (numeric(18,2), default: 0)
- filled_at (timestamptz, index)

### 3.6 positions
- id (uuid, pk)
- account_id (uuid, fk -> accounts.id, index)
- symbol (text, index)
- side (text)  # LONG / SHORT
- open_qty (numeric(18,6))
- avg_entry_price (numeric(12,6))
- stop_loss_price (numeric(12,6), nullable)
- take_profit_price (numeric(12,6), nullable)
- opened_at (timestamptz)
- closed_at (timestamptz, nullable)
- status (text)  # OPEN / CLOSED

### 3.7 assistant_signals
- id (uuid, pk)
- account_id (uuid, fk -> accounts.id, index)
- symbol (text)
- action (text)  # BUY / SELL / HOLD
- entry_price (numeric(12,6), nullable)
- stop_loss_price (numeric(12,6), nullable)
- take_profit_price (numeric(12,6), nullable)
- confidence (numeric(5,4))
- rationale (text)
- adopted (boolean, default: false)
- created_at (timestamptz, index)

### 3.8 trades
- id (uuid, pk)
- account_id (uuid, fk -> accounts.id, index)
- symbol (text)
- side (text)  # LONG / SHORT
- entry_time (timestamptz)
- exit_time (timestamptz)
- holding_seconds (int)
- entry_price (numeric(12,6))
- exit_price (numeric(12,6))
- qty (numeric(18,6))
- gross_pnl_jpy (numeric(18,2))
- net_pnl_jpy (numeric(18,2))
- max_favorable_excursion_jpy (numeric(18,2), default: 0)
- max_adverse_excursion_jpy (numeric(18,2), default: 0)
- assistant_signal_id (uuid, nullable, fk -> assistant_signals.id)
- created_at (timestamptz, index)

### 3.9 daily_metrics
- id (uuid, pk)
- account_id (uuid, fk -> accounts.id, index)
- date (date, index)
- total_trades (int)
- wins (int)
- losses (int)
- win_rate (numeric(6,3))
- gross_profit_jpy (numeric(18,2))
- gross_loss_jpy (numeric(18,2))
- net_profit_jpy (numeric(18,2))
- profit_factor (numeric(10,4), nullable)
- max_drawdown_jpy (numeric(18,2), nullable)
- updated_at (timestamptz)

## 4. 主要インデックス
- market_ticks(symbol, ts desc)
- orders(account_id, created_at desc)
- trades(account_id, exit_time desc)
- assistant_signals(account_id, created_at desc)
- daily_metrics(account_id, date)

## 5. 整合性ルール
- 勝率 = wins / total_trades
- profit_factor = gross_profit / abs(gross_loss)
- gross_loss が 0 の場合、profit_factor は null または十分大きな値として扱う
- initial_balance は作成後変更しない

