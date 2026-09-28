const { spawn } = require("child_process");
const path = require("path");
const config = require("./config");

class Broker {
  constructor() {
    this.bridge = null;
    this.pending = [];
    this.buffer = "";
    this.connectedAccount = null;
    this.sawInitFailure = false;
  }

  // Fire-and-forget Telegram alert from inside the broker layer.
  notifyTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.error("[TELEGRAM] alert skipped - token/chat missing.");
      return;
    }

    const url = "https://api.telegram.org/bot" + token + "/sendMessage";

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) {
          console.error("[TELEGRAM] send failed:", data.description);
        } else {
          console.error("[TELEGRAM] alert sent, id:", data.result.message_id);
        }
      })
      .catch((err) => {
        console.error("[TELEGRAM] send error:", err.message);
      });
  }

  async connect() {
    const bridgePath = path.join(__dirname, "..", "mt5_bridge.py");

    this.bridge = spawn(
      process.env.PYTHON_PATH || "python",
      [bridgePath],
      {
        cwd: path.join(__dirname, ".."),
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.bridge.stdout.setEncoding("utf8");

    this.bridge.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          const waiter = this.pending.shift();
          if (!waiter) continue;

          if (response.ok) {
            waiter.resolve(response.data);
          } else {
            waiter.reject(new Error(response.error || "MT5 bridge error"));
          }
        } catch (err) {
          console.error("[BRIDGE] Invalid response:", line);
        }
      }
    });

    this.bridge.stderr.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.error("[BRIDGE STDERR]", msg);
      }
      if (/MT5 init attempt|IPC/i.test(msg)) {
        this.sawInitFailure = true;
      }
    });

    this.bridge.on("exit", (code) => {
      console.error("[BRIDGE] Python bridge exited:", code);

      if (code === 1 && this.sawInitFailure) {
        this.notifyTelegram(
          "⚠️ MT5 TERMINAL NOT READY\n" +
            "━━━━━━━━━━━━━━━━\n" +
            "The bot could not attach to the MT5 terminal\n" +
            "(IPC timeout after 4 retries).\n\n" +
            "👉 FIX (2 min, no bot change needed):\n" +
            "1. Open MetaTrader 5 (it must stay OPEN)\n" +
            "2. Log in to account " +
            (config.EXPECTED_ACCOUNT_LOGIN || "575038") +
            "\n" +
            "3. Wait for the green connection indicator\n" +
            "4. Then restart the bot\n\n" +
            "No orders were placed. No trades were lost."
        );
      }

      const waiters = this.pending.splice(0, this.pending.length);
      for (const waiter of waiters) {
        waiter.reject(new Error("MT5 bridge exited (code " + code + ")."));
      }
    });

    await this.request({ action: "ping" });

    const account = await this.request({ action: "account" });

    if (!account || !Number.isFinite(Number(account.equity))) {
      throw new Error(
        `Invalid MT5 account equity: ${account && account.equity}`
      );
    }

    this.connectedAccount = account;

    console.log("[BROKER] Connected to local MetaTrader 5.");
    console.log("[BROKER] Server:", account.server);
    console.log("[BROKER] Login:", account.login);
    console.log("[BROKER] Equity:", Number(account.equity));
    console.log("[BROKER] LIVE_TRADING_ENABLED =", config.LIVE_TRADING_ENABLED);

    // ===== ACCOUNT IDENTITY GATE =====
    if (!config.EXPECTED_ACCOUNT_LOGIN && config.LIVE_TRADING_ENABLED) {
      throw new Error(
        "SAFETY STOP: EXPECTED_ACCOUNT_LOGIN is not set while LIVE_TRADING_ENABLED=true. Refusing to connect."
      );
    }

    if (config.EXPECTED_ACCOUNT_LOGIN) {
      console.log(
        "[BROKER] Comparing account login '" +
          String(account.login) +
          "' against EXPECTED_ACCOUNT_LOGIN '" +
          String(config.EXPECTED_ACCOUNT_LOGIN) +
          "'"
      );

      if (String(account.login) !== String(config.EXPECTED_ACCOUNT_LOGIN)) {
        throw new Error(
          `SAFETY STOP: Connected account (${account.login}) does not match ` +
            `EXPECTED_ACCOUNT_LOGIN (${config.EXPECTED_ACCOUNT_LOGIN}).`
        );
      }
      console.log("[BROKER] Account identity check: PASSED.");
    } else {
      console.warn(
        "[BROKER] WARNING: EXPECTED_ACCOUNT_LOGIN ba a saita ba a .env. " +
          "Bot zai iya ciniki a kowace account da aka haɗa."
      );
    }
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      if (
        !this.bridge ||
        !this.bridge.stdin ||
        !this.bridge.stdin.writable
      ) {
        reject(new Error("MT5 bridge is not running."));
        return;
      }

      this.pending.push({ resolve, reject });

      try {
        this.bridge.stdin.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        this.pending.pop();
        reject(err);
      }
    });
  }

  async getAccountInformation() {
    const account = await this.request({ action: "account" });

    if (!account) {
      throw new Error("MT5 returned empty account information.");
    }

    const equity = Number(account.equity);

    if (!Number.isFinite(equity) || equity <= 0) {
      throw new Error(`Invalid MT5 equity returned: ${account.equity}`);
    }

    return { ...account, equity };
  }

  async getCandles(symbol, timeframe, count) {
    try {
      const strat = require("./strategy");
      if (
        strat &&
        typeof strat.isStablecoin === "function" &&
        strat.isStablecoin(symbol, "")
      ) {
        throw new Error(
          `STABLECOIN BLOCK: ${symbol} is blacklisted, refusing candles.`
        );
      }
    } catch (e) {
      if (String(e.message || "").startsWith("STABLECOIN BLOCK")) throw e;
    }

    const candles = await this.request({
      action: "candles",
      symbol,
      timeframe,
      count,
    });

    if (!Array.isArray(candles)) {
      throw new Error(`Invalid candle response for ${symbol}.`);
    }

    return candles;
  }

  async getSymbolSpecification(symbol) {
    const spec = await this.request({ action: "symbol", symbol });

    if (!spec) {
      throw new Error(
        `No MT5 symbol specification returned for ${symbol}.`
      );
    }

    return spec;
  }

  async getSymbolPrice(symbol) {
    const candles = await this.getCandles(symbol, "1m", 1);

    if (!candles || !candles.length) {
      throw new Error(`No price data for ${symbol}`);
    }

    const candle = candles[candles.length - 1];

    return {
      bid: candle.close,
      ask: candle.close,
      time: candle.time,
    };
  }

  async getOpenPositions() {
    const positions = await this.request({ action: "positions" });

    if (!Array.isArray(positions)) {
      throw new Error("Invalid MT5 positions response.");
    }

    return positions;
  }

  async placeMarketOrder({
    symbol,
    direction,
    volume,
    stopLoss,
    takeProfit,
  }) {
    if (!config.LIVE_TRADING_ENABLED) {
      throw new Error(
        "SAFETY STOP: LIVE_TRADING_ENABLED is not 'true'. Refusing to send order."
      );
    }

    try {
      const strat2 = require("./strategy");
      if (
        strat2 &&
        typeof strat2.isStablecoin === "function" &&
        strat2.isStablecoin(symbol, "")
      ) {
        throw new Error(
          `STABLECOIN BLOCK: ${symbol} is blacklisted, refusing order.`
        );
      }
    } catch (e) {
      if (String(e.message || "").startsWith("STABLECOIN BLOCK")) throw e;
    }

    if (!symbol) throw new Error("Order symbol is required.");
    if (!["buy", "sell"].includes(direction)) {
      throw new Error(`Invalid order direction: ${direction}`);
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      throw new Error(`Invalid order volume: ${volume}`);
    }
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      throw new Error(`Invalid stop loss: ${stopLoss}`);
    }
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
      throw new Error(`Invalid take profit: ${takeProfit}`);
    }

    return await this.request({
      action: "order",
      symbol,
      direction,
      volume,
      stopLoss,
      takeProfit,
    });
  }
}

module.exports = new Broker();

module.exports.getClosedHistory = async function () {
  const history = await this.request({ action: "history" });
  return Array.isArray(history) ? history : [];
};

module.exports.getCalcProfit = async function ({
  symbol,
  direction,
  volume,
  openPrice,
  closePrice,
}) {
  const result = await this.request({
    action: "calc_profit",
    symbol,
    direction,
    volume,
    openPrice,
    closePrice,
  });
  return result && typeof result.profit !== "undefined"
    ? Number(result.profit)
    : null;
};