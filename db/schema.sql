-- FX Demo Trade App schema (PostgreSQL)

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  base_currency text not null default 'JPY',
  initial_balance numeric(18,2) not null default 1000000.00,
  current_balance numeric(18,2) not null,
  created_at timestamptz not null default now()
);

create table if not exists market_ticks (
  id bigserial primary key,
  symbol text not null,
  bid numeric(12,6) not null,
  ask numeric(12,6) not null,
  spread numeric(12,6) not null,
  ts timestamptz not null
);

create index if not exists idx_market_ticks_symbol_ts on market_ticks(symbol, ts desc);

create table if not exists assistant_signals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  symbol text not null,
  action text not null check (action in ('BUY', 'SELL', 'HOLD')),
  entry_price numeric(12,6),
  stop_loss_price numeric(12,6),
  take_profit_price numeric(12,6),
  confidence numeric(5,4) not null,
  rationale text not null,
  adopted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_assistant_signals_account_created on assistant_signals(account_id, created_at desc);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  order_type text not null check (order_type in ('MARKET', 'LIMIT', 'STOP')),
  qty numeric(18,6) not null,
  requested_price numeric(12,6),
  status text not null check (status in ('PENDING', 'FILLED', 'CANCELED', 'REJECTED')),
  assistant_signal_id uuid references assistant_signals(id),
  reason_note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_orders_account_created on orders(account_id, created_at desc);

create table if not exists fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  fill_price numeric(12,6) not null,
  fill_qty numeric(18,6) not null,
  slippage_pips numeric(10,4) not null default 0,
  fee_jpy numeric(18,2) not null default 0,
  filled_at timestamptz not null
);

create index if not exists idx_fills_order on fills(order_id);

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  symbol text not null,
  side text not null check (side in ('LONG', 'SHORT')),
  open_qty numeric(18,6) not null,
  avg_entry_price numeric(12,6) not null,
  stop_loss_price numeric(12,6),
  take_profit_price numeric(12,6),
  opened_at timestamptz not null,
  closed_at timestamptz,
  status text not null check (status in ('OPEN', 'CLOSED'))
);

create index if not exists idx_positions_account_status on positions(account_id, status);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  symbol text not null,
  side text not null check (side in ('LONG', 'SHORT')),
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  holding_seconds int not null,
  entry_price numeric(12,6) not null,
  exit_price numeric(12,6) not null,
  qty numeric(18,6) not null,
  gross_pnl_jpy numeric(18,2) not null,
  net_pnl_jpy numeric(18,2) not null,
  max_favorable_excursion_jpy numeric(18,2) not null default 0,
  max_adverse_excursion_jpy numeric(18,2) not null default 0,
  assistant_signal_id uuid references assistant_signals(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_trades_account_exit on trades(account_id, exit_time desc);

create table if not exists daily_metrics (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  date date not null,
  total_trades int not null,
  wins int not null,
  losses int not null,
  win_rate numeric(6,3) not null,
  gross_profit_jpy numeric(18,2) not null,
  gross_loss_jpy numeric(18,2) not null,
  net_profit_jpy numeric(18,2) not null,
  profit_factor numeric(10,4),
  max_drawdown_jpy numeric(18,2),
  updated_at timestamptz not null default now(),
  unique(account_id, date)
);

create index if not exists idx_daily_metrics_account_date on daily_metrics(account_id, date);
