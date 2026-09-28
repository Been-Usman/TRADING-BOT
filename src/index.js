const http = require("http");
const config = require("./config");
const broker = require("./broker");
const riskManager = require("./riskManager");
const strategy = require("./strategy");
const db = require("./db");
const TelegramBot = require("node-telegram-bot-api");

// ===== SANARWAR TELEGRAM =====
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

let telegramBot = null;

if (telegramToken && telegramChatId) {
  telegramBot = new TelegramBot(telegramToken, {
    polling: false,
    baseApiUrl: "https://autumn-cell-c706.beenusman2010.workers.dev",
  });
  console.log("[TELEGRAM] An haɗa bot ɗin Telegram.");
} else {
  console.log("[TELEGRAM] Babu token ko chat ID - sanarwa ba za ta yi aiki ba.");
}

async function sendTelegramNotification(message) {
  if (!telegramBot || !telegramChatId) return;

  try {
    await telegramBot.sendMessage(telegramChatId, message, {
      parse_mode: "HTML",
    });
    console.log("[TELEGRAM] An aika sanarwa.");
  } catch (err) {
    console.error("[TELEGRAM] Aika ya kasa:", err.message);
  }
}
// ===== KARSHE na sanarwar Telegram =====
// Live count of open positions, kept at module scope so the /health
// endpoint can report it without re-querying the broker.
let openPositionsCount = 0;

// ===== DB BACKEND NOTE =====
// The local JSON store (data/local_db.json) is now the ONLY backend - it
// is healthy by design, so there is no "degraded" state and no hourly
// warning. The boot banner prints the exact file path so the operator
// knows where the daily-loss / drawdown history lives and must back it
// up. Boot-time backup is handled inside localStore.js.




// ===== CAIRO TIME HELPERS =====
function getCairoTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const p of formatter.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return parts;
}

function toCairoDateKey(date = new Date()) {
  const p = getCairoTimeParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function getCairoHour(date = new Date()) {
  return parseInt(getCairoTimeParts(date).hour, 10);
}

function getCairoMinute(date = new Date()) {
  return parseInt(getCairoTimeParts(date).minute, 10);
}
// ===== KARSHE =====


// ===== TRADE MEMORY (in-memory + DB sync) =====
const todayClosedTrades = []; // { symbol, direction, pnl, closedAt }
let lastProgressKey = null;   // e.g. "2026-09-16-18"
let lastDailyKey = null;
let challengeStartEquity = null;
let phase1Notified = false;
let phase2Notified = false;
const PHASE1_TARGET = 400;
const PHASE2_TARGET = 200;      // e.g. "2026-09-16"

function formatMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "$0.00";
  const sign = num >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(num).toFixed(2)}`;
}

async function loadRecentClosedTradesFromDb() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return await db.getClosedTradesSince(since);
  } catch (err) {
    console.error("[DB] loadRecentClosedTrades error:", err.message);
    return [];
  }
}

// ===== PHASE 1 REPAIR: missing helpers (FIX 4/5 + Telegram) =====
async function countTodayOpenedTrades() {
  try {
    const dayStart = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
    // Routed through db.countTradesSince() so a local-store read error is
    // caught here instead of aborting the whole cycle.
    const count = await db.countTradesSince(dayStart);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  } catch (err) {
    console.error("[DB] countTodayOpenedTrades error:", err.message);
    try { await sendTelegramNotification("\u274c SYSTEM ERROR\nSource: local DB store\nMessage: " + err.message + "\nImpact: degraded (daily-trade count assumed 0)\nTime: " + new Date().toISOString()); } catch (e) {}
    return 0;
  }
}

async function checkPhaseTargets() {
  try {
    const anchor = Number(config.INITIAL_EQUITY);
    if (!Number.isFinite(anchor) || anchor <= 0) return;
    let equity = null;
    try {
      const acct = await broker.getAccountInformation();
      equity = Number(acct.equity);
    } catch (e) {
      console.error("[REPORT] checkPhaseTargets broker read failed:", e.message);
      return;
    }
    if (!Number.isFinite(equity)) return;
    const cum = equity - anchor;
    if (!phase1Notified && cum >= PHASE1_TARGET) {
      phase1Notified = true;
      await sendTelegramNotification("PHASE 1 TARGET REACHED ($400 / 8%)\nCumulative P&L: +$" + cum.toFixed(2) + "\nEquity: $" + equity.toFixed(2) + "\nAction: continue to Phase 2 after verification.\nTime: " + new Date().toISOString());
    }
    if (phase1Notified && !phase2Notified && cum >= PHASE1_TARGET + PHASE2_TARGET) {
      phase2Notified = true;
      await sendTelegramNotification("PHASE 2 TARGET REACHED - CHALLENGE PASSED ($200 / 4%)\nCumulative P&L: +$" + cum.toFixed(2) + "\nEquity: $" + equity.toFixed(2) + "\nReady for: funded account\nTime: " + new Date().toISOString());
    }
  } catch (err) {
    console.error("[REPORT] checkPhaseTargets error:", err.message);
  }
}

function isCryptoMarketOpen(date) {
  const d = date || new Date();
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const day = d.getUTCDay();
  if (h === 23 && m >= 59) return false;
  if (h === 0 && m <= 1) return false;
  if (day === 6 && h === 0) return false;
  return true;
}
// ===== END PHASE 1 REPAIR =====
function getTodayStats() {
  const todayKey = toCairoDateKey();
  const todayTrades = todayClosedTrades.filter(
    (t) => toCairoDateKey(new Date(t.closedAt)) === todayKey
  );

  const wins = todayTrades.filter((t) => t.pnl > 0);
  const losses = todayTrades.filter((t) => t.pnl < 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const net = totalProfit + totalLoss;

  const bySymbol = {};
  for (const t of todayTrades) {
    bySymbol[t.symbol] = (bySymbol[t.symbol] || 0) + t.pnl;
  }

  const entries = Object.entries(bySymbol);
  let bestSymbol = "—";
  let worstSymbol = "—";

  if (entries.length > 0) {
    entries.sort((a, b) => b[1] - a[1]);
    bestSymbol = `${entries[0][0]} (${formatMoney(entries[0][1])})`;
    worstSymbol = `${entries[entries.length - 1][0]} (${formatMoney(
      entries[entries.length - 1][1]
    )})`;
  }

  return {
    total: todayTrades.length,
    wins: wins.length,
    losses: losses.length,
    totalProfit,
    totalLoss,
    net,
    bestSymbol,
    worstSymbol,
  };
}

function getLast3HoursTrades() {
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  return todayClosedTrades.filter(
    (t) => new Date(t.closedAt).getTime() >= threeHoursAgo
  );
}
// ===== KARSHE TRADE MEMORY =====


// ===== DYNAMIC REPORTS =====
async function sendProgressUpdate() {
  try {
    const account = await broker.getAccountInformation();
    const equity = Number(account.equity);
    const balance = Number(account.balance);

    const { lossSoFarPct } = await riskManager.syncDailyState(equity);
    const openPositions = await broker.getOpenPositions();

    const last3h = getLast3HoursTrades();
    const last3hNet = last3h.reduce((s, t) => s + t.pnl, 0);
    const last3hWins = last3h.filter((t) => t.pnl > 0).length;
    const last3hLosses = last3h.filter((t) => t.pnl < 0).length;

    const p = getCairoTimeParts();
    const timeStr = `${p.hour}:${p.minute}`;

    const msg =
      `⏰ <b>PROGRESS UPDATE</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `🕐 <b>Time:</b> ${timeStr} EET\n` +
      `\n📊 <b>Account Status:</b>\n` +
      `• Equity: $${equity.toFixed(2)}\n` +
      `• Balance: $${balance.toFixed(2)}\n` +
      `• Daily Loss: ${lossSoFarPct.toFixed(2)}%\n` +
      `• Locked: ${riskManager.locked ? "YES" : "NO"}\n` +
      `\n📈 <b>Trades Since Last Update (3h):</b>\n` +
      `• Closed: ${last3h.length}\n` +
      `• Wins: ${last3hWins} | Losses: ${last3hLosses}\n` +
      `• Net P&L: ${formatMoney(last3hNet)}\n` +
      `\n📌 <b>Open Positions:</b> ${openPositions.length}`;

    await sendTelegramNotification(msg);
  } catch (err) {
    console.error("[REPORT] Progress update failed:", err.message);
  }
}

async function sendDailyReport() {
  try {
    const account = await broker.getAccountInformation();
    const equity = Number(account.equity);
    const balance = Number(account.balance);

    const stats = getTodayStats();
    const last3h = getLast3HoursTrades();
    const last3hNet = last3h.reduce((s, t) => s + t.pnl, 0);

    const p = getCairoTimeParts();
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const dateStr = `${parseInt(p.day, 10)} ${months[parseInt(p.month, 10) - 1]} ${p.year}`;

    const activity =
      last3h.length > 0
        ? `${last3h.length} trades closed`
        : "No activity";

    const msg =
      `📊 <b>DAILY ACCOUNT REPORT</b>\n` +
      `Date: ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `\n📈 <b>Total Trades:</b> ${stats.total}\n` +
      `✅ <b>Winning Trades:</b> ${stats.wins}\n` +
      `❌ <b>Losing Trades:</b> ${stats.losses}\n` +
      `\n💰 <b>Total Profit:</b> $${stats.totalProfit.toFixed(2)}\n` +
      `📉 <b>Total Loss:</b> $${stats.totalLoss.toFixed(2)}\n` +
      `📊 <b>Net Result:</b> ${formatMoney(stats.net)}\n` +
      `\n🏆 <b>Best Symbol:</b> ${stats.bestSymbol}\n` +
      `⚠️ <b>Worst Symbol:</b> ${stats.worstSymbol}\n` +
      `\n🕐 <b>Last 3 Hours:</b>\n` +
      `• ${activity}\n` +
      `• Net change: ${formatMoney(last3hNet)}\n` +
      `\n📋 <b>Daily Summary:</b>\n` +
      `${stats.total} trades processed\n` +
      `Net result: ${formatMoney(stats.net)}\n` +
      `\n💼 <b>Equity:</b> $${equity.toFixed(2)}\n` +
      `💵 <b>Balance:</b> $${balance.toFixed(2)}`;

    await sendTelegramNotification(msg);
  } catch (err) {
    console.error("[REPORT] Daily report failed:", err.message);
  }
}

async function runScheduledReports() {
  try {
    const cairoHour = getCairoHour();
    const cairoMinute = getCairoMinute();
    const dateKey = toCairoDateKey();

    // 3-hour progress update: hours 0, 3, 6, 9, 12, 15, 18, 21
    if (cairoHour % 3 === 0 && cairoMinute < 5) {
      const progressKey = `${dateKey}-${cairoHour}`;
      if (lastProgressKey !== progressKey) {
        lastProgressKey = progressKey;
        console.log(`[REPORT] Sending 3h progress update (${progressKey})`);
        await sendProgressUpdate();
      }
    }

    // Daily report: 21:00 Cairo (9 PM EET)
    if (cairoHour === 21 && cairoMinute < 5) {
      if (lastDailyKey !== dateKey) {
        lastDailyKey = dateKey;
        console.log(`[REPORT] Sending daily report (${dateKey})`);
        await sendDailyReport();
      }
    }
  } catch (err) {
    console.error("[REPORT] Scheduled report error:", err.message);
  }
}
// ===== KARSHE REPORTS =====


// ===== SYNC CLOSED TRADES =====
async function syncClosedTrades() {
  const history = await broker.getClosedHistory();

  if (!history.length) return;

  const processedSymbols = new Set();

  for (const deal of history) {
    try {
      if (!deal || !deal.symbol) continue;
      if (processedSymbols.has(deal.symbol)) continue;

      const openTrade = await db.findOpenTradeBySymbol(deal.symbol);
      if (!openTrade) continue;

      const pnl = Number(deal.profit || 0);
      try { riskManager.recordTradeResult(pnl); } catch (e) { console.error('[RISK] recordTradeResult error:', e.message); }
      const exitPrice = Number(deal.price);
      if (!Number.isFinite(pnl) || !Number.isFinite(exitPrice)) continue;

      const closedAt = deal.time
        ? new Date(Number(deal.time) * 1000).toISOString()
        : new Date().toISOString();

      const closed = await db.closeTrade({
        id: openTrade.id,
        exitPrice,
        pnl,
        closedAt,
      });

      if (closed) {
        await db.addRealizedPnl(db.todayStr(), pnl);
        processedSymbols.add(deal.symbol);

        // Record in memory
        try { await checkPhaseTargets(); } catch (e) { console.error('[REPORT] phase check error:', e.message); }
        todayClosedTrades.push({
          symbol: deal.symbol,
          direction: openTrade.direction,
          pnl,
          closedAt,
        });

        console.log(
          `[TRADE] ${deal.symbol} closed. P&L=${pnl.toFixed(2)}`
        );

        // ===== SANARWAR RUFE CINIKI =====
        const isWin = pnl >= 0;
        const emoji = isWin ? "✅🟢" : "❌🔴";
        const status = isWin ? "RIBA" : "ASARA";
        const openPrice = Number(openTrade.entry_price) || 0;
        const direction = openTrade.direction || "?";

        await sendTelegramNotification(
          `${emoji} <b>AN RUFE CINIKI - ${status}</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `📊 <b>Symbol:</b> ${deal.symbol}\n` +
            `📈 <b>Direction:</b> ${direction.toUpperCase()}\n` +
            `💰 <b>Riba/Asara:</b> ${formatMoney(pnl)}\n` +
            `🎯 <b>Entry:</b> ${openPrice}\n` +
            `🏁 <b>Exit:</b> ${exitPrice}\n` +
            `📦 <b>Volume:</b> ${openTrade.volume || "?"}\n` +
            `🕐 <b>Lokaci:</b> ${new Date(closedAt).toLocaleString("en-GB")}`
        );
      }
    } catch (err) {
      console.error(`[TRADE] Close sync error:`, err.message);
    }
  }
}


// ===== CRYPTO v4 CYCLE (gated by CRYPTO_ENABLED, long-only) =====
let lastCryptoMarketState = null;
async function runCryptoCycle(allOpenPositions, equity) {
  if (!config.CRYPTO_ENABLED) return;
  const cryptoNow = new Date();
  const marketOpen = isCryptoMarketOpen(cryptoNow);
  if (marketOpen !== lastCryptoMarketState) {
    lastCryptoMarketState = marketOpen;
    try {
      await sendTelegramNotification(marketOpen ? ("CRYPTO MARKET OPEN - scanning " + config.CRYPTO_SYMBOLS.length + " symbols / " + cryptoNow.toISOString()) : ("CRYPTO MARKET CLOSED - rollover window / " + cryptoNow.toISOString()));
    } catch (e) {}
  }
  if (!marketOpen) return;
  let cryptoOpen = 0;
  try {
    const all = allOpenPositions || await broker.getOpenPositions();
    cryptoOpen = all.filter((x) => config.CRYPTO_SYMBOLS.includes(x.symbol)).length;
  } catch (e) { console.error("[CRYPTO] open count failed:", e.message); return; }
  const fxOpen = (allOpenPositions || []).length - cryptoOpen;
  for (const symbol of config.CRYPTO_SYMBOLS) {
    try {
      if (strategy.isStablecoin && strategy.isStablecoin(symbol, "")) continue;
      if ((fxOpen + cryptoOpen) >= config.MAX_OPEN_TRADES) break;
      if (cryptoOpen >= config.CRYPTO_MAX_OPEN_TRADES) break;
      const candles = await broker.getCandles(symbol, config.CRYPTO_TIMEFRAME, 300);
      const signal = strategy.evaluateCryptoSignal(candles);
      if (!signal || signal.direction !== "buy") continue;
      const spec = await broker.getSymbolSpecification(symbol);
      const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
      if (!Number.isFinite(stopDistance) || stopDistance <= 0) continue;
      const oneLotProfit = await broker.getCalcProfit({ symbol, direction: "buy", volume: 1.0, openPrice: signal.entryPrice, closePrice: signal.entryPrice + stopDistance });
      if (!Number.isFinite(oneLotProfit) || oneLotProfit === 0) continue;
      const valuePerUnit = Math.abs(oneLotProfit) / stopDistance;
      const riskAmount = equity * (config.CRYPTO_RISK_PER_TRADE_PCT / 100);
      const volume = riskAmount / (stopDistance * valuePerUnit);
      if (!Number.isFinite(volume) || volume <= 0) continue;
      const rounded = Math.floor(volume / Number(spec.volumeStep)) * Number(spec.volumeStep);
      if (rounded < Number(spec.minVolume)) continue;
      const order = await broker.placeMarketOrder({ symbol, direction: "buy", volume: rounded, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit });
      await db.logTrade({ symbol, direction: "buy", volume: rounded, entry_price: signal.entryPrice, stop_loss: signal.stopLoss, take_profit: signal.takeProfit, status: "open", opened_at: new Date().toISOString(), order_id: (order && order.orderId) || null });
      cryptoOpen += 1;
      await sendTelegramNotification("BUY - " + symbol + " / Market: Crypto / Entry: " + signal.entryPrice + " / Vol: " + rounded + " / Risk: $" + riskAmount.toFixed(2));
    } catch (err) {
      const msg = (err && err.message) || "";
      console.error("[CRYPTO] " + symbol + " error:", msg);
      try { await sendTelegramNotification("ORDER REJECTED - " + symbol + " / Reason: " + msg); } catch (e) {}
    }
  }
}

// ===== MAIN CYCLE =====
async function runCycle() {
  const accountInfo = await broker.getAccountInformation();
  const equity = Number(accountInfo.equity);

  if (!Number.isFinite(equity) || equity <= 0) {
    throw new Error(`Invalid account equity: ${accountInfo.equity}`);
  }

  const wasLocked = riskManager.locked;
  const dailyState = await riskManager.syncDailyState(equity);
  const { lossSoFarPct, maxDrawdownPct } = dailyState;
  if (dailyState.state && dailyState.state.locked && !wasLocked) {
    console.error("[RISK] Risk lock ENGAGED - notifying via Telegram.");
    await sendTelegramNotification("CINIKI YA KULLE // Reason: " + (dailyState.lockedReason || "UNKNOWN") + " // " + (dailyState.lockedReason === "DRAWDOWN_8PCT" ? "MAX_DRAWDOWN_PCT 8.0%" : "MAX_DAILY_LOSS_PCT 4.0%") + " // Daily loss: " + lossSoFarPct.toFixed(2) + "% // Drawdown: " + Number(maxDrawdownPct || 0).toFixed(2) + "% // Equity: $" + equity.toFixed(2) + " // Resume: tomorrow 00:00 UTC // " + new Date().toISOString());
  }

  console.log(
    `[CYCLE] equity=${equity.toFixed(
      2
    )} dailyLoss=${lossSoFarPct.toFixed(2)}% locked=${riskManager.locked}`
  );

  if (riskManager.locked) {
    console.log(
      "[CYCLE] Trading locked for today - skipping signal evaluation."
    );
    return;
  }

  let openPositions = await broker.getOpenPositions();
  openPositionsCount = openPositions.length;

  for (const symbol of config.SYMBOLS) {
    try {
      const timeframe =
        config.TIMEFRAMES[symbol] || config.TIMEFRAME;

      const candles = await broker.getCandles(
        symbol,
        timeframe,
        config.EMA_SLOW + 5
      );

      const signal = strategy.evaluateSignal(candles);

      if (!signal) {
        console.log(`[CYCLE] ${symbol} (${timeframe}): no signal.`);
        continue;
      }

      const alreadyOpenOnSymbol = openPositions.some(
        (p) => p.symbol === symbol
      );

      if (alreadyOpenOnSymbol) {
        console.log(
          `[CYCLE] ${symbol}: signal but position already open - skipping.`
        );
        continue;
      }

      const gate = await riskManager.checkTradeAllowed({
        openTradeCount: openPositions.length,
      });

      if (!gate.allowed) {
        console.log(
          `[CYCLE] ${symbol}: trade blocked - ${gate.reason}`
        );
        continue;
      }

      const todayOpened = await countTodayOpenedTrades();
      if (todayOpened >= config.MAX_DAILY_TRADES) {
        console.log(`[CYCLE] ${symbol}: MAX_DAILY_TRADES (${config.MAX_DAILY_TRADES}) reached - skipping.`);
        continue;
      }

      const prodGate = riskManager.checkProductionLimits({
        equity,
        referenceEquity: Number(dailyState.state.starting_equity),
        dailyRealizedPnl: Number(dailyState.state.realized_pnl || 0),
        openPositionsCount: openPositions.length,
      });
      if (!prodGate.allowed) {
        console.log(`[CYCLE] ${symbol}: production gate blocked - ${prodGate.reasons.join('; ')}`);
        continue;
      }

      const spec = await broker.getSymbolSpecification(symbol);
      const tickValue = Number(spec.tickValue);
      const tickSize = Number(spec.tickSize);

      if (
        !Number.isFinite(tickValue) ||
        !Number.isFinite(tickSize) ||
        tickValue <= 0 ||
        tickSize <= 0
      ) {
        throw new Error(`${symbol}: invalid tickValue/tickSize.`);
      }

      const stopDistance = Math.abs(
        signal.entryPrice - signal.stopLoss
      );

      if (
        !Number.isFinite(stopDistance) ||
        stopDistance <= 0
      ) {
        throw new Error(
          `${symbol}: invalid stop-loss distance.`
        );
      }

      // FIX 1: tickValue/tickSize above is sanity-check only. Real sizing uses calc_profit.
      const oneLotProfit = await broker.getCalcProfit({
        symbol,
        direction: "buy",
        volume: 1.0,
        openPrice: signal.entryPrice,
        closePrice: signal.entryPrice + stopDistance,
      });
      if (!Number.isFinite(oneLotProfit) || oneLotProfit === 0) {
        throw new Error(`${symbol}: calc_profit failed, cannot size position safely.`);
      }
      const valuePerPriceUnitPerLot = Math.abs(oneLotProfit) / stopDistance;

      const volume = riskManager.calculatePositionSize({
        equity,
        stopLossDistancePrice: stopDistance,
        valuePerPriceUnitPerLot,
      });

      const minVolume = Number(spec.minVolume);
      const volumeStep = Number(spec.volumeStep);

      if (
        !Number.isFinite(minVolume) ||
        !Number.isFinite(volumeStep) ||
        minVolume <= 0 ||
        volumeStep <= 0
      ) {
        throw new Error(
          `${symbol}: invalid volume specification.`
        );
      }

      const roundedVolume =
        Math.floor(volume / spec.volumeStep) * spec.volumeStep;

      if (roundedVolume < spec.minVolume) {
        console.log(
          `[CYCLE] ${symbol}: volume ${roundedVolume} below min ${spec.minVolume} - skipping.`
        );
        continue;
      }

      if (roundedVolume > spec.maxVolume) {
        console.log(
          `[CYCLE] ${symbol}: volume ${roundedVolume} above max ${spec.maxVolume} - skipping.`
        );
        continue;
      }

      console.log(
        `[CYCLE] ${symbol} (${timeframe}): ${signal.direction.toUpperCase()} signal, volume=${roundedVolume}`
      );

      const order = await broker.placeMarketOrder({
        symbol,
        direction: signal.direction,
        volume: roundedVolume,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
      });

      await db.logTrade({
        symbol,
        direction: signal.direction,
        volume: roundedVolume,
        entry_price: signal.entryPrice,
        stop_loss: signal.stopLoss,
        take_profit: signal.takeProfit,
        status: "open",
        opened_at: new Date().toISOString(),
        order_id: order?.orderId || null,
      });

      // ===== SANARWAR BUƊE CINIKI =====
      const dirEmoji =
        signal.direction === "buy" ? "🟢📈" : "🔴📉";
      const dirText =
        signal.direction === "buy"
          ? "SIYA (BUY)"
          : "SAYA (SELL)";
      const riskAmount = (
        equity *
        (config.RISK_PER_TRADE_PCT / 100)
      ).toFixed(2);

      await sendTelegramNotification(
        `${dirEmoji} <b>AN BUƊE SABON CINIKI</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📊 <b>Symbol:</b> ${symbol}\n` +
          `🎯 <b>Direction:</b> ${dirText}\n` +
          `📦 <b>Volume:</b> ${roundedVolume}\n` +
          `💰 <b>Entry:</b> ${signal.entryPrice}\n` +
          `🛑 <b>Stop Loss:</b> ${signal.stopLoss}\n` +
          `✅ <b>Take Profit:</b> ${signal.takeProfit}\n` +
          `⚠️ <b>Risk:</b> $${riskAmount} (${config.RISK_PER_TRADE_PCT}%)\n` +
          `🕐 <b>Lokaci:</b> ${new Date().toLocaleString("en-GB")}\n` +
          `🆔 <b>Order ID:</b> ${order?.orderId || "?"}`
      );

      openPositions = await broker.getOpenPositions();
    } catch (err) {
      const msg = err.message || "";
      if (
        msg.includes("Market closed") ||
        msg.includes("10018")
      ) {
        // silent
      } else {
        console.error(`[CYCLE] Error processing ${symbol}:`, msg);
        if (!msg.includes('Market closed') && !msg.includes('10018')) {
          try { await sendTelegramNotification('Order FAILED: ' + symbol + ' - ' + msg); } catch (e) {}
        }
      }
    }
  }

  try {
    const refreshed = await broker.getOpenPositions();
    await runCryptoCycle(refreshed, equity);
  } catch (e) { console.error("[CRYPTO] cycle hook error:", e.message); }
}


// ===== MAIN =====
async function main() {
  console.log("[BOOT] Starting MT trading bot...");
  console.log(`[BOOT] Symbols: ${config.SYMBOLS.join(", ")}`);
  console.log(
    `[BOOT] Risk: ${config.RISK_PER_TRADE_PCT}% per trade`
  );
  console.log(`[BOOT] LIVE_TRADING_ENABLED = ${config.LIVE_TRADING_ENABLED}`);

  await broker.connect();

  // Print the DB backend explicitly at boot. The local file is the ONLY
  // copy of the daily-loss / drawdown history, so the operator must see
  // its exact path. There is no degraded state: local is the one backend.
  const bootDbStatus = db.backendStatus();
  console.log(`[DB] local backend ready (${bootDbStatus.localFile})`);
  console.log(
    `[DB] Trades + risk state are stored there. Backups kept in data/backups/.`
  );

  // Load today's closed trades from DB (survives restart)
  const recentClosed = await loadRecentClosedTradesFromDb();
  todayClosedTrades.length = 0;
  todayClosedTrades.push(...recentClosed);
  console.log(
    `[BOOT] Loaded ${recentClosed.length} recent closed trades from DB.`
  );

  // Startup notification
  await sendTelegramNotification(
    `🚀 <b>BOT YA FARA AIKI</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Symbols:</b> ${config.SYMBOLS.join(", ")}\n` +
      `⏱ <b>Timeframes:</b> ${config.SYMBOLS.map(
        (s) => `${s}=${config.TIMEFRAMES[s]}`
      ).join(", ")}\n` +
      `💰 <b>Risk per trade:</b> ${config.RISK_PER_TRADE_PCT}%\n` +
      `🛑 <b>Daily loss limit:</b> $${config.INTERNAL_DAILY_LOSS_LIMIT}\n` +
      `📉 <b>Max drawdown:</b> $${config.INTERNAL_MAX_DRAWDOWN}\n` +
      `📈 <b>Max open:</b> ${config.MAX_OPEN_TRADES}\n` +
      `Account login: ${broker.connectedAccount ? broker.connectedAccount.login : '?'} (expected ${config.EXPECTED_ACCOUNT_LOGIN || 'NOT SET'})\n` +
      `Server: ${broker.connectedAccount ? broker.connectedAccount.server : '?'} / Balance: ${(() => { try { return Number(broker.connectedAccount.balance).toFixed(2); } catch (e) { return '?'; } })()} / Equity: ${(() => { try { return Number(broker.connectedAccount.equity).toFixed(2); } catch (e) { return '?'; } })()}\n` +
      `Symbols (Crypto): ${(config.CRYPTO_SYMBOLS || []).join(", ")} (${config.CRYPTO_ENABLED ? 'ENABLED' : 'DISABLED'})\n` +
      `DB backend: local (${bootDbStatus.localFile})\n` +
      `Live trading: ${config.LIVE_TRADING_ENABLED ? 'ENABLED' : 'DISABLED'}\n` +
      `🕐 <b>Lokaci:</b> ${new Date().toLocaleString("en-GB")}`
  );

  await syncClosedTrades().catch((e) =>
    console.error(" [TRADE] initial close sync error:", e)
  );

  await runCycle().catch((e) =>
    console.error("[CYCLE] fatal error:", e)
  );

  // ===== HTTP server don health check =====
  // /health returns JSON so an operator (or a watchdog script) can see
  // the DB backend, live equity, open positions and risk lock at a
  // glance, without reading logs.
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      let equity = null;
      let login = null;
      let srv = null;
      try {
        if (broker.connectedAccount) {
          login = broker.connectedAccount.login;
          srv = broker.connectedAccount.server;
          equity = Number(broker.connectedAccount.equity);
        }
      } catch (e) {
        /* keep nulls */
      }
      const bs = db.backendStatus();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify(
          {
            status: "alive",
            db: bs.backend,
            db_local_file: bs.localFile,
            login: login,
            server: srv,
            equity: Number.isFinite(equity) ? equity : null,
            openPositions: openPositionsCount,
            locked: Boolean(riskManager.locked),
            live_trading: Boolean(config.LIVE_TRADING_ENABLED),
            crypto_enabled: Boolean(config.CRYPTO_ENABLED),
            symbols: config.SYMBOLS,
            ts: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const PORT = process.env.PORT || 3000;
  // A port clash must NEVER take the trading bot down. The health server is
  // auxiliary, so we log + alert and keep trading alive instead of crashing.
  server.on("error", async (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `[HTTP] Port ${PORT} already in use (health server not started). Trading continues.`
      );
      try {
        await sendTelegramNotification(
          `⚠️ <b>HEALTH SERVER PORT BUSY</b>\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `🔌 Port: ${PORT}\n` +
            `✅ Trading bot is still running normally.\n` +
            `🕐 <b>Lokaci:</b> ${new Date().toLocaleString("en-GB")}`
        );
      } catch (e) {}
      return;
    }
    console.error("[HTTP] Health server error (trading continues):", err);
  });
  server.listen(PORT, () => {
    console.log(`[HTTP] Health check server running on port ${PORT}`);
  });

  // Trading cycle
  setInterval(() => {
    runCycle().catch((e) =>
      console.error("[CYCLE] fatal error:", e)
    );
  }, config.POLL_INTERVAL_MS);

  // ===== SCHEDULED REPORTS (check every minute) =====
  setInterval(() => {
    runScheduledReports().catch((e) =>
      console.error("[REPORT] scheduler error:", e)
    );
  }, 60 * 1000);
}


main().catch(async (err) => {
  console.error("[FATAL]", err);
  await sendTelegramNotification(
    `❌ <b>BOT YA FAƊI</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `⚠️ <b>Kuskure:</b> ${err.message}\n` +
      `🕐 <b>Lokaci:</b> ${new Date().toLocaleString("en-GB")}`
  );
  process.exit(1);
});