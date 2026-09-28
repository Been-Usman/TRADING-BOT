const fs = require("fs");
const path = require("path");

// ============================================================
// LOCAL DATA STORE (src/localStore.js)
// ------------------------------------------------------------
// This is the ONLY backend. There is no cloud database.
// Everything (trades, daily risk state) lives in one local file:
//   <project>/data/local_db.json
//
// Durability: writes are atomic (tmp file + rename), a corrupt file
// is quarantined instead of crashing the bot, and a dated backup is
// kept on every boot.
// ============================================================

const DATA_DIR = path.join(__dirname, "..", "data");
const LOCAL_DB_FILE = path.join(DATA_DIR, "local_db.json");
const TMP_DB_FILE = path.join(DATA_DIR, "local_db.json.tmp");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 7;

function emptyState() {
  return { risk_state: {}, trades: [], seq: 1 };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[DB] created data directory: ${DATA_DIR}`);
  }
}

function quarantineCorrupt(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(DATA_DIR, `local_db.corrupt.${stamp}.json`);
  try {
    fs.renameSync(LOCAL_DB_FILE, dest);
    console.error(
      `[DB] CORRUPT local_db.json (${reason}) - moved to ${dest}, starting fresh.`
    );
  } catch (err) {
    console.error(
      `[DB] CORRUPT local_db.json (${reason}) and backup failed: ${err.message}`
    );
  }
}

function read() {
  ensureDataDir();
  if (!fs.existsSync(LOCAL_DB_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      quarantineCorrupt("not an object");
      return emptyState();
    }
    return {
      risk_state:
        parsed.risk_state && typeof parsed.risk_state === "object"
          ? parsed.risk_state
          : {},
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      seq: Number(parsed.seq) || 1,
    };
  } catch (err) {
    quarantineCorrupt(err.message);
    return emptyState();
  }
}

function write(state) {
  try {
    ensureDataDir();
    const payload = JSON.stringify(state, null, 2);
    const fd = fs.openSync(TMP_DB_FILE, "w");
    try {
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(TMP_DB_FILE, LOCAL_DB_FILE);
    console.log(`[DB] wrote ${Buffer.byteLength(payload)} bytes`);
    return true;
  } catch (err) {
    console.error("[DB] store write failed:", err.message);
    return false;
  }
}

function backupNow() {
  try {
    ensureDataDir();
    if (!fs.existsSync(LOCAL_DB_FILE)) {
      console.log("[DB] no local_db.json yet - nothing to back up.");
      return null;
    }
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const day = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `local_db.${day}.json`);
    fs.copyFileSync(LOCAL_DB_FILE, dest);
    console.log(`[DB] backup written to ${dest}`);

    const all = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^local_db\.\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    const extra = all.slice(0, Math.max(0, all.length - KEEP_BACKUPS));
    for (const f of extra) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        console.log(`[DB] pruned old backup ${f}`);
      } catch (e) {
        console.error(`[DB] could not prune ${f}: ${e.message}`);
      }
    }
    return dest;
  } catch (err) {
    console.error("[DB] backup failed:", err.message);
    return null;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ===== FIX: Reset starting_equity + locked for a NEW day =====
// Bug: if local_db.json had old starting_equity from a previous
// day, the bot read it and thought the account had lost 12.91%.
// Fix: on the first cycle of a new UTC day, overwrite starting_equity
// with the current equity and reset locked to false.
function getOrCreateDailyState(startingEquity) {
  const equity = Number(startingEquity);
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new Error(`Invalid starting equity: ${startingEquity}`);
  }

  const date = todayStr();
  const state = read();
  const existing = state.risk_state[date];

  if (!existing) {
    // New day -> create fresh state with current equity
    state.risk_state[date] = {
      id: state.seq++,
      date,
      starting_equity: equity,
      realized_pnl: 0,
      locked: false,
      locked_reason: null,
      created_at: new Date().toISOString(),
    };
    write(state);
    console.log(
      `[DB] new risk_state created for ${date}, starting_equity=$${equity.toFixed(2)}`
    );
    return { ...state.risk_state[date] };
  }

  // Same day: keep existing starting_equity (so daily-loss math is correct)
  // BUT if the file is from a previous day (stale), we already created a new
  // entry above. So here it's genuinely the same day.
  return { ...existing };
}

function updateDailyState(date, updates) {
  const state = read();
  if (!state.risk_state[date]) {
    state.risk_state[date] = {
      id: state.seq++,
      date,
      starting_equity: 0,
      realized_pnl: 0,
      locked: false,
      locked_reason: null,
      created_at: new Date().toISOString(),
    };
  }
  state.risk_state[date] = { ...state.risk_state[date], ...updates };
  return write(state);
}

function logTrade(trade) {
  const state = read();
  const row = { id: state.seq++, ...trade };
  state.trades.push(row);
  write(state);
  return row;
}

function countOpenTrades() {
  const state = read();
  return state.trades.filter((t) => t.status === "open").length;
}

function findOpenTradeBySymbol(symbol) {
  const state = read();
  const open = state.trades
    .filter((t) => t.symbol === symbol && t.status === "open")
    .sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
  return open.length ? { ...open[0] } : null;
}

function closeTrade({ id, exitPrice, pnl, closedAt }) {
  const state = read();
  const row = state.trades.find((t) => t.id === id && t.status === "open");
  if (!row) return null;
  row.status = "closed";
  row.exit_price = Number(exitPrice);
  row.pnl = Number(pnl);
  row.closed_at = closedAt || new Date().toISOString();
  write(state);
  return { ...row };
}

function addRealizedPnl(date, pnl, startingEquityFallback) {
  const amount = Number(pnl);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid realized P&L: ${pnl}`);
  }
  const state = read();
  if (!state.risk_state[date]) {
    const start = Number(startingEquityFallback);
    state.risk_state[date] = {
      id: state.seq++,
      date,
      starting_equity: Number.isFinite(start) && start > 0 ? start : 0,
      realized_pnl: 0,
      locked: false,
      locked_reason: null,
      created_at: new Date().toISOString(),
    };
  }
  const current = Number(state.risk_state[date].realized_pnl || 0);
  const updated = current + amount;
  state.risk_state[date].realized_pnl = updated;
  write(state);
  return updated;
}

function countTradesSince(iso) {
  const state = read();
  return state.trades.filter(
    (t) => t.opened_at && String(t.opened_at) >= iso
  ).length;
}

function getClosedTradesSince(iso) {
  const state = read();
  return state.trades
    .filter(
      (t) =>
        t.status === "closed" &&
        t.closed_at &&
        String(t.closed_at) >= iso
    )
    .map((t) => ({
      symbol: t.symbol,
      direction: t.direction,
      pnl: Number(t.pnl || 0),
      closedAt: t.closed_at,
    }));
}

module.exports = {
  FILE: LOCAL_DB_FILE,
  BACKUP_DIR,
  KEEP_BACKUPS,
  read,
  write,
  ensureDataDir,
  backupNow,
  getOrCreateDailyState,
  updateDailyState,
  logTrade,
  countOpenTrades,
  findOpenTradeBySymbol,
  closeTrade,
  addRealizedPnl,
  countTradesSince,
  getClosedTradesSince,
};