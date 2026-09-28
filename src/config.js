require("dotenv").config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function positiveNumber(name, fallback) {
  const value = parseFloat(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function positiveInteger(name, fallback) {
  const value = parseInt(process.env[name] || fallback, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalNumber(name, fallback) {
  const value = parseFloat(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function optionalInteger(name, fallback) {
  const value = parseInt(process.env[name] || fallback, 10);
  return Number.isInteger(value) ? value : fallback;
}

// ===== PER-SYMBOL TIMEFRAMES =====
const SYMBOLS = (process.env.SYMBOLS || "XAUUSD,EURUSD")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_TIMEFRAME = process.env.TIMEFRAME || "1h";

function buildTimeframes() {
  const map = {};
  for (const symbol of SYMBOLS) {
    const key = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const envKey = `TIMEFRAME_${key}`;
    map[symbol] = process.env[envKey] || DEFAULT_TIMEFRAME;
  }
  return map;
}

const TIMEFRAMES = buildTimeframes();

module.exports = {
  SYMBOLS,
  TIMEFRAME: DEFAULT_TIMEFRAME,
  TIMEFRAMES,

  EMA_FAST: positiveInteger("EMA_FAST", "50"),
  EMA_SLOW: positiveInteger("EMA_SLOW", "200"),
  BREAKOUT_LOOKBACK: positiveInteger("BREAKOUT_LOOKBACK", "20"),
  ATR_PERIOD: positiveInteger("ATR_PERIOD", "14"),
  ATR_SL_MULTIPLIER: positiveNumber("ATR_SL_MULTIPLIER", "2.0"),
  ATR_TP_MULTIPLIER: positiveNumber("ATR_TP_MULTIPLIER", "3.0"),

  RISK_PER_TRADE_PCT: positiveNumber("RISK_PER_TRADE_PCT", "0.2"),
  MAX_DAILY_LOSS_PCT: positiveNumber("MAX_DAILY_LOSS_PCT", "4.0"),
  MAX_DRAWDOWN_PCT: positiveNumber("MAX_DRAWDOWN_PCT", "8.0"),
  INITIAL_EQUITY: positiveNumber("INITIAL_EQUITY", "5000"),
  MAX_CONCURRENT_TRADES: positiveInteger("MAX_CONCURRENT_TRADES", "3"),

  MAX_RISK_PER_TRADE_PCT: optionalNumber("MAX_RISK_PER_TRADE_PCT", 0.3),
  MAX_TOTAL_OPEN_RISK_PCT: optionalNumber("MAX_TOTAL_OPEN_RISK_PCT", 0.6),
  MAX_OPEN_TRADES: optionalInteger("MAX_OPEN_TRADES", 3),
  MAX_DAILY_TRADES: optionalInteger("MAX_DAILY_TRADES", 20),
  INTERNAL_DAILY_LOSS_LIMIT: optionalNumber("INTERNAL_DAILY_LOSS_LIMIT", 75),
  INTERNAL_MAX_DRAWDOWN: optionalNumber("INTERNAL_MAX_DRAWDOWN", 200),
  MAX_CONSECUTIVE_LOSSES: optionalInteger("MAX_CONSECUTIVE_LOSSES", 3),
  COOLDOWN_AFTER_LOSS_MIN: optionalInteger("COOLDOWN_AFTER_LOSS_MIN", 60),
  MAX_SPREAD_POINTS: optionalNumber("MAX_SPREAD_POINTS", 50),
  MAX_SLIPPAGE_POINTS: optionalNumber("MAX_SLIPPAGE_POINTS", 20),

  LIVE_TRADING_ENABLED:
    (process.env.LIVE_TRADING_ENABLED || "false").toLowerCase() === "true",
  EXPECTED_ACCOUNT_LOGIN: process.env.EXPECTED_ACCOUNT_LOGIN || null,

  POLL_INTERVAL_MS: positiveInteger("POLL_INTERVAL_MS", "20000"),

  // ===== CRYPTO v4 ADD-ON =====
  CRYPTO_ENABLED:
    (process.env.CRYPTO_ENABLED || "false").toLowerCase() === "true",
  CRYPTO_SYMBOLS: (
    process.env.CRYPTO_SYMBOLS ||
    "BTCUSD,ETHUSD,TRXUSD,ADAUSD,XRPUSD,SOLUSD,BNBUSD,DOGEUSD,LTCUSD"
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  CRYPTO_RISK_PER_TRADE_PCT: optionalNumber("CRYPTO_RISK_PER_TRADE_PCT", 0.15),
  CRYPTO_MAX_OPEN_TRADES: optionalInteger("CRYPTO_MAX_OPEN_TRADES", 2),
  CRYPTO_MAX_TOTAL_OPEN_RISK_PCT: optionalNumber("CRYPTO_MAX_TOTAL_OPEN_RISK_PCT", 1.0),
  CRYPTO_ATR_SL_MULTIPLIER: optionalNumber("CRYPTO_ATR_SL_MULTIPLIER", 2.5),
  CRYPTO_ATR_TP_MULTIPLIER: optionalNumber("CRYPTO_ATR_TP_MULTIPLIER", 4.0),
  CRYPTO_BREAKOUT_LOOKBACK: optionalInteger("CRYPTO_BREAKOUT_LOOKBACK", 20),
  CRYPTO_EMA_FAST: optionalInteger("CRYPTO_EMA_FAST", 20),
  CRYPTO_EMA_SLOW: optionalInteger("CRYPTO_EMA_SLOW", 50),
  CRYPTO_TIMEFRAME: process.env.CRYPTO_TIMEFRAME || "1h",
  CRYPTO_MAX_SPREAD_POINTS: optionalNumber("CRYPTO_MAX_SPREAD_POINTS", 100),
  CRYPTO_MIN_HOLDING_MINUTES: optionalInteger("CRYPTO_MIN_HOLDING_MINUTES", 2),
  CRYPTO_NEWS_BLACKOUT:
    (process.env.CRYPTO_NEWS_BLACKOUT || "true").toLowerCase() === "true",
};