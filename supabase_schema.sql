-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query)

create table if not exists risk_state (
  date date primary key,
  starting_equity numeric not null,
  realized_pnl numeric not null default 0,
  locked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists trades (
  id bigint generated always as identity primary key,
  symbol text not null,
  direction text not null check (direction in ('buy', 'sell')),
  volume numeric not null,
  entry_price numeric not null,
  stop_loss numeric,
  take_profit numeric,
  exit_price numeric,
  pnl numeric,
  status text not null default 'open' check (status in ('open', 'closed')),
  order_id text,
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_trades_status on trades(status);
create index if not exists idx_trades_symbol on trades(symbol);
