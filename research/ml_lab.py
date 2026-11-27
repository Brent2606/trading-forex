"""
One test bench for the learning model on several time scales.

The model describes the market in numbers (recent moves, position in the recent range, trend,
volatility, candle shapes, time, strength of both currencies and, optionally, the longer-term
picture: trend over weeks, distance to the highs and lows of the past months, how "trendy" the
market has been) and learns how often a trade from that situation reached its target before
its stop.

It is judged the same way every time, on data it never saw (walk-forward):
  - no hand-picked entry threshold: it simply trades its most confident 10%, 5%, 2% and 1%
    of situations. If the model has real skill, more confidence must give a better result;
  - next to every result: the same number of trades entered at random;
  - costs: spread, commission, slippage, and financing for every day a trade stays open.

Settings come from the environment:
  TF=H1|H4|D1   SL_ATR, TP_ATR (in ATR of that time scale)   HORIZON (bars a trade may last)
  (D1 uses daily closes only: one decision a day, 20 years of history; its "ATR" is the typical
   close-to-close move, about two thirds of a real daily range)
  HTF=1 to add the longer-term picture   PAIRSET=all|majors   LABEL=name for the report
  DAILY_OHLC=1 reads the broker's own daily bars (icm_import.py) instead of closes only
  SPREADS=spreads.json uses the broker's measured spread per hour and fills at bid / ask
  STEP_MONTHS, MIN_TRAIN_MONTHS, TRAIN_MONTHS set the walk-forward (for long histories)
  SKIP_HOURS=23,0,1 allows no entries in those hours of the broker's clock (the daily rollover)
  FLAT_HOUR=23 closes every trade when that broker hour starts (nothing open during the rollover)
  SPREAD_MULT=2, EXTRA_COST_PIPS=0.5: stress tests on costs

Usage: python ml_lab.py <hourly csv folder> <daily csv folder>
"""
import os
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import COMMISSION_PIPS, PAIRS, SLIP_PIPS, SPREAD_PROFILE, atr, cost_pips, load_daily, load_hourly, pip

TF = os.environ.get('TF', 'H1')
SL_ATR = float(os.environ.get('SL_ATR', 1.5))
TP_ATR = float(os.environ.get('TP_ATR', 1.5))
HORIZON = int(os.environ.get('HORIZON', {'H1': 24, 'H4': 30, 'D1': 10}[TF]))
HTF = os.environ.get('HTF', '0') == '1'
PAIRSET = os.environ.get('PAIRSET', 'all')
LABEL = os.environ.get('LABEL', f'{TF} 1:{TP_ATR / SL_ATR:g}')
BARS_PER_DAY = {'H1': 24, 'H4': 6, 'D1': 1}[TF]
STEP_MONTHS = int(os.environ.get('STEP_MONTHS', {'H1': 2, 'H4': 2, 'D1': 12}[TF]))
MIN_TRAIN_MONTHS = int(os.environ.get('MIN_TRAIN_MONTHS', {'H1': 12, 'H4': 12, 'D1': 60}[TF]))
# No entries in these hours of the broker's clock (e.g. "23,0,1": around the daily rollover).
SKIP_HOURS = {int(x) for x in os.environ.get('SKIP_HOURS', '').split(',') if x.strip()}
# Close every trade when the bar of this broker hour opens (23 = an hour before the daily rollover),
# so nothing is ever open while spreads are wide. Empty = trades may run through the night.
FLAT_HOUR = int(os.environ['FLAT_HOUR']) if os.environ.get('FLAT_HOUR', '') != '' else None
# Stress test: multiply the measured spreads, and add extra cost in pips to every trade.
SPREAD_MULT = float(os.environ.get('SPREAD_MULT', 1))
EXTRA_COST_PIPS = float(os.environ.get('EXTRA_COST_PIPS', 0))
# Train on the last TRAIN_MONTHS only (0 = on everything before the test period).
TRAIN_MONTHS = int(os.environ.get('TRAIN_MONTHS', 0))
MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']
QUANTILES = [0.90, 0.95, 0.98, 0.99]
# Real daily bars (the broker's own, DAILY_OHLC=1) or, from the free source, daily closes only.
DAILY_OHLC = os.environ.get('DAILY_OHLC', '0') == '1'
CLOSE_ONLY = TF == 'D1' and not DAILY_OHLC   # closes only: decisions and exits once a day, on the close
SWAP_PER_YEAR = 0.01
PARAMS = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=400 if TF != 'D1' else 150,
              feature_fraction=0.7, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=1, seed=7)
ROUNDS = 200


def daily_bars(folder):
    """Daily bars made from closing prices only (20 years).

    The source's daily open / high / low cannot be trusted (its "close" is the price at the start
    of the day, and its high and low cover only part of the day after). The series of closes is
    sound, so a bar here is simply yesterday's close to today's close. A stop or target therefore
    only "triggers" on a daily close: this models a bot that looks once a day and gets out at the
    price it then sees, which can be worse than the stop."""
    out = {}
    for sym, d in load_daily(folder).items():
        c = d['close']
        o = c.shift(1)
        out[sym] = pd.DataFrame({'open': o, 'high': np.maximum(o, c), 'low': np.minimum(o, c), 'close': c}).dropna()
    return out


def broker_daily(folder):
    """The broker's daily bars (icm_import.py): a full bar per trading day, ending at the New York close."""
    out = {}
    for sym in PAIRS:
        path = os.path.join(folder, f'{sym}_D1.csv')
        if os.path.exists(path):
            d = pd.read_csv(path)
            d.index = pd.to_datetime(d['time'], unit='s', utc=True)
            out[sym] = d[['open', 'high', 'low', 'close']].astype(float)
    return out


def load(hourly_folder, daily_folder):
    if TF == 'D1':
        return broker_daily(daily_folder) if DAILY_OHLC else daily_bars(daily_folder)
    data = load_hourly(hourly_folder)
    if TF == 'H1':
        return data
    out = {}
    for sym, d in data.items():
        g = d.resample('4h')
        b = pd.DataFrame({'open': g['open'].first(), 'high': g['high'].max(), 'low': g['low'].min(), 'close': g['close'].last()}).dropna()
        out[sym] = b
    return out


def currency_strength(data, windows):
    out = {}
    for k in windows:
        m = pd.DataFrame({s: (d['close'] - d['close'].shift(k)) / (atr(d) * np.sqrt(k)) for s, d in data.items()})
        ccys = sorted({s[:3] for s in data} | {s[3:] for s in data})
        st = pd.DataFrame(index=m.index)
        for c in ccys:
            st[c] = pd.concat([m[s] for s in m if s[:3] == c] + [-m[s] for s in m if s[3:] == c], axis=1).mean(axis=1)
        out[k] = st
    return out


def features(sym, df, strength):
    c, h, l, o = df['close'], df['high'], df['low'], df['open']
    a = atr(df)
    d = BARS_PER_DAY
    f = pd.DataFrame(index=df.index)
    # --- the recent picture
    for k in sorted({1, 2, 3, 6, 12, d, 2 * d, 5 * d}):
        f[f'ret_{k}'] = (c - c.shift(k)) / (a * np.sqrt(k))
    for n in sorted({max(d, 12), 5 * d}):
        f[f'from_high_{n}'] = (c - h.rolling(n).max()) / a
        f[f'from_low_{n}'] = (c - l.rolling(n).min()) / a
    for n in [20, 50, 200]:
        e = c.ewm(span=n, adjust=False).mean()
        f[f'ema_dist_{n}'] = (c - e) / a
        if n < 200:
            f[f'ema_slope_{n}'] = (e - e.shift(5)) / a
    for n in [3, 14]:
        df_ = c.diff()
        up = df_.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
        dn = (-df_.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
        f[f'rsi_{n}'] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    for n in [20, 50]:
        f[f'z_{n}'] = (c - c.rolling(n).mean()) / c.rolling(n).std()
    f['vol_ratio'] = a / a.rolling(250).mean()
    for k in [0, 1]:
        oo, hh, ll, cc = o.shift(k), h.shift(k), l.shift(k), c.shift(k)
        f[f'body_{k}'] = (cc - oo) / a
        f[f'upper_wick_{k}'] = (hh - np.maximum(oo, cc)) / a
        f[f'lower_wick_{k}'] = (np.minimum(oo, cc) - ll) / a
    if TF != 'D1':
        hour = df.index.hour
        f['hour_sin'] = np.sin(2 * np.pi * hour / 24)
        f['hour_cos'] = np.cos(2 * np.pi * hour / 24)
    f['dow'] = df.index.dayofweek
    base, quote = sym[:3], sym[3:]
    for k, s in strength.items():
        f[f'strength_{k}'] = (s[base] - s[quote]).reindex(df.index)
    f['jpy'] = 1.0 if sym.endswith('JPY') else 0.0
    # --- the longer-term picture: weeks to months
    if HTF:
        for days in ([10, 20, 50] if TF != 'D1' else [50, 100, 250]):
            n = days * d
            f[f'lt_ret_{days}d'] = (c - c.shift(n)) / (a * np.sqrt(n))
            f[f'lt_from_high_{days}d'] = (c - h.rolling(n).max()) / (a * np.sqrt(n))
            f[f'lt_from_low_{days}d'] = (c - l.rolling(n).min()) / (a * np.sqrt(n))
            # How "trendy" the period was: 1 = a straight line, 0 = pure back and forth.
            f[f'lt_trendiness_{days}d'] = (c - c.shift(n)).abs() / c.diff().abs().rolling(n).sum()
            e = c.ewm(span=n, adjust=False).mean()
            f[f'lt_ema_dist_{days}d'] = (c - e) / (a * np.sqrt(n))
            f[f'lt_ema_slope_{days}d'] = (e - e.shift(max(1, n // 10))) / a
        f['lt_vol_regime'] = a / atr(df, 14 * max(d, 5)).rolling(20 * d).mean()
    return f, a


def server_hours(index):
    """Hour on the broker's clock (New York + 7 h) for each bar."""
    return (index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)).hour.to_numpy()


def spread_arrays(sym, df):
    """Per bar, in price: the broker's spread at the bar's open and its typical spread while the bar forms.

    The profile is kept per hour of the broker's clock (New York + 7 h), because the big effect, the
    widening around the daily rollover, follows New York time."""
    prof = SPREAD_PROFILE[sym]
    typical = prof['tick_weighted'] * SPREAD_MULT
    p = np.array([typical if v is None else v * SPREAD_MULT for v in prof['by_server_hour']]) * pip(sym)
    if TF == 'D1':
        # A daily bar opens at the rollover, when spreads are several pips wide for a few minutes.
        # Assumed: the bot waits an hour and gets in near the same price at that hour's spread.
        return np.full(len(df), p[1]), np.full(len(df), typical * pip(sym))
    srv = server_hours(df.index)
    span = 1 if TF == 'H1' else 4
    return p[srv], np.mean([p[(srv + k) % 24] for k in range(span)], axis=0)


def barrier_outcomes(sym, df, a):
    """Entry at the next bar's open; result in R after costs, exit bar, and whether the target was hit.

    With the broker's spread profile (SPREADS) the bars are bid prices and a trade is filled as at a
    broker: a buy opens at the ask and closes at the bid, a sell opens at the bid and closes at the
    ask, so a wide spread can also knock a short out at its stop. Commission and slippage come on top.
    Without a profile, one flat round-trip cost per pair is taken off."""
    o, h, l, c = (df[x].to_numpy() for x in ['open', 'high', 'low', 'close'])
    av = a.to_numpy()
    n = len(df)
    if SPREAD_PROFILE:
        sp_open, sp_bar = spread_arrays(sym, df)
        cost = (SPREAD_PROFILE[sym].get('commission_pips', COMMISSION_PIPS) + SLIP_PIPS) * pip(sym)
    else:
        sp_open = sp_bar = np.zeros(n)
        cost = cost_pips(sym) * pip(sym)
    cost += EXTRA_COST_PIPS * pip(sym)
    srv = server_hours(df.index) if (SKIP_HOURS or FLAT_HOUR is not None) and TF != 'D1' else None
    res = {}
    for side in (1, -1):
        r = np.full(n, np.nan)
        exit_i = np.full(n, -1)
        win = np.zeros(n)
        # Prices at which this side gets out: a long sells at the bid, a short buys at the ask.
        hi, lo, cl = (h, l, c) if side == 1 else (h + sp_bar, l + sp_bar, c + sp_bar)
        for i in range(n - HORIZON - 1):
            if not av[i] > 0:
                continue
            if srv is not None and SKIP_HOURS and srv[i + 1] in SKIP_HOURS:  # no entry on a bar that opens in a skipped hour
                continue
            e = o[i + 1] + (sp_open[i + 1] if side == 1 else 0.0)
            sl = SL_ATR * av[i]
            tp = TP_ATR * av[i]
            out = None
            for j in range(i + 1, i + 1 + HORIZON):
                if srv is not None and FLAT_HOUR is not None and j > i + 1 and srv[j] == FLAT_HOUR:
                    # Flat before the rollover: out at this bar's open, a long at the bid, a short at the ask.
                    px = o[j] + (0.0 if side == 1 else sp_bar[j - 1])
                    out = ((px - e) * side, j - 1, 0)
                    break
                adverse = (e - lo[j]) if side == 1 else (hi[j] - e)
                favour = (hi[j] - e) if side == 1 else (e - lo[j])
                if adverse >= sl:  # the stop counts first when both are touched in one bar
                    # Daily closes: the exit is the close that crossed the stop, not the stop itself.
                    out = ((cl[j] - e) * side if CLOSE_ONLY else -sl, j, 0)
                    break
                if favour >= tp:
                    out = ((cl[j] - e) * side if CLOSE_ONLY else tp, j, 1)
                    break
            if out is None:
                j = i + HORIZON
                out = ((cl[j] - e) * side, j, 0)
            pnl, j, w = out
            financing = e * SWAP_PER_YEAR / 365 * (j - i) / BARS_PER_DAY
            r[i] = (pnl - cost - financing) / sl
            exit_i[i] = j
            win[i] = w
        res[side] = (r, exit_i, win)
    return res


def simulate(bar, pl, ps, rl, rs, xl, xs, thr):
    """One position at a time per pair; takes the side whose probability clears the threshold.
    Returns (result in R, position in the arrays, side) per trade."""
    out = []
    busy_until = -1
    for i in range(len(pl)):
        if bar[i] <= busy_until:
            continue
        go_l = pl[i] >= thr and not np.isnan(rl[i])
        go_s = ps[i] >= thr and not np.isnan(rs[i])
        if go_l and (not go_s or pl[i] >= ps[i]):
            out.append((rl[i], i, 1))
            busy_until = xl[i]
        elif go_s:
            out.append((rs[i], i, -1))
            busy_until = xs[i]
    return out


def random_trades(rng, bar, rl, rs, xl, xs, count):
    """The same number of non-overlapping trades, entered at random bars on random sides."""
    out = []
    busy_until = -1
    order = np.sort(rng.choice(len(bar), size=min(len(bar), count * 6), replace=False)) if count else []
    for i in order:
        if len(out) >= count:
            break
        if bar[i] <= busy_until:
            continue
        long = rng.random() < 0.5
        r = rl[i] if long else rs[i]
        if np.isnan(r):
            continue
        out.append(r)
        busy_until = xl[i] if long else xs[i]
    return out


def line(name, r, days, rnd=None):
    r = np.asarray(r, dtype=float)
    n = len(r)
    if n < 2:
        return f'{name:<10} {n:6d} trades'
    m = r.mean()
    se = r.std(ddof=1) / np.sqrt(n)
    s = f'{name:<10} {n:6d} trades · {n / days:5.2f}/day · mean {m:+.3f}R (±{se:.3f}) · t={m / se:+.2f} · win {np.mean(r > 0) * 100:3.0f}%'
    if rnd is not None and len(rnd) > 1:
        rm = np.mean(rnd)
        rse = np.std(rnd, ddof=1) / np.sqrt(len(rnd))
        s += f' | random {rm:+.3f}R · model minus random {m - rm:+.3f}R (t={(m - rm) / np.sqrt(se ** 2 + rse ** 2):+.2f})'
    return s


def main(hourly_folder, daily_folder):
    t0 = time.time()
    data = load(hourly_folder, daily_folder)
    pairs = [p for p in (MAJORS if PAIRSET == 'majors' else PAIRS) if p in data]
    d = BARS_PER_DAY
    strength = currency_strength(data, sorted({d, 5 * d} | ({20 * d} if HTF else set())))
    rows = []
    for sym in pairs:
        df = data[sym]
        f, a = features(sym, df, strength)
        if len(df) > 50_000:  # long histories: halve the memory
            f = f.astype('float32')
        bo = barrier_outcomes(sym, df, a)
        f['sym'] = sym
        f['i'] = np.arange(len(df))
        for side, name in ((1, 'l'), (-1, 's')):
            r, x, w = bo[side]
            f[f'r_{name}'], f[f'x_{name}'], f[f'w_{name}'] = r, x, w
        rows.append(f)
    allf = pd.concat(rows).dropna().sort_index()
    meta = ('sym', 'i', 'r_l', 'r_s', 'x_l', 'x_s', 'w_l', 'w_s')
    feat = [c for c in allf.columns if c not in meta]
    print(f'##### {LABEL}: {TF} bars, stop {SL_ATR}×ATR, target {TP_ATR}×ATR (1:{TP_ATR / SL_ATR:g}), at most {HORIZON} bars, '
          f'{"with" if HTF else "without"} the longer-term picture, {len(pairs)} pairs, '
          f'{"broker spread per hour, bid/ask fills" if SPREAD_PROFILE else "flat cost per pair"}'
          + (f', trained on the last {TRAIN_MONTHS} months' if TRAIN_MONTHS else '')
          + (f', no entries in broker hours {sorted(SKIP_HOURS)}' if SKIP_HOURS else '')
          + (f', flat at broker hour {FLAT_HOUR}' if FLAT_HOUR is not None else '')
          + (f', spreads ×{SPREAD_MULT:g}' if SPREAD_MULT != 1 else '') + (f', +{EXTRA_COST_PIPS:g} pips cost' if EXTRA_COST_PIPS else ''))
    print(f'{len(allf)} samples, {len(feat)} features, {allf.index.min():%Y-%m-%d} to {allf.index.max():%Y-%m-%d} · '
          f'a trade wins {allf[["w_l", "w_s"]].to_numpy().mean() * 100:.0f}% of the time by chance ({time.time() - t0:.0f}s)', flush=True)

    months = pd.period_range(allf.index.min().tz_localize(None).to_period('M'), allf.index.max().tz_localize(None).to_period('M'), freq='M')
    # Purge gap between training and test: the longest a trade can last, weekends included.
    gap = pd.Timedelta(hours=(HORIZON + 1) * 24 / d * 1.5 + 72)
    res = {q: {} for q in QUANTILES}
    rnd = {q: [] for q in QUANTILES}
    book = {q: [] for q in QUANTILES}
    rng = np.random.default_rng(1)
    days = 0
    for m in months[MIN_TRAIN_MONTHS::STEP_MONTHS]:
        start = m.start_time.tz_localize('UTC')
        end = (m + STEP_MONTHS).start_time.tz_localize('UTC')
        train = allf[allf.index < start - gap]
        if TRAIN_MONTHS:
            train = train[train.index >= start - pd.DateOffset(months=TRAIN_MONTHS)]
        test = allf[(allf.index >= start) & (allf.index < end)]
        if len(test) < 50 or len(train) < 5000:
            continue
        days += (min(end, allf.index.max()) - start).days * 5 / 7
        cut = train.index[int(len(train) * 0.8)]
        fit, val = train[train.index < cut - gap], train[train.index >= cut]
        # Confidence levels are set on validation data only: "the model's top 5%" there.
        conf_val = np.maximum(*(lgb.train(PARAMS, lgb.Dataset(fit[feat], fit[f'w_{n}']), ROUNDS).predict(val[feat]) for n in ('l', 's')))
        thr = {q: float(np.quantile(conf_val, q)) for q in QUANTILES}
        tp = {n: lgb.train(PARAMS, lgb.Dataset(train[feat], train[f'w_{n}']), ROUNDS).predict(test[feat]) for n in ('l', 's')}
        test = test.assign(pl=tp['l'], ps=tp['s'])
        for q in QUANTILES:
            got = []
            for sym, g in test.groupby('sym'):
                g = g.sort_values('i')
                args = (g['i'].to_numpy(), g['r_l'].to_numpy(), g['r_s'].to_numpy(), g['x_l'].to_numpy(), g['x_s'].to_numpy())
                mine = simulate(args[0], g['pl'].to_numpy(), g['ps'].to_numpy(), args[1], args[2], args[3], args[4], thr[q])
                got += [t[0] for t in mine]
                rnd[q] += random_trades(rng, *args, len(mine))
                # Where and when the model traded: entry hour on the broker's clock, side, pair.
                hrs = server_hours(g.index + pd.Timedelta(hours=24 // BARS_PER_DAY)) if TF != 'D1' else np.zeros(len(g), dtype=int)
                book[q] += [(sym, int(hrs[k]), side, rr, g.index[k].date()) for rr, k, side in mine]
            res[q][str(m)] = got
        print(f'  {m}: ' + ' · '.join(f'top {100 - q * 100:.0f}% {len(res[q][str(m)]):4d} tr {np.mean(res[q][str(m)]) if res[q][str(m)] else 0:+.3f}R' for q in QUANTILES) + f' ({time.time() - t0:.0f}s)', flush=True)

    print(f'\n=== {LABEL} · UNSEEN DATA, {days:.0f} trading days · the model trades its most confident situations')
    for q in QUANTILES:
        allr = [x for rr in res[q].values() for x in rr]
        traded = [rr for rr in res[q].values() if len(rr) >= 5]
        pos = sum(1 for rr in traded if np.sum(rr) > 0)
        # Trades on the same day move together, so the honest yardstick is the result per day.
        per_day = pd.DataFrame(book[q], columns=['pair', 'hour', 'side', 'r', 'day']).groupby('day')['r'].sum()
        by_day = f' · per day t={per_day.mean() / (per_day.std(ddof=1) / np.sqrt(len(per_day))):+.2f}' if len(per_day) > 2 else ''
        print(line(f'top {100 - q * 100:.0f}%', allr, days, rnd[q]) + by_day + f' · periods up {pos}/{len(traded)} · 10,000 at 1% risk: {np.sum(allr) * 100:+,.0f}')
    # Where the result comes from. An edge that sits in one hour, one side or one pair is suspect.
    for q in (0.95, 0.99):
        b = pd.DataFrame(book[q], columns=['pair', 'hour', 'side', 'r', 'day'])
        if len(b) < 50:
            continue
        print(f'\n--- top {100 - q * 100:.0f}%: where the result comes from (trades, mean R)')
        for col, name in (('hour', 'entry hour, broker clock'), ('side', 'side (1 buy, -1 sell)'), ('pair', 'pair')):
            g = b.groupby(col)['r'].agg(['count', 'mean'])
            print(f'{name}: ' + ' · '.join(f'{k} {int(v["count"])} {v["mean"]:+.2f}' for k, v in g.iterrows()))
        quiet = b[~b['hour'].isin([23, 0, 1])]
        if TF != 'D1' and len(quiet) > 1:
            print(f'without entries in hours 23, 0, 1: {len(quiet)} trades, mean {quiet["r"].mean():+.3f}R '
                  f'(±{quiet["r"].std(ddof=1) / np.sqrt(len(quiet)):.3f})')
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
