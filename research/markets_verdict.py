"""
The verdict on the learning model for gold, oil and stock indices, against the bar that was
written down before the data existed (README.md). Reads the trade books that ml_lab.py wrote
with BOOKS=<folder>: three seeds per setting, plus one stress run with doubled costs.

    python markets_verdict.py <books folder> [<split year, default 2021>]

A file is named <setting>_s<seed>.csv or <setting>_stress.csv. Per setting and confidence bucket:
  1. per-day t-value over all unseen years, on the average of the three seeds (at least 3);
  2. positive in both blocks of years, on that average;
  3. every seed positive in both blocks;
  4. sells do not lose, and the model beats the same sides entered at random times;
  5. not negative with doubled spreads and slippage.
"""
import glob
import os
import re
import sys

import numpy as np
import pandas as pd

BAR_T = 3.0


def load(path):
    b = pd.read_csv(path)
    span = pd.to_datetime(b[b['kind'] == 'span']['day'])
    days = pd.bdate_range(span.min(), span.max())
    return b[b['kind'] == 'model'].assign(day=lambda x: pd.to_datetime(x['day'])), b[b['kind'] == 'same'], days


def per_day(trades, days):
    return trades.groupby('day')['r'].sum().reindex(days, fill_value=0.0)


def model_all_frame(trades):
    return pd.concat(trades.values())


def tval(x):
    sd = x.std(ddof=1)
    return float(x.mean() / (sd / np.sqrt(len(x)))) if sd > 0 else 0.0


def main(folder, split=2021):
    split = int(split)
    runs = {}
    for path in sorted(glob.glob(os.path.join(folder, '*.csv'))):
        m = re.match(r'(.+)_(s\d+|stress)$', os.path.basename(path)[:-4])
        if m:
            runs.setdefault(m.group(1), {})[m.group(2)] = load(path)
    candidates = []
    for setting, got in runs.items():
        seeds = sorted(k for k in got if k != 'stress')
        print(f'\n##### {setting}: seeds {", ".join(s[1:] for s in seeds)}' + ('' if 'stress' in got else ' · NO STRESS RUN'))
        if not seeds:
            continue
        days = got[seeds[0]][2]
        early, late = days[days.year <= split], days[days.year > split]
        for bucket in (10, 5, 2, 1):
            daily = {s: per_day(got[s][0][got[s][0]['bucket'] == bucket], days) for s in seeds}
            mean_daily = pd.concat(daily.values(), axis=1).mean(axis=1)
            trades = {s: got[s][0][got[s][0]['bucket'] == bucket] for s in seeds}
            n = np.mean([len(t) for t in trades.values()])
            mean_r = np.mean([t['r'].mean() for t in trades.values()])
            t_all = tval(mean_daily)
            blocks = {s: (trades[s][trades[s]['day'].dt.year <= split]['r'].mean(), trades[s][trades[s]['day'].dt.year > split]['r'].mean()) for s in seeds}
            avg_early, avg_late = (np.mean([b[k] for b in blocks.values()]) for k in (0, 1))
            sells = np.mean([t[t['side'] == -1]['r'].mean() for t in trades.values()])
            buys = np.mean([t[t['side'] == 1]['r'].mean() for t in trades.values()])
            share_sells = np.mean([(t['side'] == -1).mean() for t in trades.values()])
            same = pd.concat([got[s][1][got[s][1]['bucket'] == bucket]['r'] for s in seeds])
            model_all = pd.concat([t['r'] for t in trades.values()])
            edge = model_all.mean() - same.mean()
            edge_t = edge / np.sqrt(model_all.var(ddof=1) / len(model_all) + same.var(ddof=1) / len(same)) if len(same) > 1 else float('nan')
            stress = got['stress'][0] if 'stress' in got else None
            stress_r = stress[stress['bucket'] == bucket]['r'].mean() if stress is not None else float('nan')
            checks = [t_all >= BAR_T,
                      avg_early > 0 and avg_late > 0,
                      len(seeds) >= 3 and all(b[0] > 0 and b[1] > 0 for b in blocks.values()),
                      sells >= 0 and edge > 0 and edge_t >= 2,
                      stress_r >= 0]
            print(f'top {bucket:>2}%: {n:7.0f} trades a seed · {mean_r:+.3f}R after costs · per-day t {t_all:+.2f} '
                  f'(Sharpe {mean_daily.mean() / mean_daily.std(ddof=1) * np.sqrt(252):+.2f}) · up to {split} {avg_early:+.3f}R, after {avg_late:+.3f}R')
            print('          per seed (up to / after): ' + ' · '.join(f'{s[1:]}: {b[0]:+.3f} / {b[1]:+.3f}' for s, b in blocks.items()) +
                  f' · buys {buys:+.3f}R, sells {sells:+.3f}R ({share_sells * 100:.0f}% sells)')
            if 'matched' in model_all_frame(trades).columns:
                d = model_all_frame(trades)
                dlt = d['r'] - d['matched']
                print(f'          against all entries in the same market, hour and side that year: {dlt.mean():+.3f}R (t {dlt.mean() / (dlt.std(ddof=1) / np.sqrt(len(dlt))):+.2f}); the rest of the gap to random entries is the choice of market and hour')
            print(f'          same sides at random {same.mean():+.3f}R, model minus that {edge:+.3f}R (t {edge_t:+.2f}) · doubled costs {stress_r:+.3f}R · '
                  f'checks 1-5: {" ".join("yes" if c else "NO" for c in checks)}' + ('  <== CANDIDATE' if all(checks) else ''))
            if all(checks):
                candidates.append(f'{setting}, top {bucket}%')
            elif t_all >= 2 and checks[1]:
                print('          a lead (t between 2 and 3), not a result')
    print('\nCells that clear the bar: ' + (', '.join(candidates) if candidates else 'none'))


if __name__ == '__main__':
    main(*sys.argv[1:3])
