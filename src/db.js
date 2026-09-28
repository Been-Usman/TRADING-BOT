const localStore = require("./localStore");

// ============================================================
// DB FACADE (src/db.js)
// ------------------------------------------------------------
// The bot's data layer. Everything routes through localStore,
// which owns data/local_db.json. No Supabase, no cloud.
// ============================================================

function backendStatus() {
  return {
    backend: "local",
    localFile: localStore.FILE,
    backupDir: localStore.BACKUP_DIR,
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ===== RISK STATE =====
function getOrCreateDailyState(startingEquity) {
  return localStore.getOrCreateDailyState(startingEquity);
}

function updateDailyState(date, updates) {
  return localStore.updateDailyState(date, updates);
}

function addRealizedPnl(date, pnl, startingEquityFallback) {
  return localStore.addRealizedPnl(date, pnl, startingEquityFallback);
}

// ===== TRADES =====
function logTrade(trade) {
  return localStore.logTrade(trade);
}

function countOpenTradesInDb() {
  return localStore.countOpenTrades();
}

function findOpenTradeBySymbol(symbol) {
  return localStore.findOpenTradeBySymbol(symbol);
}

function closeTrade({ id, exitPrice, pnl, closedAt }) {
  return localStore.closeTrade({ id, exitPrice, pnl, closedAt });
}

function countTradesSince(iso) {
  return localStore.countTradesSince(iso);
}

function getClosedTradesSince(iso) {
  return localStore.getClosedTradesSince(iso);
}

// ===== BACKUP =====
function backupNow() {
  return localStore.backupNow();
}

module.exports = {
  backendStatus,
  todayStr,
  getOrCreateDailyState,
  updateDailyState,
  addRealizedPnl,
  logTrade,
  countOpenTradesInDb,
  findOpenTradeBySymbol,
  closeTrade,
  countTradesSince,
  getClosedTradesSince,
  backupNow,
};