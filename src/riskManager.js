const config = require("./config");
const db = require("./db");

class RiskManager {
  constructor() {
    this.locked = false;
    this.consecutiveLosses = 0;
    this.lastLossAt = null;
  }

  async syncDailyState(currentEquity) {
    const equity = Number(currentEquity);

    if (!Number.isFinite(equity) || equity <= 0) {
      throw new Error(
        `Invalid current equity: ${currentEquity}`
      );
    }

    const state =
      await db.getOrCreateDailyState(
        equity
      );

    const startingEquity = Number(
      state.starting_equity
    );

    if (
      !Number.isFinite(startingEquity) ||
      startingEquity <= 0
    ) {
      throw new Error(
        `Invalid starting_equity in risk_state: ${state.starting_equity}`
      );
    }

    const lossSoFarPct =
      ((startingEquity - equity) /
        startingEquity) *
      100;

    const initialEquity =
      Number(config.INITIAL_EQUITY);

    if (
      !Number.isFinite(initialEquity) ||
      initialEquity <= 0
    ) {
      throw new Error(
        `Invalid INITIAL_EQUITY: ${config.INITIAL_EQUITY}`
      );
    }

    const maxDrawdownPct =
      ((initialEquity - equity) /
        initialEquity) *
      100;

    if (
      maxDrawdownPct >=
      config.MAX_DRAWDOWN_PCT
    ) {
      this.locked = true;

      if (!state.locked) {
        await db.updateDailyState(
          state.date,
          { locked: true }
        );
      }

      console.error(
        `[RISK] Maximum drawdown reached: ${maxDrawdownPct.toFixed(
          2
        )}% >= ${config.MAX_DRAWDOWN_PCT}%. Trading halted.`
      );

      return {
        state,
        lossSoFarPct,
        maxDrawdownPct,
        lockedReason: "DRAWDOWN_8PCT",
      };
    }

    if (
      lossSoFarPct >=
        config.MAX_DAILY_LOSS_PCT &&
      !state.locked
    ) {
      await db.updateDailyState(
        state.date,
        { locked: true }
      );

      this.locked = true;

      console.error(
        `[RISK] Daily loss limit hit: ${lossSoFarPct.toFixed(
          2
        )}% >= ${
          config.MAX_DAILY_LOSS_PCT
        }%. Trading halted for today.`
      );
    } else {
      this.locked = Boolean(
        state.locked
      );
    }

    let lockedReason = null;
    if (maxDrawdownPct >= config.MAX_DRAWDOWN_PCT) lockedReason = "DRAWDOWN_8PCT";
    else if (lossSoFarPct >= config.MAX_DAILY_LOSS_PCT) lockedReason = "DAILY_LOSS_4PCT";
    else if (this.locked || state.locked) lockedReason = "UNKNOWN (locked earlier, thresholds currently clear)";

    return {
      state,
      lossSoFarPct,
      maxDrawdownPct,
      lockedReason,
    };
  }

  calculatePositionSize({
    equity,
    stopLossDistancePrice,
    valuePerPriceUnitPerLot,
  }) {
    const accountEquity = Number(
      equity
    );

    const distance = Number(
      stopLossDistancePrice
    );

    const valuePerUnit = Number(
      valuePerPriceUnitPerLot
    );

    if (
      !Number.isFinite(accountEquity) ||
      accountEquity <= 0
    ) {
      return 0;
    }

    if (
      !Number.isFinite(distance) ||
      distance <= 0
    ) {
      return 0;
    }

    if (
      !Number.isFinite(valuePerUnit) ||
      valuePerUnit <= 0
    ) {
      return 0;
    }

    const riskAmount =
      accountEquity *
      (config.RISK_PER_TRADE_PCT / 100);

    const lossPerLot =
      distance * valuePerUnit;

    if (
      !Number.isFinite(lossPerLot) ||
      lossPerLot <= 0
    ) {
      return 0;
    }

    const lots =
      riskAmount / lossPerLot;

    if (
      !Number.isFinite(lots) ||
      lots <= 0
    ) {
      return 0;
    }

    return lots;
  }

  async checkTradeAllowed({
    openTradeCount,
  }) {
    if (this.locked) {
      return {
        allowed: false,
        reason:
          "Risk lock active - trading locked.",
      };
    }

    if (
      openTradeCount >=
      config.MAX_CONCURRENT_TRADES
    ) {
      return {
        allowed: false,
        reason: `Max concurrent trades (${config.MAX_CONCURRENT_TRADES}) reached.`,
      };
    }

    return {
      allowed: true,
      reason: null,
    };
  }
}


// ===== PRODUCTION SAFETY ADD-ON =====
RiskManager.prototype.checkProductionLimits = function ({
  openPositionsCount,
  equity,
  referenceEquity,
  dailyRealizedPnl,
}) {
  const reasons = [];

  if (openPositionsCount >= config.MAX_OPEN_TRADES) {
    reasons.push(`MAX_OPEN_TRADES (${openPositionsCount}/${config.MAX_OPEN_TRADES})`);
  }

  if (this.consecutiveLosses >= config.MAX_CONSECUTIVE_LOSSES) {
    reasons.push(`MAX_CONSECUTIVE_LOSSES (${this.consecutiveLosses})`);
  }

  if (this.lastLossAt && (Number(this.consecutiveLosses) || 0) > 0) {
    const mins = (Date.now() - new Date(this.lastLossAt).getTime()) / 60000;
    if (mins < config.COOLDOWN_AFTER_LOSS_MIN) {
      reasons.push(`COOLDOWN: jira ${Math.ceil(config.COOLDOWN_AFTER_LOSS_MIN - mins)} min`);
    }
  }

  if (referenceEquity && equity) {
    const dd = referenceEquity - equity;
    if (dd >= config.INTERNAL_MAX_DRAWDOWN) {
      reasons.push(`INTERNAL_MAX_DRAWDOWN (${dd.toFixed(2)})`);
    }
  }

  const dailyLoss = Math.max(0, -(dailyRealizedPnl || 0));
  if (dailyLoss >= config.INTERNAL_DAILY_LOSS_LIMIT) {
    reasons.push(`INTERNAL_DAILY_LOSS_LIMIT (${dailyLoss.toFixed(2)})`);
  }

  return { allowed: reasons.length === 0, reasons };
};

RiskManager.prototype.recordTradeResult = function (pnl) {
  if (pnl < 0) {
    this.consecutiveLosses = (Number(this.consecutiveLosses) || 0) + 1;
    this.lastLossAt = new Date().toISOString();
  } else if (pnl > 0) {
    this.consecutiveLosses = 0;
  }
};
module.exports = new RiskManager();
