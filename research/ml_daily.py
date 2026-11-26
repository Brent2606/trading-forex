"""
The learning model on daily prices, tested over many years it never saw.

Every day, for each of 16 pairs, the model describes the market in ~45 numbers and predicts the
move over the next 1 and 5 days. Walk-forward by calendar year: the model for year Y is trained
only on the years before Y (at least 5), so 2009-2026 is all unseen data.

Trading rule (fixed in advance): buy the 3 pairs with the highest predictions, sell the 3 with
the lowest, same risk each, hold for the horizon, then choose again. Costs: spread, commission,
slippage on every change, plus a 1%/yr financing mark-up.

Usage: python ml_daily.py <daily csv folder>
"""
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import PAIRS, cost_pips, fetch_daily, load_daily, pip

PARAMS = dict(objective='regression', learning_rate=0.03, num_leaves=15, min_data_in_leaf=300, feature_fraction=0.6,
              bagging_fraction=0.7, bagging_freq=1, lambda_l2=20.0, verbose=-1, num_threads=1)
ROUNDS = 250
SEEDS = [1, 2, 3]
HORIZONS = [1, 5]
TOP = 3
MIN_TRAIN_YEARS = 5
SWAP_MARKUP = 0.01
RISK_PER_LEG = 0.10 / np.sqrt(2 * TOP)   # so the six positions together aim at about 10% a year


def move(df, n=14):
    """Typical daily move (close to close): the unit every feature is measured in."""
    return df['close'].diff().abs().ewm(alpha=1 / n, adjust=False).mean()


def strength(data, k):
    m = pd.DataFrame({s: (d['close'] - d['close'].shift(k)) / move(d) for s, d in data.items()})
    ccys = sorted({s[:3] for s in data} | {s[3:] for s in data})
    st = pd.DataFrame(index=m.index)
    for c in ccys:
        st[c] = pd.concat([m[s] for s in m if s[:3] == c] + [-m[s] for s in m if s[3:] == c], axis=1).mean(axis=1)
    return st


def features(sym, df, st):
    """Close prices only. The source's daily high / low / open are NOT used: since about 2011 its
    "close" is the price at the start of the day while high and low cover the day after it, so any
    feature built on them sees the future (a first version of this script did, and "earned" 190%
    a year)."""
    c = df['close']
    d = c.diff()
    a = move(df)
    f = pd.DataFrame(index=df.index)
    for k in [1, 2, 3, 5, 10, 21, 63, 126, 252]:
        f[f'ret_{k}'] = (c - c.shift(k)) / (a * np.sqrt(k))
    for n in [20, 60, 252]:
        f[f'from_high_{n}'] = (c - c.rolling(n).max()) / a
        f[f'from_low_{n}'] = (c - c.rolling(n).min()) / a
        f[f'z_{n}'] = (c - c.rolling(n).mean()) / c.rolling(n).std()
    for n in [10, 50, 200]:
        e = c.ewm(span=n, adjust=False).mean()
        f[f'ema_dist_{n}'] = (c - e) / a
        f[f'ema_slope_{n}'] = (e - e.shift(5)) / a
    for n in [2, 14]:
        up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
        dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
        f[f'rsi_{n}'] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    f['vol_ratio'] = a / a.rolling(252).mean()
    f['vol_short'] = d.abs().rolling(5).mean() / a
    f['dow'] = df.index.dayofweek
    f['month'] = df.index.month
    base, quote = sym[:3], sym[3:]
    for k, s in st.items():
        f[f'strength_{k}'] = (s[base] - s[quote]).reindex(df.index)
        f[f'base_{k}'] = s[base].reindex(df.index)
        f[f'quote_{k}'] = s[quote].reindex(df.index)
    return f, a


def stats(name, r):
    r = pd.Series(r).dropna()
    years = len(r) / 252
    ann = r.mean() * 252
    vol = r.std() * np.sqrt(252)
    sh = ann / vol if vol > 0 else 0
    eq = (1 + r).cumprod()
    by_year = r.groupby(r.index.year).sum()
    return (f'{name:<40} {years:4.1f} yrs · {ann * 100:+5.1f}%/yr at {vol * 100:4.1f}% vol · Sharpe {sh:+.2f} (t={sh * np.sqrt(years):+.2f})'
            f' · worst drop {(eq / eq.cummax() - 1).min() * 100:5.1f}% · {int((by_year > 0).sum())}/{len(by_year)} years up')


def main(folder):
    t0 = time.time()
    fetch_daily(folder)
    data = load_daily(folder)
    st = {k: strength(data, k) for k in [5, 21, 63]}
    rows = []
    for sym in PAIRS:
        df = data[sym]
        f, a = features(sym, df, st)
        f['sym'] = sym
        f['atr_frac'] = a / df['close']
        f['cost_frac'] = cost_pips(sym) * pip(sym) / df['close']
        f['ret_next'] = df['close'].pct_change().shift(-1)   # tomorrow's close-to-close return
        f['ret_late'] = df['close'].pct_change().shift(-2)   # the day after: for entering one day late
        for h in HORIZONS:
            f[f'y_{h}'] = (df['close'].shift(-h) - df['close']) / (a * np.sqrt(h))
        rows.append(f)
    allf = pd.concat(rows)
    feat = [c for c in allf.columns if c not in ('sym', 'atr_frac', 'cost_frac', 'ret_next', 'ret_late') and not c.startswith('y_')]
    allf = allf.dropna(subset=feat).sort_index()
    years = sorted(set(allf.index.year))
    print(f'{len(allf)} samples, {len(feat)} features, {years[0]}-{years[-1]} ({time.time() - t0:.0f}s)', flush=True)

    for h in HORIZONS:
        preds = []
        for y in years[MIN_TRAIN_YEARS:]:
            start = pd.Timestamp(year=y, month=1, day=1, tz='UTC')
            train = allf[allf.index < start - pd.Timedelta(days=h * 2 + 3)].dropna(subset=[f'y_{h}'])
            test = allf[allf.index.year == y]
            if len(test) == 0 or len(train) < 5000:
                continue
            p = np.zeros(len(test))
            for seed in SEEDS:
                m = lgb.train({**PARAMS, 'seed': seed}, lgb.Dataset(train[feat], train[f'y_{h}'].clip(-4, 4)), ROUNDS)
                p += m.predict(test[feat]) / len(SEEDS)
            preds.append(test.assign(pred=p))
        P = pd.concat(preds)
        ic_year = P.dropna(subset=[f'y_{h}']).groupby(P.dropna(subset=[f'y_{h}']).index.year).apply(lambda g: g['pred'].corr(g[f'y_{h}'], method='spearman'))
        print(f'\n=== HORIZON {h} DAY(S) · unseen years {ic_year.index.min()}-{ic_year.index.max()} ({time.time() - t0:.0f}s)')
        print(f'IC per year: mean {ic_year.mean():+.3f} · positive in {int((ic_year > 0).sum())}/{len(ic_year)} years · ' + ' '.join(f'{v:+.2f}' for v in ic_year))
        if ic_year.abs().max() > 0.15:
            print('!!! SUSPICIOUS: no honest daily model ranks this well. Look for a feature that sees the future before believing anything below.')

        # Daily table of predictions; positions are chosen every h days and held.
        pred = P.pivot_table(index=P.index, columns='sym', values='pred')
        ret = P.pivot_table(index=P.index, columns='sym', values='ret_next')
        ret_late = P.pivot_table(index=P.index, columns='sym', values='ret_late')
        atrf = P.pivot_table(index=P.index, columns='sym', values='atr_frac')
        cost = P.pivot_table(index=P.index, columns='sym', values='cost_frac')
        rng = np.random.default_rng(3)
        for label, table in (('model', pred), ('random picks', None), ('model reversed', -pred)):
            w = pd.DataFrame(0.0, index=pred.index, columns=pred.columns)
            for i in range(0, len(pred), h):
                row = (table.iloc[i] if table is not None else pd.Series(rng.normal(size=pred.shape[1]), index=pred.columns)).where(pred.iloc[i].notna()).dropna()
                if len(row) < 2 * TOP + 2:
                    continue
                order = row.sort_values()
                # Same risk per leg: position size is inversely proportional to the pair's daily range.
                size = RISK_PER_LEG / (atrf.iloc[i] * np.sqrt(252))
                tgt = pd.Series(0.0, index=pred.columns)
                tgt[order.index[-TOP:]] = size[order.index[-TOP:]]
                tgt[order.index[:TOP]] = -size[order.index[:TOP]]
                w.iloc[i:i + h] = tgt.fillna(0).to_numpy()
            gross = (w * ret).sum(axis=1)
            costs = (w.diff().abs().fillna(w.abs()) * cost / 2).sum(axis=1) + w.abs().sum(axis=1) * SWAP_MARKUP / 252
            if label == 'model':
                print(stats('model, before costs', gross))
            print(stats(f'{label}, after all costs', gross - costs))
            if label == 'model':
                # If the edge is real it survives entering a day late; a timing artefact in the data does not.
                print(stats('model, entered a day late, after costs', (w * ret_late).sum(axis=1) - costs))
                net = gross - costs
                for a_, b_ in [(2009, 2012), (2013, 2016), (2017, 2020), (2021, 2023), (2024, 2026)]:
                    seg = net[(net.index.year >= a_) & (net.index.year <= b_)]
                    if len(seg) > 100:
                        print(stats(f'    {a_}-{b_}', seg))
                print(f'    trades per year: about {(w.diff().abs() > 1e-9).sum().sum() / (len(w) / 252):.0f} · average money in positions {w.abs().sum(axis=1).mean():.1f}x the account')
    print(f'\ndone in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main(sys.argv[1])
