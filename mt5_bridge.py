import json
import os
import sys
import time
import MetaTrader5 as mt5


def tf(x):
    return {
        "1m": mt5.TIMEFRAME_M1,
        "5m": mt5.TIMEFRAME_M5,
        "15m": mt5.TIMEFRAME_M15,
        "30m": mt5.TIMEFRAME_M30,
        "1h": mt5.TIMEFRAME_H1,
        "4h": mt5.TIMEFRAME_H4,
        "1d": mt5.TIMEFRAME_D1,
    }.get(x.lower(), mt5.TIMEFRAME_H1)


def out(ok, data=None, error=None):
    print(json.dumps({"ok": ok, "data": data, "error": error}), flush=True)


MT5_PATH = os.environ.get(
    "MT5_PATH", r"C:\Program Files\MetaTrader 5\terminal64.exe"
).strip()


def initialize_with_retry(max_attempts=4, delay_seconds=5, timeout_ms=90000):
    """
    Attach to the running terminal, retrying with backoff.
    Progress goes to STDERR (stdout is the protocol channel).
    Returns (ok, last_error) in EVERY case.
    """
    last = None
    for attempt in range(1, max_attempts + 1):
        if MT5_PATH:
            ok = mt5.initialize(path=MT5_PATH, timeout=timeout_ms)
        else:
            ok = mt5.initialize(timeout=timeout_ms)
        if ok:
            if attempt > 1:
                print(
                    f"[BRIDGE] MT5 IPC ready on attempt "
                    f"{attempt}/{max_attempts}.",
                    file=sys.stderr, flush=True,
                )
            return True, None
        last = mt5.last_error()
        print(
            f"[BRIDGE] MT5 init attempt {attempt}/{max_attempts} "
            f"failed: {last}",
            file=sys.stderr, flush=True,
        )
        if attempt < max_attempts:
            time.sleep(delay_seconds)
    return False, last


_ok, _err = initialize_with_retry()
if not _ok:
    out(False, error=(
        f"MT5 init failed after retries: {_err}. "
        "Is the MT5 terminal running and logged in? "
        "Restart the terminal, wait for the green connection indicator, "
        "then start the bot again."
    ))
    sys.exit(1)


def get_order_filling_type(info):
    mode = int(getattr(info, "filling_mode", 0) or 0)
    if mode & 2:
        return mt5.ORDER_FILLING_IOC
    if mode & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


# ===== NEWS FILTER =====
def get_mt5_common_path():
    try:
        info = mt5.terminal_info()
        if info is None:
            return None
        return os.path.join(info.data_path, "..", "Common")
    except:
        return None


def is_news_time():
    path = get_mt5_common_path()
    if path is None:
        return False
    file_path = os.path.join(path, "news_signal.txt")
    try:
        if not os.path.exists(file_path):
            return False
        with open(file_path, "r") as f:
            signal = f.read().strip().upper()
        if signal == "STOP":
            print("[NEWS] An hana ciniki: babban labari yana nan kusa")
            return True
        return False
    except Exception as e:
        print(f"[NEWS] Kuskure: {e}")
        return False


def move_to_breakeven(ticket, entry_price, current_price, direction, atr):
    try:
        positions = mt5.positions_get(ticket=ticket)
        if not positions or len(positions) == 0:
            return
        pos = positions[0]
        buffer = atr * 0.5

        if direction == "buy":
            trigger = entry_price + atr
            if current_price >= trigger:
                new_sl = entry_price + buffer
                if pos.sl < new_sl:
                    request = {
                        "action": mt5.TRADE_ACTION_SLTP,
                        "position": ticket,
                        "sl": new_sl,
                        "tp": pos.tp,
                    }
                    result = mt5.order_send(request)
                    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                        print(f"[BE] Ticket {ticket}: SL ya koma {new_sl}")

        elif direction == "sell":
            trigger = entry_price - atr
            if current_price <= trigger:
                new_sl = entry_price - buffer
                if pos.sl > new_sl or pos.sl == 0:
                    request = {
                        "action": mt5.TRADE_ACTION_SLTP,
                        "position": ticket,
                        "sl": new_sl,
                        "tp": pos.tp,
                    }
                    result = mt5.order_send(request)
                    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                        print(f"[BE] Ticket {ticket}: SL ya koma {new_sl}")
    except Exception as e:
        print(f"[BE] Kuskure: {e}")


def apply_breakeven_to_all():
    try:
        positions = mt5.positions_get()
        if positions is None:
            return
        for pos in positions:
            tick = mt5.symbol_info_tick(pos.symbol)
            if tick is None:
                continue
            info = mt5.symbol_info(pos.symbol)
            if info is None:
                continue
            entry = pos.price_open
            atr_estimate = info.point * 100
            if pos.type == mt5.POSITION_TYPE_BUY:
                move_to_breakeven(pos.ticket, entry, tick.bid, "buy", atr_estimate)
            elif pos.type == mt5.POSITION_TYPE_SELL:
                move_to_breakeven(pos.ticket, entry, tick.ask, "sell", atr_estimate)
    except Exception as e:
        print(f"[BE] Kuskure: {e}")


def demo_order(symbol, direction, volume, stop_loss, take_profit):
    if is_news_time():
        return None, "NEWS BLOCK: Babban labari yana nan kusa. An hana ciniki."
    account = mt5.account_info()

    if account is None:
        return None, "Cannot read MT5 account."

    server = str(account.server or "")

    # ===== ACCOUNT IDENTITY GATE =====
    expected_login = os.environ.get("EXPECTED_ACCOUNT_LOGIN", "").strip()
    if not expected_login:
        return None, "ORDER BLOCKED: EXPECTED_ACCOUNT_LOGIN is not set - refusing to trade any account."
    if str(account.login) != expected_login:
        return None, f"ORDER BLOCKED: account login {account.login} != expected {expected_login}"

    if not account.trade_allowed:
        return None, "ORDER BLOCKED: trading is not allowed."

    if not account.trade_expert:
        return None, "ORDER BLOCKED: Expert trading is disabled."

    if not mt5.symbol_select(symbol, True):
        return None, f"Cannot select symbol: {symbol}"

    info = mt5.symbol_info(symbol)

    if info is None:
        return None, f"Symbol not found: {symbol}"

    trade_mode = int(getattr(info, "trade_mode", 4) or 0)
    if trade_mode == 0:
        return None, (
            f"ORDER BLOCKED: {symbol} is DISABLED for trading on this account "
            f"(trade_mode=0). Ask the broker to enable it."
        )
    if trade_mode == 2 and str(direction).lower() != "sell":
        return None, f"ORDER BLOCKED: {symbol} is SHORT-ONLY (trade_mode=2)."
    if trade_mode == 3 and str(direction).lower() != "buy":
        return None, f"ORDER BLOCKED: {symbol} is LONG-ONLY (trade_mode=3)."

    tick = mt5.symbol_info_tick(symbol)

    if tick is None:
        return None, f"No price available for {symbol}"

    try:
        max_spread_env = os.environ.get("MAX_SPREAD_POINTS", "").strip()
        if max_spread_env:
            info_sp = mt5.symbol_info(symbol)
            if info_sp is not None and getattr(info_sp, "point", 0):
                spread_pts = None
                if tick.ask and tick.bid:
                    spread_pts = (float(tick.ask) - float(tick.bid)) / float(info_sp.point)
                if spread_pts is not None and spread_pts > float(max_spread_env):
                    return None, f"ORDER BLOCKED: spread {spread_pts:.1f} pts > MAX_SPREAD_POINTS {max_spread_env}"
    except Exception:
        pass

    volume = float(volume)
    stop_loss = float(stop_loss)
    take_profit = float(take_profit)

    if volume <= 0:
        return None, "Invalid volume."

    if volume < float(info.volume_min):
        return None, f"Volume below minimum: {info.volume_min}"

    if volume > float(info.volume_max):
        return None, f"Volume above maximum: {info.volume_max}"

    step = float(info.volume_step)

    if step <= 0:
        return None, "Invalid volume step."

    volume = round(volume / step) * step
    volume = round(volume, 8)

    if direction == "buy":
        order_type = mt5.ORDER_TYPE_BUY
        price = float(tick.ask)
    elif direction == "sell":
        order_type = mt5.ORDER_TYPE_SELL
        price = float(tick.bid)
    else:
        return None, f"Invalid direction: {direction}"

    filling_type = get_order_filling_type(info)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": stop_loss,
        "tp": take_profit,
        "deviation": int(os.environ.get("MAX_SLIPPAGE_POINTS", "20").strip() or "20"),
        "magic": 260911,
        "comment": "TRADING-BOT-DEMO",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_type,
    }

    check = mt5.order_check(request)

    if check is None:
        return None, f"Order check failed: {mt5.last_error()}"

    if check.retcode != 0:
        return None, (
            f"Order check rejected: "
            f"retcode={check.retcode}, "
            f"comment={check.comment}"
        )

    result = mt5.order_send(request)

    if result is None:
        return None, f"Order send failed: {mt5.last_error()}"

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return None, (
            f"Order rejected: "
            f"retcode={result.retcode}, "
            f"comment={result.comment}"
        )

    return {
        "orderId": int(result.order),
        "dealId": int(result.deal),
        "symbol": symbol,
        "direction": direction,
        "volume": volume,
        "price": float(result.price),
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "server": server,
    }, None


for line in sys.stdin:
    try:
        r = json.loads(line)
        a = r.get("action")

        if a == "ping":
            out(True, {"message": "MT5 bridge online"})

        elif a == "account":
            x = mt5.account_info()

            if x is None:
                out(False, error=str(mt5.last_error()))
            else:
                out(True, {
                    "server": x.server,
                    "login": x.login,
                    "balance": x.balance,
                    "equity": x.equity,
                    "margin": x.margin,
                    "margin_free": x.margin_free,
                    "trade_allowed": x.trade_allowed,
                    "trade_expert": x.trade_expert,
                    "currency": x.currency
                })

        elif a == "symbol":
            s = r["symbol"]
            mt5.symbol_select(s, True)
            x = mt5.symbol_info(s)

            if x is None:
                out(False, error="Symbol not found: " + s)
            else:
                out(True, {
                    "name": x.name,
                    "visible": x.visible,
                    "point": x.point,
                    "digits": x.digits,
                    "tickSize": x.trade_tick_size,
                    "tickValue": x.trade_tick_value,
                    "minVolume": x.volume_min,
                    "maxVolume": x.volume_max,
                    "volumeStep": x.volume_step
                })

        elif a == "candles":
            s = r["symbol"]
            mt5.symbol_select(s, True)
            time.sleep(0.1)

            rates = None
            for attempt in range(3):
                rates = mt5.copy_rates_from_pos(
                    s,
                    tf(r.get("timeframe", "1h")),
                    0,
                    int(r.get("count", 250))
                )
                if rates is not None and len(rates) > 0:
                    break
                time.sleep(0.5)

            if rates is None or len(rates) == 0:
                out(False, error=str(mt5.last_error()))
            else:
                out(True, [
                    {
                        "time": int(x["time"]),
                        "open": float(x["open"]),
                        "high": float(x["high"]),
                        "low": float(x["low"]),
                        "close": float(x["close"])
                    }
                    for x in rates
                ])

        elif a == "breakeven":
            apply_breakeven_to_all()
            out(True, {"message": "Break-even an yi"})

        elif a == "positions":
            p = mt5.positions_get()

            if p is None:
                out(True, [])
            else:
                out(True, [
                    {
                        "ticket": int(x.ticket),
                        "position_id": int(x.ticket),
                        "symbol": x.symbol,
                        "type": int(x.type),
                        "volume": float(x.volume),
                        "price_open": float(x.price_open),
                        "sl": float(x.sl),
                        "tp": float(x.tp),
                        "profit": float(x.profit)
                    }
                    for x in p
                ])

        elif a == "history":
            account = mt5.account_info()

            if account is None:
                out(False, error="Cannot read MT5 account.")
                continue

            expected_login_hist = os.environ.get("EXPECTED_ACCOUNT_LOGIN", "").strip()
            if not expected_login_hist:
                out(False, error="ORDER BLOCKED: EXPECTED_ACCOUNT_LOGIN is not set - refusing to read history.")
                continue
            if str(account.login) != expected_login_hist:
                out(False, error=f"ORDER BLOCKED: account login {account.login} != expected {expected_login_hist}")
                continue

            from datetime import datetime, timezone, timedelta

            now = datetime.now(timezone.utc)
            seconds = int(r.get("seconds", 86400))

            if seconds <= 0:
                seconds = 86400

            seconds = min(seconds, 604800)

            start = now - timedelta(seconds=seconds)

            deals = mt5.history_deals_get(start, now)

            if deals is None:
                out(True, [])
            else:
                closed = []

                for x in deals:
                    entry = int(getattr(x, "entry", -1))

                    if entry != mt5.DEAL_ENTRY_OUT:
                        continue

                    closed.append({
                        "deal_id": int(x.ticket),
                        "order_id": int(x.order),
                        "position_id": int(x.position_id),
                        "symbol": x.symbol,
                        "type": int(x.type),
                        "volume": float(x.volume),
                        "price": float(x.price),
                        "profit": float(x.profit),
                        "commission": float(x.commission),
                        "swap": float(x.swap),
                        "fee": float(getattr(x, "fee", 0.0)),
                        "time": int(x.time),
                        "entry": entry
                    })

                out(True, closed)

        elif a == "order":
            result, error = demo_order(
                symbol=r["symbol"],
                direction=r["direction"],
                volume=r["volume"],
                stop_loss=r["stopLoss"],
                take_profit=r["takeProfit"]
            )

            if error:
                out(False, error=error)
            else:
                out(True, result)

        elif a == "calc_profit":
            s = r["symbol"]
            vol = float(r.get("volume", 1.0))
            open_price = float(r["openPrice"])
            close_price = float(r["closePrice"])
            direction = r.get("direction", "buy")
            order_type = (
                mt5.ORDER_TYPE_BUY if direction == "buy" else mt5.ORDER_TYPE_SELL
            )
            profit = mt5.order_calc_profit(order_type, s, vol, open_price, close_price)
            if profit is None:
                out(False, error=str(mt5.last_error()))
            else:
                out(True, {"profit": float(profit)})

        else:
            out(False, error="Unknown action: " + str(a))

    except Exception as e:
        out(False, error=str(e))


mt5.shutdown()