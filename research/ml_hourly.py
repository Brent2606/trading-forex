"""
A model that learns price action from the market instead of following fixed rules.

For every hour of every pair it describes the market in ~40 numbers (recent moves, position in
the recent range, trend, volatility, candle shapes, time of day, strength of both currencies) and
learns from history how often a trade from that situation reached its target before its stop.

Honest test: walk-forward. For each month the model is trained only on the months before it
(with a gap so no label leaks in), it picks its own entry threshold on the last part of that
training data, and then trades the month it has never seen. Costs: spread, commission, slippage.

Usage: python ml_hourly.py <hourly csv folder>
"""
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import PAIRS, atr, cost_pips, load_hourly, pip, summary

SL_ATR = 1.5   # stop distance in ATR(14)
TP_ATR = 1.5   # target distance in ATR(14)
HORIZON = 24   # bars a trade may stay open
MIN_TRAIN_MONTHS = 12
STEP_MONTHS = 2     # each model trades the next two months, then a new one is trained
THRESHOLDS = [0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65]
PARAMS = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=400, feature_fraction=0.7,
              bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=1, seed=7)
ROUNDS = 200


def features(sym, df, strength):
    c, h, l, o = df['close'], df['high'], df['low'], df['open']
    a = atr(df)
    f = pd.DataFrame(index=df.index)
    for k in [1, 2, 3, 6, 12, 24, 48, 120]:
        f[f'ret_{k}'] = (c - c.shift(k)) / a
    for n in [24, 120]:
        f[f'from_high_{n}'] = (c - h.rolling(n).max()) / a
        f[f'from_low_{n}'] = (c - l.rolling(n).min()) / a
    for n in [20, 50, 200]:
        e = c.ewm(span=n, adjust=False).mean()
        f[f'ema_dist_{n}'] = (c - e) / a
        if n < 200:
            f[f'ema_slope_{n}'] = (e - e.shift(5)) / a
    for n in [3, 14]:
        d = c.diff()
        up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
        dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
        f[f'rsi_{n}'] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    for n in [20, 50]:
        f[f'z_{n}'] = (c - c.rolling(n).mean()) / c.rolling(n).std()
    f['vol_ratio'] = a / a.rolling(250).mean()
    f['range_24'] = (h.rolling(24).max() - l.rolling(24).min()) / a
    for k in [0, 1]:
        oo, hh, ll, cc = o.shift(k), h.shift(k), l.shift(k), c.shift(k)
        f[f'body_{k}'] = (cc - oo) / a
        f[f'upper_wick_{k}'] = (hh - np.maximum(oo, cc)) / a
        f[f'lower_wick_{k}'] = (np.minimum(oo, cc) - ll) / a
    hour = df.index.hour
    f['hour_sin'] = np.sin(2 * np.pi * hour / 24)
    f['hour_cos'] = np.cos(2 * np.pi * hour / 24)
    f['dow'] = df.index.dayofweek
    base, quote = sym[:3], sym[3:]
    for k in [24, 120]:
        s = strength[k]
        f[f'strength_{k}'] = (s[base] - s[quote]).reindex(df.index)
    f['jpy'] = 1.0 if sym.endswith('JPY') else 0.0
    return f, a


def currency_strength(data):
    """Average move (in ATR) of each currency against the others, over k hours."""
    out = {}
    for k in [24, 120]:
        cols = {}
        for sym, df in data.items():
            cols[sym] = (df['close'] - df['close'].shift(k)) / atr(df)
        m = pd.DataFrame(cols)
        ccys = sorted({s[:3] for s in data} | {s[3:] for s in data})
        st = pd.DataFrame(index=m.index)
        for ccy in ccys:
            parts = [m[s] for s in m if s[:3] == ccy] + [-m[s] for s in m if s[3:] == ccy]
            st[ccy] = pd.concat(parts, axis=1).mean(axis=1)
        out[k] = st
    return out


def barrier_outcomes(sym, df, a):
    """For an entry at the next bar's open: result in R and exit bar, for a long and a short."""
    o, h, l, c = (df[x].to_numpy() for x in ['open', 'high', 'low', 'close'])
    av = a.to_numpy()
    n = len(df)
    cost = cost_pips(sym) * pip(sym)
    res = {}
    for side in (1, -1):
        r = np.full(n, np.nan)
        exit_i = np.full(n, -1)
        win = np.zeros(n)
        for i in range(n - HORIZON - 1):
            if not av[i] > 0:
                continue
            e = o[i + 1]
            sl = SL_ATR * av[i]
            tp = TP_ATR * av[i]
            out = None
            for j in range(i + 1, i + 1 + HORIZON):
                adverse = (e - l[j]) if side == 1 else (h[j] - e)
                favour = (h[j] - e) if side == 1 else (e - l[j])
                if adverse >= sl:  # stop first when both are touched in one bar
                    out = (-sl, j, 0)
                    break
                if favour >= tp:
                    out = (tp, j, 1)
                    break
            if out is None:
                j = i + HORIZON
                out = ((c[j] - e) * side, j, 0)
            pnl, j, w = out
            r[i] = (pnl - cost) / sl
            exit_i[i] = j
            win[i] = w
        res[side] = (r, exit_i, win)
    return res


def simulate(bar, pl, ps, rl, rs, xl, xs, thr):
    """One position at a time per pair; enters the side whose probability clears the threshold.
    `bar` is each row's bar number in the pair's history; xl / xs are the exit bar numbers."""
    out = []
    busy_until = -1
    for i in range(len(pl)):
        if bar[i] <= busy_until:
            continue
        go_l = pl[i] >= thr and not np.isnan(rl[i])
        go_s = ps[i] >= thr and not np.isnan(rs[i])
        if go_l and (not go_s or pl[i] >= ps[i]):
            out.append(rl[i])
            busy_until = xl[i]
        elif go_s:
            out.append(rs[i])
            busy_until = xs[i]
    return out


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
        bo = barrier_outcomes(sym, df, a)
        f['sym'] = sym
        f['i'] = np.arange(len(df))
        for side, name in ((1, 'l'), (-1, 's')):
            r, x, w = bo[side]
            f[f'r_{name}'] = r
            f[f'x_{name}'] = x
            f[f'w_{name}'] = w
        rows.append(f)
    allf = pd.concat(rows).dropna()
    feat_cols = [c for c in allf.columns if c not in ('sym', 'i', 'r_l', 'r_s', 'x_l', 'x_s', 'w_l', 'w_s')]
    allf = allf.sort_index()
    print(f'{len(allf)} samples, {len(feat_cols)} features, {allf.index.min():%Y-%m-%d} to {allf.index.max():%Y-%m-%d} ({time.time() - t0:.0f}s)', flush=True)

    months = pd.period_range(allf.index.min().tz_localize(None).to_period('M'), allf.index.max().tz_localize(None).to_period('M'), freq='M')
    test_months = months[MIN_TRAIN_MONTHS::STEP_MONTHS]
    results, base_all, chosen = [], [], []
    rng = np.random.default_rng(1)
    for m in test_months:
        start = m.start_time.tz_localize('UTC')
        end = (m + STEP_MONTHS).start_time.tz_localize('UTC')
        # Purge: the last HORIZON hours before the test month have labels that reach into it.
        train = allf[allf.index < start - pd.Timedelta(hours=HORIZON + 1)]
        test = allf[(allf.index >= start) & (allf.index < end)]
        if len(test) == 0:
            continue
        cut = train.index[int(len(train) * 0.8)]
        fit, val = train[train.index < cut - pd.Timedelta(hours=HORIZON + 1)], train[train.index >= cut]
        models = {}
        for name in ('l', 's'):
            models[name] = lgb.train(PARAMS, lgb.Dataset(fit[feat_cols], fit[f'w_{name}']), ROUNDS)
        # Pick the threshold on validation data only.
        best_thr, best_sum = None, 0.0
        vp = {n: models[n].predict(val[feat_cols]) for n in ('l', 's')}
        for thr in THRESHOLDS:
            tot = []
            for sym, g in val.assign(pl=vp['l'], ps=vp['s']).groupby('sym'):
                g = g.sort_values('i')
                tot += simulate(g['i'].to_numpy(), g['pl'].to_numpy(), g['ps'].to_numpy(), g['r_l'].to_numpy(), g['r_s'].to_numpy(),
                                g['x_l'].to_numpy(), g['x_s'].to_numpy(), thr)
            if len(tot) >= 100 and np.mean(tot) > 0 and np.sum(tot) > best_sum:
                best_thr, best_sum = thr, np.sum(tot)
        chosen.append(best_thr)
        if best_thr is None:
            print(f'{m}: no threshold profitable on validation -> no trades', flush=True)
            continue
        # Retrain on all training data, then trade the unseen month.
        for name in ('l', 's'):
            models[name] = lgb.train(PARAMS, lgb.Dataset(train[feat_cols], train[f'w_{name}']), ROUNDS)
        tp = {n: models[n].predict(test[feat_cols]) for n in ('l', 's')}
        month_r = []
        for sym, g in test.assign(pl=tp['l'], ps=tp['s']).groupby('sym'):
            g = g.sort_values('i')
            got = simulate(g['i'].to_numpy(), g['pl'].to_numpy(), g['ps'].to_numpy(), g['r_l'].to_numpy(), g['r_s'].to_numpy(),
                           g['x_l'].to_numpy(), g['x_s'].to_numpy(), best_thr)
            month_r += got
            # Baseline: the same number of random entries on random sides in that month.
            if got:
                pick = rng.choice(len(g), size=min(len(got), len(g)), replace=False)
                side = rng.integers(0, 2, size=len(pick))
                base_all += [g['r_l'].iloc[k] if s else g['r_s'].iloc[k] for k, s in zip(pick, side)]
        results.append((m, month_r))
        print(f'{m}: threshold {best_thr:.2f} · {len(month_r):4d} trades · mean {np.mean(month_r) if month_r else 0:+.3f}R ({time.time() - t0:.0f}s)', flush=True)

    allr = [x for _, rr in results for x in rr]
    days = sum(((m + STEP_MONTHS).start_time - m.start_time).days for m, _ in results) * 5 / 7
    print('\n=== OUT OF SAMPLE (each month traded by a model that never saw it)')
    print(summary('learning model', allr, days))
    print(summary('random entries, same number', base_all, days))
    by_year = {}
    for m, rr in results:
        by_year.setdefault(m.year, []).extend(rr)
    for y, rr in sorted(by_year.items()):
        print(summary(f'  {y}', rr))
    pos = sum(1 for _, rr in results if rr and np.sum(rr) > 0)
    print(f'periods in profit: {pos} of {sum(1 for _, rr in results if rr)} · thresholds chosen: {chosen}')


if __name__ == '__main__':
    main(sys.argv[1])
