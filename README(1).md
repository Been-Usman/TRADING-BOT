# MT Trading Bot — Trend-Following (US30 / XAUUSD / EURUSD)

Strategy: EMA(50)/EMA(200) trend filter + 20-period breakout entry, ATR-based
stop loss and take profit, 1h timeframe.

Risk: 1% of equity risked per trade. Bot halts new trades for the day if
daily loss hits 3% of starting equity (checked and enforced every cycle
before any order goes out — see `src/riskManager.js`).

## Setup steps

### 1. MetaApi (bridge to your MT4/5 terminal)
1. Create an account at https://metaapi.cloud
2. Add your MT4/5 account: provide login, password/investor-password, and
   server name from your prop firm.
3. Copy your **API token** and the generated **account ID** — these go into
   `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID`.
4. Confirm the exact symbol names your broker uses (e.g. gold may be listed
   as `XAUUSD` or `GOLD`, US30 may be `US30` or `US30.cash`). Update
   `SYMBOLS` in `render.yaml` / `.env` to match exactly, or orders will fail.

### 2. Supabase
1. Create a project at https://supabase.com
2. Open the SQL editor and run `supabase_schema.sql` from this repo.
3. Copy your project URL and **service_role key** (Project Settings > API)
   into `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

### 3. Render
1. Push this repo to GitHub.
2. In Render, create a new **Background Worker** (not a Web Service) from
   the repo — `render.yaml` is already set up for this ("Blueprint" deploy
   will pick it up automatically).
3. Set the four secret env vars in the Render dashboard (they're marked
   `sync: false` in render.yaml, so Render will prompt for them):
   `METAAPI_TOKEN`, `METAAPI_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
4. Deploy. Check the logs — you should see `[BOOT] Starting MT trading bot...`
   followed by `[BROKER] Connected and synchronized with MT account.`

Render's free tier spins background workers down when idle, which breaks
24/7 trading. Use the `starter` plan (~$7/mo) for this service.

## Before running on a real account

- **Test on a demo MT account first.** Point METAAPI_ACCOUNT_ID at a demo
  account and watch it trade for at least a couple of weeks before touching
  a funded account.
- **Check your prop firm's rules on automated trading** — some programs
  restrict or require pre-approval for EAs/bots. This bot connects like a
  standard EA from the broker's point of view.
- **Confirm contract specs per symbol.** `tickValue`/`tickSize` used for
  position sizing come from MetaApi's symbol specification — sanity-check
  the calculated lot size against your broker's contract size before
  trusting it with real capital.
- **The strategy here is a reasonable starting default, not a proven edge.**
  Backtest it against your broker's historical data before going live, and
  expect to tune the EMA/breakout/ATR parameters.

## Monitoring

Every trade is logged to the `trades` table in Supabase, and daily
risk state (starting equity, whether the day is locked) is in
`risk_state`. Query those directly in the Supabase dashboard to check on
the bot without needing the Render logs.
