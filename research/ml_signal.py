"""
Is there anything to predict in hourly FX at all, before costs?

Learns to predict the next 1, 4, 12 and 24 hours from the same ~35 descriptions of the market as
ml_hourly.py, on data the model never saw (expanding walk-forward, 4 folds), and reports:
  - IC: how well the predictions rank what really happened (0 = nothing, 0.02-0.05 = useful);
  - what you earn before costs by buying the 10% most bullish and selling the 10% most bearish
    predictions, in pips, next to what one trade costs.

Usage: python ml_signal.py <hourly csv folder>
"""
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import PAIRS, cost_pips, load_hourly, pip
from ml_hourly import currency_strength, features

PARAMS = dict(objective='regression', learning_rate=0.05, num_leaves=31, min_data_in_leaf=400, feature_fraction=0.7,
              bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=1, seed=7)
ROUNDS = 200
HORIZONS = [1, 4, 12, 24]


def main(folder):
    t0 = time.time()
    data = load_hourly(folder)
    strength = currency_strength(data)
    rows = []
    for sym in PAIRS:
        if sym not in data:
            continue
        df = data[sym]
        f, a = features(sym, df, strength)
        f['sym'] = sym
        f['pips_per_atr'] = a / pip(sym)
        f['cost'] = cost_pips(sym)
        for h in HORIZONS:
            # From the next bar's open to the close h bars later, in ATR.
            f[f'y_{h}'] = (df['close'].shift(-h) - df['open'].shift(-1)) / a
        rows.append(f)
    allf = pd.concat(rows).dropna().sort_index()
    feat = [c for c in allf.columns if c not in ('sym', 'pips_per_atr', 'cost') and not c.startswith('y_')]
    print(f'{len(allf)} samples, {len(feat)} features ({time.time() - t0:.0f}s)', flush=True)
    times = allf.index.unique().sort_values()
    edges = [times[int(len(times) * k / 5)] for k in range(1, 5)] + [times[-1] + pd.Timedelta(hours=1)]
    print(f"\n{'horizon':>8} {'IC':>7} {'IC per fold':>30} {'top-bottom 10%, pips':>22} {'cost, pips':>11} {'after costs':>12} {'trades':>8}")
    for h in HORIZONS:
        ics, gross, costs, n = [], [], [], 0
        for k in range(4):
            train = allf[allf.index < edges[k] - pd.Timedelta(hours=h + 1)]
            test = allf[(allf.index >= edges[k]) & (allf.index < edges[k + 1])]
            y = train[f'y_{h}'].clip(-5, 5)
            m = lgb.train(PARAMS, lgb.Dataset(train[feat], y), ROUNDS)
            p = m.predict(test[feat])
            ics.append(pd.Series(p).corr(pd.Series(test[f'y_{h}'].to_numpy()), method='spearman'))
            lo, hi = np.quantile(p, [0.1, 0.9])
            pips = test[f'y_{h}'].to_numpy() * test['pips_per_atr'].to_numpy()
            side = np.where(p >= hi, 1, np.where(p <= lo, -1, 0))
            sel = side != 0
            gross += list(pips[sel] * side[sel])
            costs += list(test['cost'].to_numpy()[sel])
            n += int(sel.sum())
        g = np.mean(gross)
        se = np.std(gross, ddof=1) / np.sqrt(len(gross))
        c = np.mean(costs)
        print(f"{h:>6}h {np.mean(ics):>+7.3f} {str([round(float(x), 3) for x in ics]):>30} {g:>+13.2f} (±{se:.2f}) {c:>11.2f} {g - c:>+12.2f} {n:>8}", flush=True)
    print(f'\ndone in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main(sys.argv[1])
