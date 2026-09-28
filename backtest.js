require("dotenv").config();

const broker = require("./src/broker");
const strategy = require("./src/strategy");
const riskManager = require("./src/riskManager");
const config = require("./src/config");

const INITIAL_EQUITY = Number(process.env.INITIAL_EQUITY || 5000);
const HISTORY_BARS = 3000;

function isCryptoSymbol(symbol) {
  if (Array.isArray(config.CRYPTO_SYMBOLS) && config.CRYPTO_SYMBOLS.includes(symbol)) return true;
  const upper = String(symbol || "").toUpperCase();
  return /BTC|ETH|LTC|XRP|ADA|SOL|BNB|DOGE|TRX|DOT|LINK|MATIC|AVAX/.test(upper);
}

function getParams(symbol) {
  if (isCryptoSymbol(symbol)) {
    return {
      emaFast: config.CRYPTO_EMA_FAST,
      emaSlow: config.CRYPTO_EMA_SLOW,
      breakout: config.CRYPTO_BREAKOUT_LOOKBACK,
      atrPeriod: config.ATR_PERIOD,
      atrSL: config.CRYPTO_ATR_SL_MULTIPLIER,
      atrTP: config.CRYPTO_ATR_TP_MULTIPLIER,
      riskPct: config.CRYPTO_RISK_PER_TRADE_PCT,
    };
  }
  return {
    emaFast: config.EMA_FAST,
    emaSlow: config.EMA_SLOW,
    breakout: config.BREAKOUT_LOOKBACK,
    atrPeriod: config.ATR_PERIOD,
    atrSL: config.ATR_SL_MULTIPLIER,
    atrTP: config.ATR_TP_MULTIPLIER,
    riskPct: config.RISK_PER_TRADE_PCT,
  };
}

function getTimeframe(symbol) {
  if (isCryptoSymbol(symbol)) return config.CRYPTO_TIMEFRAME;
  return config.TIMEFRAMES[symbol] || config.TIMEFRAME;
}

// Get value of 1 price unit per 1.0 lot
async function getValuePerUnit(symbol, refPrice) {
  const profit = await broker.getCalcProfit({
    symbol,
    direction: "buy",
    volume: 1.0,
    openPrice: refPrice,
    closePrice: refPrice + 1,
  });
  return Math.abs(Number(profit));
}

function backtestSymbol(candles, valuePerPriceUnitPerLot, symbol, params) {
  let equity = INITIAL_EQUITY;
  let peakEquity = INITIAL_EQUITY;
  let maxDrawdownPct = 0;
  let openTrade = null;
  const trades = [];

  const warmup = params.emaSlow + 5;

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const bar = candles[i];

    // Manage open trade
    if (openTrade) {
      let exitPrice = null;
      if (openTrade.direction === "buy") {
        if (bar.low <= openTrade.stopLoss) exitPrice = openTrade.stopLoss;
        else if (bar.high >= openTrade.takeProfit) exitPrice = openTrade.takeProfit;
      } else {
        if (bar.high >= openTrade.stopLoss) exitPrice = openTrade.stopLoss;
        else if (bar.low <= openTrade.takeProfit) exitPrice = openTrade.takeProfit;
      }

      if (exitPrice !== null) {
        const priceDiff =
          openTrade.direction === "buy"
            ? exitPrice - openTrade.entryPrice
            : openTrade.entryPrice - exitPrice;

        const pnl = priceDiff * valuePerPriceUnitPerLot * openTrade.volume;
        equity += pnl;
        trades.push({ ...openTrade, exitPrice, pnl, closeTime: bar.time });
        peakEquity = Math.max(peakEquity, equity);
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        maxDrawdownPct = Math.max(maxDrawdownPct, dd);
        openTrade = null;
      }
    }

    // New signal
    if (!openTrade) {
      const signal = strategy.evaluateSignal(window);
      if (signal) {
        const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
        const volume = riskManager.calculatePositionSize({
          equity,
          stopLossDistancePrice: stopDistance,
          valuePerPriceUnitPerLot,
        });
        if (volume > 0) {
          openTrade = { ...signal, volume, openTime: bar.time };
        }
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    symbol,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0",
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "N/A",
    finalEquity: equity.toFixed(2),
    returnPct: (((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100).toFixed(2),
    maxDrawdownPct: maxDrawdownPct.toFixed(2),
  };
}

function backtestCrypto(candles, valuePerPriceUnitPerLot, symbol, params) {
  let equity = INITIAL_EQUITY;
  let peakEquity = INITIAL_EQUITY;
  let maxDrawdownPct = 0;
  let openTrade = null;
  const trades = [];
  const warmup = params.emaSlow + 5;

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const bar = candles[i];

    if (openTrade) {
      let exitPrice = null;
      if (bar.low <= openTrade.stopLoss) exitPrice = openTrade.stopLoss;
      else if (bar.high >= openTrade.takeProfit) exitPrice = openTrade.takeProfit;

      if (exitPrice !== null) {
        const priceDiff = exitPrice - openTrade.entryPrice;
        const pnl = priceDiff * valuePerPriceUnitPerLot * openTrade.volume;
        equity += pnl;
        trades.push({ ...openTrade, exitPrice, pnl, closeTime: bar.time });
        peakEquity = Math.max(peakEquity, equity);
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        maxDrawdownPct = Math.max(maxDrawdownPct, dd);
        openTrade = null;
      }
    }

    if (!openTrade) {
      const signal = strategy.evaluateCryptoSignal(window);
      if (signal && signal.direction === "buy") {
        const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
        const riskAmount = equity * (params.riskPct / 100);
        const lossPerLot = stopDistance * valuePerPriceUnitPerLot;
        const volume = lossPerLot > 0 ? riskAmount / lossPerLot : 0;
        if (volume > 0) {
          openTrade = { ...signal, volume, openTime: bar.time };
        }
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    symbol,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0",
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "N/A",
    finalEquity: equity.toFixed(2),
    returnPct: (((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100).toFixed(2),
    maxDrawdownPct: maxDrawdownPct.toFixed(2),
  };
}

async function testOneSymbol(symbol, mode) {
  const timeframe = getTimeframe(symbol);
  const params = getParams(symbol);

  console.log(`\n--- ${symbol} (${timeframe}) [${mode}] ---`);
  console.log(`EMA_FAST=${params.emaFast} EMA_SLOW=${params.emaSlow} LOOKBACK=${params.breakout} ATR_SL=${params.atrSL} ATR_TP=${params.atrTP} RISK=${params.riskPct}%`);

  let candles;
  try {
    candles = await broker.getCandles(symbol, timeframe, HISTORY_BARS);
  } catch (err) {
    console.log(`SKIPPED — ${err.message}`);
    return null;
  }

  if (!candles || !candles.length) {
    console.log(`Babu bayanan tarihi don ${symbol}`);
    return null;
  }

  const refPrice = candles[candles.length - 1].close;
  let valuePerPriceUnitPerLot;
  try {
    valuePerPriceUnitPerLot = await getValuePerUnit(symbol, refPrice);
  } catch (err) {
    console.log(`SKIPPED — calc_profit failed: ${err.message}`);
    return null;
  }

  if (!Number.isFinite(valuePerPriceUnitPerLot) || valuePerPriceUnitPerLot <= 0) {
    console.log(`SKIPPED — invalid valuePerPriceUnitPerLot`);
    return null;
  }

  const result = mode === "crypto"
    ? backtestCrypto(candles, valuePerPriceUnitPerLot, symbol, params)
    : backtestSymbol(candles, valuePerPriceUnitPerLot, symbol, params);

  console.log(`Bars gwadawa: ${candles.length}`);
  console.log(`Jimlar ciniki: ${result.totalTrades}`);
  console.log(`Nasara: ${result.wins} | Asara: ${result.losses} | Win Rate: ${result.winRate}%`);
  console.log(`Profit Factor: ${result.profitFactor}`);
  console.log(`Equity na karshe: $${result.finalEquity} (${result.returnPct}%)`);
  console.log(`Max Drawdown: ${result.maxDrawdownPct}%`);

  return result;
}

async function main() {
  const mode = (process.argv[2] || "fx").toLowerCase();

  console.log("========================================");
  console.log(` BACKTEST START — mode: ${mode}`);
  console.log(` INITIAL_EQUITY=${INITIAL_EQUITY}`);
  console.log("========================================");

  await broker.connect();

  let symbols = [];
  if (mode === "fx") symbols = config.SYMBOLS;
  else if (mode === "crypto") symbols = config.CRYPTO_SYMBOLS;
  else if (mode === "all") symbols = [...config.SYMBOLS, ...config.CRYPTO_SYMBOLS];
  else {
    console.error("Usage: node backtest.js [fx|crypto|all]");
    process.exit(1);
  }

  const results = [];

  for (const symbol of symbols) {
    try {
      const r = await testOneSymbol(symbol, mode === "crypto" || isCryptoSymbol(symbol) ? "crypto" : "fx");
      if (r) results.push(r);
    } catch (err) {
      console.log(`--- ${symbol} --- ERROR: ${err.message}`);
    }
  }

  console.log("\n========================================");
  console.log(" SUMMARY");
  console.log("========================================");
  console.log("Symbol | Trades | WinRate | PF | MaxDD | NetP&L%");
  for (const r of results) {
    console.log(`${r.symbol} | ${r.totalTrades} | ${r.winRate}% | ${r.profitFactor} | ${r.maxDrawdownPct}% | ${r.returnPct}%`);
  }

  console.log("\n========================================");
  console.log(" BACKTEST YA GAMA - BABU CINIKI NA GASKE DA AKA AIKA");
  console.log("========================================");
  process.exit(0);
}

main().catch((err) => {
  console.error("[BACKTEST FAILED]", err.message);
  process.exit(1);
});