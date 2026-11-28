"""
What would the currency model's own trades have earned at other costs?

The model's choice of side is worth about 0.055R a trade and a trade costs 0.073R (README,
"Does the model read direction"). The trades do not depend on commission or slippage (the model
learns "target before stop"), so the same book of trades can simply be re-priced:

    python whatif_costs.py <books folder> <spreads.json>

The books are written by fx_books.sh: one run per random seed (fx_flat_s7.csv and so on).
Scenarios, per round trip:
  A  as tested: the broker's spread, 7 dollars commission per lot, 0.3 pip slippage
  B  slippage 0.1 pip instead of 0.3 (0.3 was an assumption on the safe side, not a measurement)
  C  as B, with 4.50 dollars commission per lot (what the cheapest retail brokers charge)
  D  as B, without any commission (a look at the ceiling, not an offer anybody makes)

Besides all pairs, the same for the cheaper half of the pairs. "Cheaper" is decided on costs
alone: per pair the average of a trade and its opposite on the same bar, in which direction
cancels and only the cost is left.

Everything is shown per seed and for the average of the seeds, and for the years up to 2021 and
after. Nothing here is a new test of the model: it is the same result under other prices.
"""
import glob
import json
import os
import re
import sys

import numpy as np
import pandas as pd

SLIP_TESTED, SLIP_LOW = 0.3, 0.1
COMMISSION_TESTED, COMMISSION_LOW = 7.0, 4.5
SPLIT = 2021


def load(path):
    b = pd.read_csv(path)
    span = pd.to_datetime(b[b['kind'] == 'span']['day'])
    days = pd.bdate_range(span.min(), span.max())
    t = b[b['kind'] == 'model'].copy()
    t['day'] = pd.to_datetime(t['day'])
    # One R in pips for this trade (1.5 x the hourly ATR at entry).
    u = (t['pips'] / t['r']).where(t['r'].abs() > 1e-9)
    t['u'] = u.fillna(u.groupby(t['pair']).transform('median'))
    return t, days


def tval(x):
    sd = x.std(ddof=1)
    return float(x.mean() / (sd / np.sqrt(len(x)))) if sd > 0 else 0.0


def reprice(t, profile, scenario):
    """The result per trade, in R, under a scenario."""
    com = t['pair'].map(lambda p: profile[p]['commission_pips'])
    saved = {'A': 0.0,
             'B': SLIP_TESTED - SLIP_LOW,
             'C': SLIP_TESTED - SLIP_LOW + com * (1 - COMMISSION_LOW / COMMISSION_TESTED),
             'D': SLIP_TESTED - SLIP_LOW + com}[scenario]
    return t['r'] + saved / t['u']


def main(folder, spreads):
    with open(spreads) as f:
        profile = json.load(f)
    runs = {}
    for path in sorted(glob.glob(os.path.join(folder, '*.csv'))):
        m = re.match(r'(.+)_s(\d+)$', os.path.basename(path)[:-4])
        if m:
            runs[int(m.group(2))] = load(path)
    seeds = sorted(runs)
    days = runs[seeds[0]][1]
    print(f'{len(seeds)} runs (seeds {", ".join(map(str, seeds))}), {days[0]:%Y-%m} to {days[-1]:%Y-%m}, {len(days)} trading days')

    # Which pairs are cheap: the average of a trade and its opposite on the same bar (direction cancels).
    every = pd.concat([runs[s][0][runs[s][0]['bucket'] == 10] for s in seeds])
    two = every.dropna(subset=['other'])
    per_pair = pd.DataFrame({
        'trades': two.groupby('pair').size() / len(seeds),
        'cost': -((two['r'] + two['other']) / 2).groupby(two['pair']).mean(),
        'direction': ((two['r'] - two['other']) / 2).groupby(two['pair']).mean(),
        'net': every.groupby('pair')['r'].mean(),
        'R in pips': every.groupby('pair')['u'].median(),
    }).sort_values('cost')
    cheap = list(per_pair.index[per_pair['cost'] <= per_pair['cost'].median()])
    print('\nPer pair, most confident 10%, average of the seeds (sorted by what a trade costs):')
    print(f'{"pair":<8}{"trades":>8}{"1R in pips":>12}{"cost":>9}{"side worth":>12}{"result":>9}')
    for p, r in per_pair.iterrows():
        print(f'{p:<8}{r["trades"]:8.0f}{r["R in pips"]:12.1f}{r["cost"]:8.3f}R{r["direction"]:+11.3f}R{r["net"]:+8.3f}R' + ('   cheap half' if p in cheap else ''))
    print(f'cheap half (by cost alone): {" ".join(cheap)}')

    for label, pick in (('ALL PAIRS', None), ('THE CHEAPER HALF OF THE PAIRS', cheap)):
        print(f'\n===== {label}: result per trade in R after costs (per-day t on the average of the seeds) · years up to {SPLIT} / after')
        for bucket in (10, 5, 2, 1):
            print(f'most confident {bucket}%:')
            for sc, name in (('A', 'as tested'), ('B', 'slippage 0.1 pip'), ('C', 'and commission $4.50'), ('D', 'and no commission')):
                daily, means, early, late, counts = [], [], [], [], []
                for s in seeds:
                    t = runs[s][0]
                    t = t[t['bucket'] == bucket]
                    if pick is not None:
                        t = t[t['pair'].isin(pick)]
                    r = reprice(t, profile, sc)
                    daily.append(r.groupby(t['day']).sum().reindex(days, fill_value=0.0))
                    means.append(r.mean())
                    early.append(r[t['day'].dt.year <= SPLIT].mean())
                    late.append(r[t['day'].dt.year > SPLIT].mean())
                    counts.append(len(t))
                avg = pd.concat(daily, axis=1).mean(axis=1)
                print(f'  {sc} {name:<22}{np.mean(means):+.3f}R (t {tval(avg):+.2f}, Sharpe {avg.mean() / avg.std(ddof=1) * np.sqrt(252):+.2f}) · '
                      f'{np.mean(early):+.3f} / {np.mean(late):+.3f} · per seed ' + ' '.join(f'{m:+.3f}' for m in means) +
                      (f' · {np.mean(counts):.0f} trades a seed, {np.mean(counts) / len(days):.1f} a day' if sc == 'A' else ''))

    # Is the skill still there? What choosing the side was worth, year by year and hour by hour.
    two = two.assign(direction=(two['r'] - two['other']) / 2, cost=-(two['r'] + two['other']) / 2)
    print('\nMost confident 10%, per year: trades a seed, what choosing the side was worth, what a trade cost')
    g = two.groupby(two['day'].dt.year)
    print(' '.join(f'{int(y)}: {len(x) / len(seeds):.0f} {x["direction"].mean():+.3f} {x["cost"].mean():.3f} |' for y, x in g))
    print('Per entry hour (broker clock): trades a seed, side worth, cost')
    g = two.groupby('hour')
    print(' '.join(f'{int(h):02d}: {len(x) / len(seeds):.0f} {x["direction"].mean():+.3f} {x["cost"].mean():.3f} |' for h, x in g if len(x) >= 30 * len(seeds)))
    d = two['direction']
    daily_dir = d.groupby([two['day']]).sum() / len(seeds)
    print(f'All of it: choosing the side is worth {d.mean():+.3f}R a trade (per-day t {tval(daily_dir):+.2f}); a trade costs {two["cost"].mean():.3f}R')


if __name__ == '__main__':
    main(*sys.argv[1:3])
