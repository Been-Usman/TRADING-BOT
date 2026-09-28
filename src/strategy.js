const { EMA, ATR } = require("technicalindicators");
const config = require("./config");

/**
 * candles:
 * array of:
 * {
 *   open,
 *   high,
 *   low,
 *   close,
 *   time
 * }
 *
 * Returns:
 * null
 * or
 * {
 *   direction: "buy" | "sell",
 *   entryPrice,
 *   stopLoss,
 *   takeProfit,
 *   atr
 * }
 */
function evaluateSignal(candles) {
  if (!Array.isArray(candles)) {
    return null;
  }

  const minimumHistory = Math.max(
    config.EMA_SLOW + 1,
    config.BREAKOUT_LOOKBACK + 2,
    config.ATR_PERIOD + 2
  );

  if (
    candles.length <
    minimumHistory
  ) {
    return null;
  }

  const closes = candles.map(
    (c) => Number(c.close)
  );

  const highs = candles.map(
    (c) => Number(c.high)
  );

  const lows = candles.map(
    (c) => Number(c.low)
  );

  if (
    closes.some(
      (value) => !Number.isFinite(value)
    ) ||
    highs.some(
      (value) => !Number.isFinite(value)
    ) ||
    lows.some(
      (value) => !Number.isFinite(value)
    )
  ) {
    return null;
  }

  const emaFast = EMA.calculate({
    period: config.EMA_FAST,
    values: closes,
  });

  const emaSlow = EMA.calculate({
    period: config.EMA_SLOW,
    values: closes,
  });

  const atr = ATR.calculate({
    period: config.ATR_PERIOD,
    high: highs,
    low: lows,
    close: closes,
  });

  if (
    !emaFast.length ||
    !emaSlow.length ||
    !atr.length
  ) {
    return null;
  }

  const lastEmaFast =
    emaFast[emaFast.length - 1];

  const lastEmaSlow =
    emaSlow[emaSlow.length - 1];

  const lastAtr =
    atr[atr.length - 1];

  const lastClose =
    closes[closes.length - 1];

  if (
    !Number.isFinite(lastEmaFast) ||
    !Number.isFinite(lastEmaSlow) ||
    !Number.isFinite(lastAtr) ||
    !Number.isFinite(lastClose) ||
    lastAtr <= 0
  ) {
    return null;
  }

  const trendUp =
    lastEmaFast > lastEmaSlow;

  const trendDown =
    lastEmaFast < lastEmaSlow;

  /*
   * Exclude the current candle from the
   * breakout range.
   */
  const lookbackHighs = highs.slice(
    -config.BREAKOUT_LOOKBACK - 1,
    -1
  );

  const lookbackLows = lows.slice(
    -config.BREAKOUT_LOOKBACK - 1,
    -1
  );

  if (
    lookbackHighs.length <
      config.BREAKOUT_LOOKBACK ||
    lookbackLows.length <
      config.BREAKOUT_LOOKBACK
  ) {
    return null;
  }

  const rangeHigh =
    Math.max(...lookbackHighs);

  const rangeLow =
    Math.min(...lookbackLows);

  if (
    !Number.isFinite(rangeHigh) ||
    !Number.isFinite(rangeLow)
  ) {
    return null;
  }

  if (
    trendUp &&
    lastClose > rangeHigh
  ) {
    return {
      direction: "buy",
      entryPrice: lastClose,
      stopLoss:
        lastClose -
        lastAtr *
          config.ATR_SL_MULTIPLIER,
      takeProfit:
        lastClose +
        lastAtr *
          config.ATR_TP_MULTIPLIER,
      atr: lastAtr,
    };
  }

  if (
    trendDown &&
    lastClose < rangeLow
  ) {
    return {
      direction: "sell",
      entryPrice: lastClose,
      stopLoss:
        lastClose +
        lastAtr *
          config.ATR_SL_MULTIPLIER,
      takeProfit:
        lastClose -
        lastAtr *
          config.ATR_TP_MULTIPLIER,
      atr: lastAtr,
    };
  }

  return null;
}

// ===== CRYPTO v4 ADD-ON: long-only, no stablecoins =====
const STABLECOIN_BLACKLIST = [
  "USDT", "USDC", "BUSD", "DAI", "TUSD", "USDP",
  "PAX", "GUSD", "FRAX", "UST", "USDD", "PYUSD",
];

function isStablecoin(symbolName, symbolDescription) {
  const name = String(symbolName || "").toUpperCase();
  const desc = String(symbolDescription || "").toUpperCase();
  return STABLECOIN_BLACKLIST.some((t) => {
    if (name === t) return true;
    if (name === t + "USD") return true;
    if (name === "USD" + t) return true;
    const re = new RegExp("\\b" + t + "\\b");
    if (desc && re.test(desc)) return true;
    return false;
  });
}

function evaluateCryptoSignal(candles) {
  if (!Array.isArray(candles)) return null;
  const fastP = config.CRYPTO_EMA_FAST;
  const slowP = config.CRYPTO_EMA_SLOW;
  const lookback = config.CRYPTO_BREAKOUT_LOOKBACK;
  const atrP = config.ATR_PERIOD;
  const minimumHistory = Math.max(slowP + 1, lookback + 2, atrP + 2);
  if (candles.length < minimumHistory) return null;
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  if (closes.some((v) => !Number.isFinite(v)) || highs.some((v) => !Number.isFinite(v)) || lows.some((v) => !Number.isFinite(v))) return null;
  const emaFast = EMA.calculate({ period: fastP, values: closes });
  const emaSlow = EMA.calculate({ period: slowP, values: closes });
  const trendEma = EMA.calculate({ period: slowP, values: closes });
  const atr = ATR.calculate({ period: atrP, high: highs, low: lows, close: closes });
  if (!emaFast.length || !emaSlow.length || !trendEma.length || !atr.length) return null;
  const lastFast = emaFast[emaFast.length - 1];
  const lastSlow = emaSlow[emaSlow.length - 1];
  const lastTrend = trendEma[trendEma.length - 1];
  const lastAtr = atr[atr.length - 1];
  const lastClose = closes[closes.length - 1];
  if (!Number.isFinite(lastFast) || !Number.isFinite(lastSlow) || !Number.isFinite(lastTrend) || !Number.isFinite(lastAtr) || !Number.isFinite(lastClose) || lastAtr <= 0) return null;
  const trendUp = lastFast > lastSlow;
  const aboveTrend = lastClose > lastTrend;
  const lookbackHighs = highs.slice(-lookback - 1, -1);
  if (lookbackHighs.length < lookback) return null;
  const highestHigh = Math.max(...lookbackHighs);
  if (!Number.isFinite(highestHigh)) return null;
  const breakout = lastClose > highestHigh;
  if (trendUp && aboveTrend && breakout) {
    return { direction: "buy", entryPrice: lastClose, stopLoss: lastClose - lastAtr * config.CRYPTO_ATR_SL_MULTIPLIER, takeProfit: lastClose + lastAtr * config.CRYPTO_ATR_TP_MULTIPLIER, atr: lastAtr, reason: "crypto-trend-breakout" };
  }
  return null;
}

module.exports = {
  evaluateSignal,
  evaluateCryptoSignal,
  isStablecoin,
  STABLECOIN_BLACKLIST,
};

