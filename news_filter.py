from dotenv import load_dotenv
load_dotenv()

import time
import os
import httpx
from datetime import datetime, timezone

MINUTES_BEFORE_NEWS = 5
MINUTES_AFTER_NEWS = 5
CHECK_INTERVAL = 300
QUANTGIST_API_KEY = os.environ.get("QUANTGIST_API_KEY", "")
QUANTGIST_URL = "https://api.quantgist.com/v1/macro/calendar"
EVENTS = "CPI,NFP,FOMC,ECB,GDP,PPI"

def get_mt5_common_path():
    try:
        import MetaTrader5 as mt5
        if not mt5.initialize():
            return None
        info = mt5.terminal_info()
        mt5.shutdown()
        if info is None:
            return None
        return os.path.join(info.data_path, "..", "Common")
    except Exception as e:
        print(f"[NEWS] Kuskure: {e}")
        return None

def write_news_signal(signal):
    path = get_mt5_common_path()
    if path is None:
        return
    file_path = os.path.join(path, "news_signal.txt")
    try:
        with open(file_path, "w") as f:
            f.write(signal)
    except Exception as e:
        print(f"[NEWS] Kuskure wajen rubuta: {e}")

def fetch_calendar():
    if not QUANTGIST_API_KEY:
        print("[NEWS] Babu QUANTGIST_API_KEY a .env")
        return []
    try:
        headers = {"X-API-Key": QUANTGIST_API_KEY}
        params = {"events": EVENTS, "days": 2}
        response = httpx.get(QUANTGIST_URL, headers=headers, params=params, timeout=10)
        if response.status_code == 200:
            return response.json()
        else:
            print(f"[NEWS] API error: {response.status_code}")
            return {}
    except Exception as e:
        print(f"[NEWS] Kuskure wajen samo calendar: {e}")
        return {}

def parse_event_time(event):
    for key in ["date", "time", "release_at", "scheduled_at", "datetime"]:
        if key in event and event[key]:
            try:
                return datetime.fromisoformat(str(event[key]).replace("Z", "+00:00"))
            except Exception:
                continue
    return None

def check_high_impact_news():
    response = fetch_calendar()
    if not response or "data" not in response:
        return False
    now = datetime.now(timezone.utc)
    for group in response["data"]:
        events = group.get("data", [])
        if not events:
            continue
        for event in events:
            event_time = parse_event_time(event)
            if event_time is None:
                continue
            diff_minutes = (event_time - now).total_seconds() / 60
            if -MINUTES_AFTER_NEWS < diff_minutes < MINUTES_BEFORE_NEWS:
                label = group.get("label", group.get("alias", "Unknown"))
                country = group.get("country", "")
                print(f"[NEWS] An gano labari: {label} ({country})")
                return True
    return False

def main():
    print("[NEWS] News filter (QuantGist) ya fara aiki...")
    print(f"[NEWS] Zai duba events: {EVENTS}")
    print(f"[NEWS] Zai hana ciniki minti {MINUTES_BEFORE_NEWS} kafin labari")
    while True:
        try:
            if check_high_impact_news():
                write_news_signal("STOP")
            else:
                write_news_signal("GO")
        except Exception as e:
            print(f"[NEWS] Kuskure: {e}")
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
