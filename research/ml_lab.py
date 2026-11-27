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
  EXIT=time holds a trade HORIZON bars and closes it (no stop or target), within one broker day
  CLOCK=1 adds the pair's own habit at this hour of the day; SPLIT_YEAR=2021 reports two blocks
  MARKETS=1 for gold, oil and stock indices (icm_import_markets.py): every market in the folder with
  at least six years of bars; day-trader features and the move against the market's group instead of
  currency strength; no entry where the spread on the hour is unknown, on the first bar after a break
  or on the day's last bar; a stop that is jumped over is filled at the bar's open; with FLAT_HOUR a
  trade is also closed at the open of the day's last bar; and a second yardstick next to random
  entries: the same sides at random times (a market that only goes up flatters every buyer), and
  the average of all entries in the same market, hour and side that year (what is left after that
  is direction; a model can also beat random entries merely by picking the cheap hours)
  BOOKS=folder writes every trade of the run to <folder>/<LABEL>.csv (markets_verdict.py reads them)
  MATCHED=1 prints that same-market-hour-and-side yardstick for currency pairs too

Usage: python ml_lab.py <hourly csv folder> <daily csv folder>
"""
import os
import sys
import time

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import (COMMISSION_PIPS, GROUP, HOME, PAIRS, SLIP_PIPS, SPREAD_PROFILE, atr, cost_pips, hour_profiles, load_daily,
                    load_hourly, pip, server_days, server_hours)

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
# EXIT=time: no stop or target; hold HORIZON bars and get out, always within the same broker day and
# away from the rollover hours. "Win" then simply means: money made after costs.
EXIT = os.environ.get('EXIT', 'barrier')
# CLOCK=1 adds what the clock tests showed to be real: the pair's own habit at this hour and the broker hour.
CLOCK = os.environ.get('CLOCK', '0') == '1'
# SPLIT_YEAR=2021 reports the unseen years up to and after that year apart: choose on the first, judge on the second.
SPLIT_YEAR = int(os.environ.get('SPLIT_YEAR', 0))
# MARKETS=1: gold, oil and stock indices instead of currency pairs (see the top of this file).
MARKETS = os.environ.get('MARKETS', '0') == '1'
MIN_YEARS = float(os.environ.get('MIN_YEARS', 6))
BOOKS = os.environ.get('BOOKS', '')
MATCHED = MARKETS or os.environ.get('MATCHED', '0') == '1'
# Train on the last TRAIN_MONTHS only (0 = on everything before the test period).
TRAIN_MONTHS = int(os.environ.get('TRAIN_MONTHS', 0))
MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']
QUANTILES = [0.90, 0.95, 0.98, 0.99]
BOOK = ['pair', 'hour', 'side', 'r', 'day', 'pips']
if MATCHED:
    # 'matched': the average result of every entry in the same market, hour and side that year;
    # 'other': the result of the opposite trade entered on the very same bar.
    BOOK = BOOK + ['matched', 'other']
# Real daily bars (the broker's own, DAILY_OHLC=1) or, from the free source, daily closes only.
DAILY_OHLC = os.environ.get('DAILY_OHLC', '0') == '1'
CLOSE_ONLY = TF == 'D1' and not DAILY_OHLC   # closes only: decisions and exits once a day, on the close
SWAP_PER_YEAR = 0.01
PARAMS = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=400 if TF != 'D1' else 150,
              feature_fraction=0.7, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, num_threads=1, seed=int(os.environ.get('SEED', 7)))
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


def group_strength(data, windows):
    """Other markets: per window, each market's move against the average move of its group (indices,
    metals, oil), and that average itself."""
    out = {}
    for k in windows:
        m = pd.DataFrame({s: (d['close'] - d['close'].shift(k)) / (atr(d) * np.sqrt(k)) for s, d in data.items()})
        g = pd.DataFrame({s: m[[x for x in m if GROUP[x] == GROUP[s]]].mean(axis=1) for s in m})
        out[k] = (m - g, g)
    return out


def session_features(sym, df, a):
    """What a day trader looks at: the move since yesterday's close, since today's open and since the home
    session opened, where the price sits in today's range and how far into the day it is. Everything is
    known at the close of the bar it stands on."""
    o, h, l, c = df['open'], df['high'], df['low'], df['close']
    srv = server_hours(df.index)
    day = pd.factorize(server_days(df.index))[0]
    f = pd.DataFrame(index=df.index)
    f['since_close'] = (c - c.groupby(day).last().shift(1).reindex(day).to_numpy()) / a
    f['since_open'] = (c - o.groupby(day).transform('first')) / a
    hi, lo = h.groupby(day).cummax(), l.groupby(day).cummin()
    f['day_pos'] = ((c - lo) / (hi - lo).replace(0, np.nan)).fillna(0.5)
    f['bars_today'] = df.groupby(day).cumcount().to_numpy()
    first, final = HOME[sym]
    home = (srv >= first) & (srv <= final)
    f['home'] = home.astype(float)
    # The open of today's home session, only from the hour it has happened.
    home_open = o.where(home).groupby(day).transform('first')
    f['since_home_open'] = ((c - home_open) / a).where(srv >= first, 0.0).fillna(0.0)
    return f


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
    if CLOCK and TF != 'D1':
        srv = server_hours(df.index)
        f['broker_hour'] = srv
        # The pair's own habit: its average move over the next HORIZON bars from this hour of the day, over
        # about the last three years. The two latest days are left out, so no move that is still
        # running (or still to come) can leak in.
        ahead = (o.shift(-(HORIZON + 1)) - o.shift(-1)) / a
        f['habit'] = ahead.groupby(srv).transform(lambda x: x.rolling(750, min_periods=250).mean().shift(2 if HORIZON <= 20 else 3))
    if MARKETS:
        for k, (own, group) in strength.items():
            f[f'strength_{k}'] = own[sym].reindex(df.index)
            f[f'group_{k}'] = group[sym].reindex(df.index)
        f['group'] = float(sorted(set(GROUP.values())).index(GROUP[sym]))
        f = f.join(session_features(sym, df, a))
    else:
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


def spread_arrays(sym, df):
    """Per bar, in price: the broker's spread at the bar's open and its typical spread while the bar forms.

    The profile is kept per hour of the broker's clock (New York + 7 h), because the big effect, the
    widening around the daily rollover, follows New York time."""
    prof = SPREAD_PROFILE[sym]
    if 'open_by_server_hour' in prof:   # other markets: the spread on the hour (NaN = unknown) and while the bar forms
        at_open, during = hour_profiles(sym, SPREAD_MULT)
        srv = server_hours(df.index)
        return at_open[srv], during[srv]
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
        prof = SPREAD_PROFILE[sym]
        # Other markets carry their own slippage (half their average spread); the stress test doubles it too.
        slip = prof.get('slip_pips', SLIP_PIPS) * (SPREAD_MULT if MARKETS else 1)
        cost = (prof.get('commission_pips', COMMISSION_PIPS) + slip) * pip(sym)
    else:
        sp_open = sp_bar = np.zeros(n)
        cost = cost_pips(sym) * pip(sym)
    cost += EXTRA_COST_PIPS * pip(sym)
    srv = server_hours(df.index) if (MARKETS or SKIP_HOURS or FLAT_HOUR is not None or EXIT == 'time') and TF != 'D1' else None
    if EXIT == 'time' or MARKETS:   # the broker day of every bar, to keep a trade inside one day
        day = server_days(df.index).asi8
    sp_exit = sp_open
    if MARKETS:
        # No entry where the spread on the hour could not be measured, on the first bar after a break
        # (a reopening) or on the day's last bar. Getting out on the hour where it is unknown costs the
        # widest spread that was measured on the hour.
        contiguous = np.r_[False, (df.index[1:] - df.index[:-1]) == pd.Timedelta(hours=1)]
        last_bar = np.r_[day[1:] != day[:-1], True]
        can_enter = np.isfinite(sp_open) & contiguous & ~last_bar
        sp_exit = np.where(np.isfinite(sp_open), sp_open, np.nanmax(sp_open))
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
            if MARKETS and not can_enter[i + 1]:
                continue
            e = o[i + 1] + (sp_open[i + 1] if side == 1 else 0.0)
            sl = SL_ATR * av[i]
            tp = TP_ATR * av[i]
            if EXIT == 'time':
                j = i + 1 + HORIZON   # out at the open of this bar: a long at the bid, a short at the ask
                if day[j] != day[i + 1] or srv[j] in (23, 0, 1) or srv[i + 1] in (23, 0, 1):
                    continue
                pnl = (o[j] + (0.0 if side == 1 else sp_exit[j]) - e) * side - cost
                r[i] = pnl / sl   # in units of 1.5 x ATR, to compare with the other tests; no stop is placed
                exit_i[i] = j - 1
                win[i] = 1.0 if pnl > 0 else 0.0
                continue
            out = None
            for j in range(i + 1, i + 1 + HORIZON):
                if srv is not None and FLAT_HOUR is not None and j > i + 1 and (srv[j] == FLAT_HOUR or (MARKETS and last_bar[j])):
                    # Flat before the rollover (other markets: also before the day's last bar): out at this
                    # bar's open, a long at the bid, a short at the ask.
                    px = o[j] + (0.0 if side == 1 else (sp_exit[j] if MARKETS else sp_bar[j - 1]))
                    out = ((px - e) * side, j - 1, 0)
                    break
                if MARKETS and j > i + 1:
                    # A bar that opens beyond the stop (after a break): filled at that open, not at the stop.
                    jump = ((o[j] if side == 1 else o[j] + sp_bar[j]) - e) * -side
                    if jump >= sl:
                        out = (-jump, j, 0)
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


def random_trades(rng, bar, rl, rs, xl, xs, count, sides=None):
    """The same number of non-overlapping trades, entered at random bars on random sides, or, with
    sides given, on exactly those sides (as many buys and sells as the model took)."""
    out = []
    busy_until = -1
    order = np.sort(rng.choice(len(bar), size=min(len(bar), count * 6), replace=False)) if count else []
    want = list(rng.permutation(sides)) if sides is not None else None
    for i in order:
        if len(out) >= count:
            break
        if bar[i] <= busy_until:
            continue
        long = (want[len(out)] == 1) if want is not None else rng.random() < 0.5
        r = rl[i] if long else rs[i]
        if np.isnan(r):
            continue
        out.append(r)
        busy_until = xl[i] if long else xs[i]
    return out


def line(name, r, days, rnd=None, same=None):
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
    if same is not None and len(same) > 1:
        sm = np.mean(same)
        sse = np.std(same, ddof=1) / np.sqrt(len(same))
        s += f' | same sides at random {sm:+.3f}R · model minus that {m - sm:+.3f}R (t={(m - sm) / np.sqrt(se ** 2 + sse ** 2):+.2f})'
    return s


def main(hourly_folder, daily_folder):
    t0 = time.time()
    data = load(hourly_folder, daily_folder)
    d = BARS_PER_DAY
    windows = sorted({d, 5 * d} | ({20 * d} if HTF else set()))
    if MARKETS:
        known = [s for s in sorted(data) if s in GROUP and s in (SPREAD_PROFILE or {})]
        pairs = [s for s in known if (data[s].index[-1] - data[s].index[0]).days >= MIN_YEARS * 365.25]
        if len(pairs) < len(known):
            print(f'left out, fewer than {MIN_YEARS:g} years of bars: ' + ', '.join(s for s in known if s not in pairs))
        strength = group_strength({s: data[s] for s in pairs}, windows)
    else:
        pairs = [p for p in (MAJORS if PAIRSET == 'majors' else PAIRS) if p in data]
        strength = currency_strength(data, windows)
    rows = []
    for sym in pairs:
        df = data[sym]
        f, a = features(sym, df, strength)
        if len(df) > 50_000:  # long histories: halve the memory
            f = f.astype('float32')
        bo = barrier_outcomes(sym, df, a)
        f['sym'] = sym
        f['i'] = np.arange(len(df))
        f['u'] = (SL_ATR * a / pip(sym)).to_numpy()   # one R in pips
        for side, name in ((1, 'l'), (-1, 's')):
            r, x, w = bo[side]
            f[f'r_{name}'], f[f'x_{name}'], f[f'w_{name}'] = r, x, w
        rows.append(f)
    allf = pd.concat(rows).dropna().sort_index()
    meta = ('sym', 'i', 'u', 'r_l', 'r_s', 'x_l', 'x_s', 'w_l', 'w_s')
    feat = [c for c in allf.columns if c not in meta]
    print(f'##### {LABEL}: {TF} bars, stop {SL_ATR}×ATR, target {TP_ATR}×ATR (1:{TP_ATR / SL_ATR:g}), at most {HORIZON} bars, '
          f'{"with" if HTF else "without"} the longer-term picture, {len(pairs)} {"markets (" + " ".join(pairs) + ")" if MARKETS else "pairs"}, '
          f'{"broker spread per hour, bid/ask fills" if SPREAD_PROFILE else "flat cost per pair"}'
          + (f', trained on the last {TRAIN_MONTHS} months' if TRAIN_MONTHS else '')
          + (f', no entries in broker hours {sorted(SKIP_HOURS)}' if SKIP_HOURS else '')
          + (f', flat at broker hour {FLAT_HOUR}' if FLAT_HOUR is not None else '')
          + (f', no stop or target: out after {HORIZON} bars within the broker day' if EXIT == 'time' else '')
          + (', with clock features' if CLOCK else '')
          + (f', spreads ×{SPREAD_MULT:g}' if SPREAD_MULT != 1 else '') + (f', +{EXTRA_COST_PIPS:g} pips cost' if EXTRA_COST_PIPS else ''))
    print(f'{len(allf)} samples, {len(feat)} features, {allf.index.min():%Y-%m-%d} to {allf.index.max():%Y-%m-%d} · '
          f'a trade wins {allf[["w_l", "w_s"]].to_numpy().mean() * 100:.0f}% of the time by chance ({time.time() - t0:.0f}s)', flush=True)

    months = pd.period_range(allf.index.min().tz_localize(None).to_period('M'), allf.index.max().tz_localize(None).to_period('M'), freq='M')
    # Purge gap between training and test: the longest a trade can last, weekends included.
    gap = pd.Timedelta(hours=(HORIZON + 1) * 24 / d * 1.5 + 72)
    res = {q: {} for q in QUANTILES}
    rnd = {q: [] for q in QUANTILES}
    same = {q: [] for q in QUANTILES}
    book = {q: [] for q in QUANTILES}
    rng = np.random.default_rng(1)
    rng_same = np.random.default_rng(2)
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
                unit = g['u'].to_numpy()
                extra = [()] * len(mine)
                if MARKETS:
                    same[q] += random_trades(rng_same, *args, len(mine), sides=[t[2] for t in mine])
                if MATCHED:
                    cell = {}
                    for _, k, side in mine:
                        if (hrs[k], side) not in cell:
                            cell[(hrs[k], side)] = float(np.nanmean((args[1] if side == 1 else args[2])[hrs == hrs[k]]))
                    extra = [(cell[(hrs[k], side)], float((args[2] if side == 1 else args[1])[k])) for _, k, side in mine]
                # The day a trade belongs to: two hours ahead of UTC, so the Sunday-evening open counts as Monday.
                book[q] += [(sym, int(hrs[k]), side, rr, (g.index[k] + pd.Timedelta(hours=2)).date(), rr * unit[k]) + x for (rr, k, side), x in zip(mine, extra)]
            res[q][str(m)] = got
        print(f'  {m}: ' + ' · '.join(f'top {100 - q * 100:.0f}% {len(res[q][str(m)]):4d} tr {np.mean(res[q][str(m)]) if res[q][str(m)] else 0:+.3f}R' for q in QUANTILES) + f' ({time.time() - t0:.0f}s)', flush=True)

    print(f'\n=== {LABEL} · UNSEEN DATA, {days:.0f} trading days · the model trades its most confident situations')
    for q in QUANTILES:
        allr = [x for rr in res[q].values() for x in rr]
        traded = [rr for rr in res[q].values() if len(rr) >= 5]
        pos = sum(1 for rr in traded if np.sum(rr) > 0)
        # Trades on the same day move together, so the honest yardstick is the result per day.
        per_day = pd.DataFrame(book[q], columns=BOOK).groupby('day')['r'].sum()
        by_day = f' · per day t={per_day.mean() / (per_day.std(ddof=1) / np.sqrt(len(per_day))):+.2f}' if len(per_day) > 2 else ''
        print(line(f'top {100 - q * 100:.0f}%', allr, days, rnd[q], same[q] if MARKETS else None) + by_day + f' · periods up {pos}/{len(traded)} · 10,000 at 1% risk: {np.sum(allr) * 100:+,.0f}')
        if MATCHED and len(book[q]) > 2:
            b = pd.DataFrame(book[q], columns=BOOK)
            dlt = b['r'] - b['matched']
            print(f'           against all entries in the same market, hour and side that year ({b["matched"].mean():+.3f}R): {dlt.mean():+.3f}R (t={dlt.mean() / (dlt.std(ddof=1) / np.sqrt(len(dlt))):+.2f})')
            # The opposite trade on the same bar pays the same costs at the same moment. Half the gap between
            # the two is what choosing the side was worth (direction); their average is what a trade costs at
            # the moments the model picks, whatever its side.
            two = b.dropna(subset=['other'])
            if len(two) > 2:
                direction = (two['r'] - two['other']) / 2
                per_day = direction.groupby(two['day']).sum()
                print(f'           the opposite trade on the same bars: {two["other"].mean():+.3f}R · choosing the side is worth {direction.mean():+.3f}R '
                      f'(t={direction.mean() / (direction.std(ddof=1) / np.sqrt(len(direction))):+.2f}, per day t={per_day.mean() / (per_day.std(ddof=1) / np.sqrt(len(per_day))):+.2f}) · '
                      f'a trade at these moments costs {-(two["r"] + two["other"]).mean() / 2:.3f}R on either side')
    if SPLIT_YEAR:
        # Two blocks of unseen years: the choice of a setting is made on the first, the verdict on the second.
        all_days = pd.bdate_range(allf.index[allf.index >= months[MIN_TRAIN_MONTHS].start_time.tz_localize('UTC')].min().date(), allf.index.max().date())
        for name, block in ((f'years up to {SPLIT_YEAR}', all_days[all_days.year <= SPLIT_YEAR]), (f'years after {SPLIT_YEAR}', all_days[all_days.year > SPLIT_YEAR])):
            print(f'\n--- {name} ({len(block)} trading days), per bucket: trades, mean R, mean pips, result per day')
            for q in QUANTILES:
                b = pd.DataFrame(book[q], columns=BOOK)
                b = b[pd.to_datetime(b['day']).isin(block)]
                daily = b.groupby('day')['r'].sum()
                daily.index = pd.to_datetime(daily.index)
                daily = daily.reindex(block, fill_value=0.0)
                sd = daily.std(ddof=1)
                if len(b) < 20 or not sd > 0:
                    print(f'top {100 - q * 100:.0f}%  {len(b)} trades')
                    continue
                print(f'top {100 - q * 100:.0f}%  {len(b):6d} trades · mean {b["r"].mean():+.3f}R · {b["pips"].mean():+.2f} pips · '
                      f'Sharpe {daily.mean() / sd * np.sqrt(252):+.2f} (t={daily.mean() / (sd / np.sqrt(len(daily))):+.2f}) · 10,000 at 1% risk: {b["r"].sum() * 100:+,.0f}')
    # Where the result comes from. An edge that sits in one hour, one side or one pair is suspect.
    for q in (0.95, 0.99):
        b = pd.DataFrame(book[q], columns=BOOK)
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
    if BOOKS:
        # Every trade of this run, and the same-side random trades, for markets_verdict.py.
        os.makedirs(BOOKS, exist_ok=True)
        first = allf.index[allf.index >= months[MIN_TRAIN_MONTHS].start_time.tz_localize('UTC')].min().date()
        parts = [pd.DataFrame(book[q], columns=BOOK).assign(bucket=round(100 - q * 100), kind='model') for q in QUANTILES]
        parts += [pd.DataFrame({'r': same[q]}).assign(bucket=round(100 - q * 100), kind='same') for q in QUANTILES]
        parts.append(pd.DataFrame({'day': [first, allf.index.max().date()], 'kind': 'span'}))
        pd.concat(parts).to_csv(os.path.join(BOOKS, f'{LABEL}.csv'), index=False)
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
