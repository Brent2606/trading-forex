"""
Step 1 for the other markets: what does a round trip cost as a share of what the price moves in
an hour? On currencies that share is the wall every real effect ran into. Measured here per
market and per hour of the broker's clock, with today's costs, next to the same figure for the
currency pairs.

    python markets_costs.py <markets folder> [<currency folder>]

Each folder holds hourly/<NAME>_H1_real.csv and spreads.json (icm_import_markets.py, icm_import.py).
The cost of a round trip is what the tests charge: the spread on the hour, commission, slippage.
The hourly move is the average true range of the bars that open in that hour.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

from common import SLIP_PIPS, load_hourly, server_hours

HOURS = list(range(3, 21))      # the hours in which the tests may enter
PERIODS = [(2010, 2014), (2015, 2018), (2019, 2022), (2023, 2026)]


def measure(folder):
    with open(os.path.join(folder, 'spreads.json')) as f:
        profile = json.load(f)
    data = load_hourly(os.path.join(folder, 'hourly'))
    rows = []
    for sym, prof in profile.items():
        if sym not in data:
            continue
        df = data[sym]
        unit = prof.get('pip', 0.01 if sym.endswith('JPY') else 0.0001)
        at_open = prof.get('open_by_server_hour', prof['by_server_hour'])
        extra = prof.get('commission_pips', 0.7) + prof.get('slip_pips', SLIP_PIPS)
        pc = df['close'].shift(1)
        tr = pd.concat([df['high'] - df['low'], (df['high'] - pc).abs(), (df['low'] - pc).abs()], axis=1).max(axis=1) / unit
        srv = server_hours(df.index)
        recent = df.index >= df.index[-1] - pd.Timedelta(days=365)
        share, cost, move = {}, {}, {}
        for h in HOURS:
            if at_open[h] is None:
                continue
            m = tr[recent & (srv == h)]
            if len(m) < 50:
                continue
            cost[h] = at_open[h] + extra
            move[h] = float(m.mean())
            share[h] = cost[h] / move[h]
        if not share:
            continue
        best = min(share, key=share.get)
        per = []
        for a, b in PERIODS:
            sel = (df.index.year >= a) & (df.index.year <= b) & np.isin(srv, list(share))
            per.append(float(np.mean([cost[h] for h in share]) / tr[sel].mean()) if sel.sum() > 2000 else float('nan'))
        rows.append(dict(market=sym, group=prof.get('group', 'currency'), unit=unit,
                         spread=float(np.mean([at_open[h] for h in share])), extra=extra,
                         cost=float(np.mean(list(cost.values()))), move=float(np.mean(list(move.values()))),
                         share=float(np.median(list(share.values()))), best=best, best_share=share[best],
                         worst_share=max(share.values()), periods=per, price=float(df['close'].iloc[-1]),
                         by_hour={h: share[h] for h in share}))
    return rows


def show(title, rows):
    print(f'\n{title}')
    print(f'{"market":<9}{"spread":>8}{"other":>8}{"cost":>8}{"hourly":>9}{"cost as share of the hourly move":>36}')
    print(f'{"":<9}{"":>8}{"":>8}{"":>8}{"move":>9}{"median":>10}{"best hour":>14}{"worst":>8}   by period: ' + ' '.join(f'{a}-{str(b)[2:]}' for a, b in PERIODS))
    for r in rows:
        print(f'{r["market"]:<9}{r["spread"]:8.2f}{r["extra"]:8.2f}{r["cost"]:8.2f}{r["move"]:9.1f}{r["share"] * 100:9.1f}%'
              f'{r["best_share"] * 100:8.1f}% at {r["best"]:02d}{r["worst_share"] * 100:7.1f}%   ' +
              ' '.join(f'{p * 100:6.1f}%' if np.isfinite(p) else '      -' for p in r['periods']))
    print(f'{"median":<9}{"":>33}{np.median([r["share"] for r in rows]) * 100:9.1f}%')


def main(markets, currencies=None):
    rows = measure(markets)
    for group in ('index', 'metal', 'oil'):
        part = [r for r in rows if r['group'] == group]
        if part:
            show(f'{group.upper()} (spread, other costs, cost and hourly move in the market\'s own unit; hours 03:00-20:00, the last 12 months)', part)
    if currencies:
        fx = measure(currencies)
        show('CURRENCIES (in pips)', fx)
        print(f'\nIn short: a round trip costs {np.median([r["share"] for r in fx]) * 100:.0f}% of an hourly move on currencies (median of {len(fx)} pairs), '
              f'{np.median([r["share"] for r in rows]) * 100:.0f}% on the other markets (median of {len(rows)}).')
    print('\nPer hour of the broker\'s clock, cost as a share of that hour\'s move (%):')
    print(f'{"":<9}' + ''.join(f'{h:>5d}' for h in HOURS))
    for r in rows:
        print(f'{r["market"]:<9}' + ''.join(f'{r["by_hour"][h] * 100:5.0f}' if h in r['by_hour'] else '    -' for h in HOURS))
    print('\nThe stop of the model tests is 1.5 x the hourly ATR, so a share of 6% means a trade starts 0.04R behind.')


if __name__ == '__main__':
    main(*sys.argv[1:3])
