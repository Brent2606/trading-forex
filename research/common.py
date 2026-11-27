"""Shared helpers for the NEONFX research scripts: data loading, costs and reporting."""
import glob
import json
import os
import time
import urllib.request

import numpy as np
import pandas as pd

PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP',
         'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF', 'EURAUD', 'GBPCHF', 'CADJPY', 'AUDNZD']
# Typical spread in pips, as in the bot (src/core/instruments.ts).
SPREAD = {'EURUSD': 0.6, 'GBPUSD': 0.9, 'USDJPY': 0.8, 'USDCHF': 1.1, 'AUDUSD': 0.8, 'USDCAD': 1.2,
          'NZDUSD': 1.3, 'EURGBP': 1.0, 'EURJPY': 1.2, 'GBPJPY': 2.0, 'AUDJPY': 1.4, 'EURCHF': 1.4,
          'EURAUD': 1.8, 'GBPCHF': 2.2, 'CADJPY': 1.7, 'AUDNZD': 2.0}
# Commission ($3.50 per lot per side ≈ 0.7 pips round trip) and slippage, in pips.
COMMISSION_PIPS = 0.7
SLIP_PIPS = 0.3


def pip(sym):
    return 0.01 if sym.endswith('JPY') else 0.0001


# Measured spreads (icm_import.py writes spreads.json): set SPREADS=/path/spreads.json to use them.
SPREAD_PROFILE = None
if os.environ.get('SPREADS'):
    with open(os.environ['SPREADS']) as _f:
        SPREAD_PROFILE = json.load(_f)


def server_hours(index):
    """Hour on the broker's clock (New York + 7 h) for each bar."""
    return (index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)).hour.to_numpy()


def cost_pips(sym):
    """Round-trip cost of one trade in pips: spread + commission + slippage."""
    prof = (SPREAD_PROFILE or {}).get(sym)
    return (prof['tick_weighted'] if prof else SPREAD[sym]) + COMMISSION_PIPS + SLIP_PIPS


def load_hourly(folder):
    """Hourly CSVs written by scripts/fetch-history.mjs (time,open,high,low,close)."""
    out = {}
    for f in sorted(glob.glob(os.path.join(folder, '*_H1_real.csv'))):
        sym = os.path.basename(f)[:6]
        df = pd.read_csv(f)
        df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
        df = df.drop_duplicates('time').set_index('time').sort_index()
        # Drop weekend bars (FX is closed from Friday 22:00 to Sunday 21:00 UTC).
        df = df[~((df.index.dayofweek == 5) | ((df.index.dayofweek == 6) & (df.index.hour < 21)))]
        out[sym] = df[['open', 'high', 'low', 'close']].astype(float)
    return out


def fetch_daily(folder, pairs=PAIRS, first_year=2003):
    """Downloads daily history (Yahoo Finance) for each pair; skips files under a day old.

    Asked for in 4-year pieces: one request for the whole history comes back as monthly bars."""
    os.makedirs(folder, exist_ok=True)
    now = int(time.time())
    for sym in pairs:
        path = os.path.join(folder, f'{sym}_D1.csv')
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400 and sum(1 for _ in open(path)) > 3000:
            continue
        parts = []
        year = first_year
        while True:
            p1 = int(pd.Timestamp(year=year, month=1, day=1, tz='UTC').timestamp())
            p2 = min(now, int(pd.Timestamp(year=year + 4, month=1, day=1, tz='UTC').timestamp()))
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}=X?interval=1d&period1={p1}&period2={p2}'
            req = urllib.request.Request(url, headers={'user-agent': 'Mozilla/5.0'})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    res = json.load(r)['chart']['result'][0]
                q = res['indicators']['quote'][0]
                if res.get('timestamp'):
                    parts.append(pd.DataFrame({'time': res['timestamp'], 'open': q['open'], 'high': q['high'], 'low': q['low'], 'close': q['close']}))
            except Exception as e:  # a missing early period is fine; the row count is checked below
                print(f'{sym} {year}: {e}')
            time.sleep(1.2)
            if p2 >= now:
                break
            year += 4
        df = pd.concat(parts).dropna()
        df = df[(df[['open', 'high', 'low', 'close']] > 0).all(axis=1)].drop_duplicates('time').sort_values('time')
        df.to_csv(path, index=False)
        years = (df['time'].iloc[-1] - df['time'].iloc[0]) / 86400 / 365.25
        print(f'{sym}: {len(df)} daily bars over {years:.1f} years ({len(df) / years:.0f} per year)')


def load_daily(folder):
    """Daily rows. USE THE CLOSE COLUMN ONLY: since about 2011 the source's daily "close" is the
    price at the start of the day, and its high / low cover only part of the day after it. Open /
    high / low are not a normal bar: anything built on them either sees the future or misses
    part of the day. (Hourly bars are fine.)"""
    out = {}
    for sym in PAIRS:
        path = os.path.join(folder, f'{sym}_D1.csv')
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path)
        # Rows are stamped at midnight London time: 00:00 UTC in winter, 23:00 UTC the evening before
        # in summer (so Monday's row is stamped Sunday 23:00). Two hours later is the same calendar
        # day all year round.
        df['time'] = (pd.to_datetime(df['time'], unit='s', utc=True) + pd.Timedelta(hours=2)).dt.normalize()
        df = df.drop_duplicates('time', keep='last').set_index('time').sort_index()
        df = df[df.index.dayofweek < 5]
        # Yahoo's early FX data has occasional bad prints: drop daily moves above 15%.
        r = df['close'].pct_change().abs()
        df = df[(r < 0.15) | r.isna()]
        out[sym] = df[['open', 'high', 'low', 'close']].astype(float)
    return out


def atr(df, n=14):
    pc = df['close'].shift(1)
    tr = pd.concat([df['high'] - df['low'], (df['high'] - pc).abs(), (df['low'] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def summary(name, r, days=None):
    """One line on a list of per-trade R results."""
    r = np.asarray(r, dtype=float)
    n = len(r)
    if n == 0:
        return f'{name:<46} no trades'
    m = r.mean()
    se = r.std(ddof=1) / np.sqrt(n) if n > 1 else float('nan')
    per_day = f' · {n / days:5.2f}/day' if days else ''
    return f'{name:<46} {n:6d} trades{per_day} · mean {m:+.3f}R (±{se:.3f}) · t={m / se if se else 0:+.2f} · win {np.mean(r > 0) * 100:3.0f}% · total {r.sum():+8.1f}R'
