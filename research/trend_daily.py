"""
Trend following on daily prices across 16 currency pairs, over ~20 years.

This is the one approach in this folder with decades of published evidence behind it
("time-series momentum"): go with the direction of the past 1, 3 and 12 months, size every
position so each pair carries the same risk, and hold. All settings are fixed in advance
(nothing is tuned to the data), so the whole history is an honest test.

Usage: python trend_daily.py <daily csv folder>
"""
import os
import sys

import numpy as np
import pandas as pd

from common import PAIRS, cost_pips, fetch_daily, load_daily, pip

LOOKBACKS = [21, 63, 252]   # about 1, 3 and 12 months of trading days
VOL_DAYS = 60
TARGET_VOL = 0.10           # yearly volatility the whole portfolio aims for
SWAP_MARKUP = 0.01          # broker's financing mark-up per year on the money in positions (a guess)


def run(data, lookbacks, pairs=None, rebalance=5):
    pairs = [p for p in (pairs or PAIRS) if p in data]
    close = pd.DataFrame({p: data[p]['close'] for p in pairs}).sort_index().ffill(limit=3)
    ret = close.pct_change()
    vol = ret.rolling(VOL_DAYS).std() * np.sqrt(252)
    sig = sum(np.sign(close / close.shift(k) - 1) for k in lookbacks) / len(lookbacks)
    # Same risk per pair; decided on yesterday's close, held today.
    raw = (sig / vol).replace([np.inf, -np.inf], np.nan)
    w = raw.div(raw.notna().sum(axis=1), axis=0) * TARGET_VOL
    # Rebalance once a week to keep trading costs down.
    w = w.iloc[::rebalance].reindex(w.index).ffill().shift(1)
    cost_frac = pd.Series({p: cost_pips(p) * pip(p) for p in pairs}) / close
    gross = (w * ret).sum(axis=1)
    costs = (w.diff().abs() * cost_frac / 2).sum(axis=1)   # half the round-trip cost per side
    swap = w.abs().sum(axis=1) * SWAP_MARKUP / 252
    valid = w.notna().sum(axis=1) >= max(3, len(pairs) // 3)
    return gross[valid], (gross - costs)[valid], (gross - costs - swap)[valid], w[valid]


def stats(name, r):
    r = r.dropna()
    years = len(r) / 252
    ann = r.mean() * 252
    vol = r.std() * np.sqrt(252)
    sharpe = ann / vol if vol > 0 else 0
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    by_year = r.groupby(r.index.year).sum()
    return (f'{name:<44} {years:4.1f} years · {ann * 100:+5.1f}%/yr at {vol * 100:4.1f}% vol · Sharpe {sharpe:+.2f} (t={sharpe * np.sqrt(years):+.2f})'
            f' · worst drop {dd * 100:5.1f}% · {int((by_year > 0).sum())}/{len(by_year)} years up')


def main(folder):
    if os.environ.get('NOFETCH') != '1':   # NOFETCH=1: the folder holds a broker's own data, leave it alone
        fetch_daily(folder)
    data = load_daily(folder)
    first = {p: f'{d.index.min():%Y}' for p, d in data.items()}
    per_year = min(len(d) / ((d.index.max() - d.index.min()).days / 365.25) for d in data.values())
    # Guard against the data source handing back weekly or monthly bars.
    if per_year < 200:
        raise SystemExit(f'Not daily data: only {per_year:.0f} bars per year for at least one pair')
    print(f'{len(data)} pairs, daily data from {min(first.values())} ({per_year:.0f}+ bars per year) · settings fixed in advance: lookbacks {LOOKBACKS} days, weekly rebalance')
    gross, net, net_swap, w = run(data, LOOKBACKS)
    print('\n=== ALL 16 PAIRS, 1+3+12 MONTH TREND')
    print(stats('before costs', gross))
    print(stats('after spread, commission and slippage', net))
    print(stats('also after a 1%/yr financing mark-up', net_swap))
    print(f'average money in positions: {w.abs().sum(axis=1).mean():.2f}x the account · trades per pair per year: about {(w.diff().abs() > 1e-9).sum().mean() / (len(w) / 252):.0f}')

    print('\n=== THE SAME, PER PERIOD (after costs and financing mark-up)')
    for a, b in [(2004, 2008), (2009, 2013), (2014, 2018), (2019, 2022), (2023, 2026)]:
        seg = net_swap[(net_swap.index.year >= a) & (net_swap.index.year <= b)]
        if len(seg) > 100:
            print(stats(f'  {a}-{b}', seg))

    print('\n=== IS IT ROBUST? EACH LOOKBACK ON ITS OWN (after costs and mark-up)')
    for k in [10, 21, 42, 63, 126, 252]:
        print(stats(f'  only the past {k} days', run(data, [k])[2]))

    print('\n=== MAJORS ONLY vs CROSSES ONLY (after costs and mark-up)')
    majors = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']
    print(stats('  7 majors', run(data, LOOKBACKS, majors)[2]))
    print(stats('  9 crosses', run(data, LOOKBACKS, [p for p in PAIRS if p not in majors])[2]))

    print('\n=== THE OPPOSITE IDEA: BUY WHAT FELL, SELL WHAT ROSE (after costs and mark-up)')
    for k in [5, 21]:
        g, n, ns, _ = run(data, [k])
        # Reversal is the same trade with the sign flipped: gross flips, costs stay.
        rev = -g - (g - ns)
        print(stats(f'  against the past {k} days', rev))


if __name__ == '__main__':
    main(sys.argv[1])
