// ============================================================
// LOCAL DATA LAYER (src/dbStore.js)
// ------------------------------------------------------------
// Single backend: data/local_db.json (see src/localStore.js).
//
// NOTE: the previous cloud-database code path was removed after the
// provider project became unreachable and the operator chose a fully
// local database. There is no network branch left, so the bot's risk
// accounting (daily loss, drawdown, daily trade count) can never stall
// on a network call.
//
// This wrapper keeps the original async API so that every existing
// caller (src/index.js, src/riskManager.js) keeps working unchanged.
// ============================================================

const localStore = require("./localStore");

// ---- backend status -------------------------------------------
// Kept for compatibility with the /health endpoint and the boot
// banner. The local store is the only backend and is healthy by
// design, so `degraded` is always false.
function backendStatus() {
  return {
    backend: "local",
    localFile: localStore.FILE,
    degraded: false,
  };
}

function todayStr() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

// ---- daily risk state ------------------------------------------
async function getOrCreateDailyState(startingEquity) {
  return localStore.getOrCreateDailyState(startingEquity);
}

async function updateDailyState(date, updates) {
  return localStore.updateDailyState(date, updates);
}

async function addRealizedPnl(date, pnl) {
  return localStore.addRealizedPnl(date, pnl);
}

// ---- trades ----------------------------------------------------
async function logTrade(trade) {
  return localStore.logTrade(trade);
}

async function countOpenTradesInDb() {
  return localStore.countOpenTrades();
}

async function findOpenTradeBySymbol(symbol) {
  return localStore.findOpenTradeBySymbol(symbol);
}

async function closeTrade({ id, exitPrice, pnl, closedAt }) {
  return localStore.closeTrade({
    id: id,
    exitPrice: exitPrice,
    pnl: pnl,
    closedAt: closedAt,
  });
}

async function countTradesSince(iso) {
  return localStore.countTradesSince(iso);
}

async function getClosedTradesSince(iso) {
  return localStore.getClosedTradesSince(iso);
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
};
