"""
Four chart patterns a trader would recognise, written as fixed rules and tested on the broker's
hourly bars with real costs. The owner of this project named them from his own trading:
false breakouts, support and resistance, range breakouts, and trends with a pullback.

Nothing is fitted to the data, so all sixteen years are an honest test. Every rule decides on the
close of an hourly bar and enters at the open of the next one. A trade risks the distance to its
stop (1R) and aims for twice that. Fills as at a broker: a buy opens at the ask and closes at the
bid; commission and slippage come on top; interest is booked for every night a trade stays open.

Levels (all from the hours with normal spreads, 02:00-22:00 on the broker's clock):
  yesterday's high and low · the night range (02:00-09:00) · round numbers (every 100 pips)

Rules, fixed before the first run (27 November 2026):
  1. False breakout of yesterday's high / low: the bar pokes through the level for the first time
     today and closes back inside. Trade back into the range; stop just beyond the bar's extreme.
  2. False breakout of the night range (from 09:00): the same, at the night's high / low.
  3. Bounce at yesterday's high / low: the bar comes within 0.15 ATR of the level without
     passing it and turns away (a wick of at least 40% of the bar, closing against the level).
     Trade away from the level; stop 0.5 ATR beyond it.
  4. Bounce at a round number: the same at the nearest 100-pip level (it may poke 0.15 ATR through).
  5. Breakout of the night range (09:00-14:00): the first close beyond the night's high / low.
     Trade with the break; stop at the middle of the night range.
  6. Breakout of yesterday's high / low: the first close beyond it today. Trade with the break;
     stop 1 ATR back inside.
  7. Trend with a pullback: the 50-bar average is above the 200-bar average and rising, the price
     dips to the 50-bar average and closes back above it on a rising bar (and the mirror image).
     Trade with the trend; stop 0.3 ATR beyond the dip. May stay open up to five days.
Entries between 03:00 and 20:00. Patterns 1-6 are day trades: whatever is still open is closed at
22:00. Stops narrower than
0.5 ATR or wider than 4 ATR are skipped. One trade per pair and pattern at a time.

The bar: after all costs a Sharpe ratio of at least 0.5 with a per-day t-value of at least 2, and a
positive result in at least three of the four periods. With seven patterns tested at once, one
reaching t = 2 by luck alone is likely; the periods are there to catch that.

Usage: SPREADS=<spreads.json> python patterns.py <hourly folder> <rates folder>

MARKETS=1 runs the same rules on gold, oil and stock indices (icm_import_markets.py; the plan and
the bar are in README.md, written before that data existed):
  - the round number is the 1, 2.5 or 5 times a power of ten closest to 1% of the price a year earlier;
  - an entry pays the spread measured on the hour; none where that is unknown, on the first bar
    after a break or on the day's last bar; day trades are also closed at the open of the day's last bar;
  - pattern 7 is charged the broker's own swap per night, and a short an estimated dividend yield;
  - two more rules for indices with a home session:
      8. false breakout and 9. breakout of the range built before the home session opens (02:00 to
         10:00 for European indices, to 17:00 for US indices), in the first five hours after that;
  - the bar: per-day t of at least 3, positive in three of four periods, and sells must not lose.
SPREAD_MULT=2 doubles spreads and slippage (the stress test).
"""
import os
import sys

import numpy as np
import pandas as pd

from carry_daily import load_rates
from common import COMMISSION_PIPS, GROUP, SLIP_PIPS, SPREAD_PROFILE, atr, hour_profiles, load_hourly, pip, server_hours

REWARD = 2.0                    # target = 2 x the risk
MARKUP = 0.0104                 # the broker's cut on overnight interest, per year (read from its swap rates)
FIRST, LAST = 3, 20             # entries between these broker hours (the bar that decides opens at 02:00 at the
                                # earliest, so no bar distorted by the rollover's wide spreads can set off a rule)
FLAT = 22
PERIODS = [(2010, 2014), (2015, 2018), (2019, 2022), (2023, 2026)]
BAR_SHARPE, BAR_T = 0.5, 2.0
MARKETS = os.environ.get('MARKETS', '0') == '1'
MIN_YEARS = float(os.environ.get('MIN_YEARS', 6))
SPREAD_MULT = float(os.environ.get('SPREAD_MULT', 1))
BAR_T_MARKETS = 3.0
# The hour (broker clock) at which the home session counts as open; the range before it runs from 02:00.
HOME_OPEN = {'DE40': 10, 'UK100': 10, 'F40': 10, 'STOXX50': 10, 'US500': 17, 'USTEC': 17, 'US30': 17, 'US2000': 17}
NAMES = {
    1: 'false breakout of yesterday\'s high / low',
    2: 'false breakout of the night range',
    3: 'bounce at yesterday\'s high / low',
    4: 'bounce at a round number',
    5: 'breakout of the night range',
    6: 'breakout of yesterday\'s high / low',
    7: 'trend with a pullback',
}
if MARKETS:
    NAMES.update({8: 'false breakout of the range before the home session', 9: 'breakout of the range before the home session'})


def round_steps(t, c):
    """Per bar the round-number step: the 1, 2.5 or 5 times a power of ten closest to 1% of the price a
    year earlier (so the step grows with the market and never looks ahead)."""
    past = np.searchsorted(t.asi8, (t - pd.Timedelta(days=365)).asi8, side='right') - 1
    ref = np.where(past >= 0, c[np.maximum(past, 0)], np.nan) * 0.01
    with np.errstate(invalid='ignore', divide='ignore'):
        power = 10.0 ** np.floor(np.log10(ref))
        best = np.full(len(c), np.nan)
        for m in (1, 2.5, 5, 10):
            cand = m * power
            closer = ~(np.abs(np.log(best / ref)) <= np.abs(np.log(cand / ref)))
            best = np.where(closer, cand, best)
    return np.where(np.isfinite(ref), best, np.nan)


def prepare(pair, df, rates):
    """Everything a rule needs per bar, known at that bar's close."""
    o, h, l, c = (df[x].to_numpy() for x in ['open', 'high', 'low', 'close'])
    n = len(df)
    srv = server_hours(df.index)
    wall = df.index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)
    day = wall.normalize()
    day_id = pd.factorize(day)[0]
    a = atr(df).to_numpy()
    core = (srv >= 2) & (srv <= 22)
    frame = pd.DataFrame({'day': day_id, 'h': np.where(core, h, np.nan), 'l': np.where(core, l, np.nan)})
    per_day = frame.groupby('day').agg(h=('h', 'max'), l=('l', 'min'))
    pdh = per_day['h'].shift(1).reindex(day_id).to_numpy()      # yesterday's high and low
    pdl = per_day['l'].shift(1).reindex(day_id).to_numpy()
    night = (srv >= 2) & (srv <= 8)
    nf = pd.DataFrame({'day': day_id, 'h': np.where(night, h, np.nan), 'l': np.where(night, l, np.nan), 'k': night.astype(int)})
    per_night = nf.groupby('day').agg(h=('h', 'max'), l=('l', 'min'), k=('k', 'sum'))
    ok_night = (per_night['k'] >= 5).reindex(day_id).to_numpy() & (srv >= 9)
    nh = np.where(ok_night, per_night['h'].reindex(day_id).to_numpy(), np.nan)   # the night range, from 09:00 on
    nl = np.where(ok_night, per_night['l'].reindex(day_id).to_numpy(), np.nan)
    # Today's high / low before this bar (normal hours only): has a level been passed already today?
    run_h = frame.groupby('day')['h'].cummax().groupby(frame['day']).shift(1).to_numpy()
    run_l = frame.groupby('day')['l'].cummin().groupby(frame['day']).shift(1).to_numpy()
    cs = pd.Series(c)
    e50 = cs.ewm(span=50, adjust=False).mean().to_numpy()
    e200 = cs.ewm(span=200, adjust=False).mean().to_numpy()
    prof = (SPREAD_PROFILE or {}).get(pair)
    if not prof:
        raise SystemExit('Set SPREADS to the broker spread profile (icm_import.py writes it)')
    first_bar = np.r_[False, day_id[1:] != day_id[:-1]]
    if MARKETS:
        at_open, during = hour_profiles(pair, SPREAD_MULT)
        sp_open, sp = at_open[srv], during[srv]
        cost = (prof.get('commission_pips', 0.0) + prof.get('slip_pips', 0.0) * SPREAD_MULT) * pip(pair)
        # No entry where the spread on the hour is unknown, on the first bar after a break, or on the day's last bar.
        last_bar = np.r_[day_id[1:] != day_id[:-1], True]
        contiguous = np.r_[False, (df.index[1:] - df.index[:-1]) == pd.Timedelta(hours=1)]
        can_enter = np.isfinite(sp_open) & contiguous & ~last_bar
        sp_exit = np.where(np.isfinite(sp_open), sp_open, np.nanmax(sp_open))
        # The broker's swap, booked at each rollover: three nights after the day the broker names. A short
        # also pays the dividends that drop out of an index while it is held (per calendar night).
        prev_dow = np.r_[0, day.dayofweek[:-1]]
        nights = np.where(first_bar, np.where(prev_dow == prof.get('swap_3day', 4), 3, 1), 0)
        calendar = np.where(first_bar, np.r_[0, np.asarray((day[1:] - day[:-1]) / pd.Timedelta(days=1), dtype=float)], 0)
        swap_l = np.cumsum(nights * np.nan_to_num(prof.get('swap_long_rate', 0.0)) * o)
        swap_s = np.cumsum(nights * np.nan_to_num(prof.get('swap_short_rate', 0.0)) * o - calendar * prof.get('dividend_yield', 0.0) / 365 * o)
        # The range before the home session: from 02:00 until the hour the home session counts as open.
        home = HOME_OPEN.get(pair)
        if home is not None:
            before = (srv >= 2) & (srv < home)
            bf = pd.DataFrame({'day': day_id, 'h': np.where(before, h, np.nan), 'l': np.where(before, l, np.nan), 'k': before.astype(int)})
            per_before = bf.groupby('day').agg(h=('h', 'max'), l=('l', 'min'), k=('k', 'sum'))
            ok_home = (per_before['k'] >= 5).reindex(day_id).to_numpy() & (srv >= home) & (srv <= home + 4)
            hh = np.where(ok_home, per_before['h'].reindex(day_id).to_numpy(), np.nan)
            hl = np.where(ok_home, per_before['l'].reindex(day_id).to_numpy(), np.nan)
        else:
            hh = hl = np.full(n, np.nan)
        return dict(pair=pair, t=df.index, o=o, h=h, l=l, c=c, n=n, srv=srv, day=day_id, a=a, pdh=pdh, pdl=pdl, nh=nh, nl=nl,
                    run_h=run_h, run_l=run_l, e50=e50, e200=e200, sp=sp, sp_open=sp_open, sp_exit=sp_exit, cost=cost,
                    can_enter=can_enter, last_bar=last_bar, swap_l=swap_l, swap_s=swap_s, hh=hh, hl=hl,
                    step=round_steps(df.index, c))
    by_hour = np.array([prof['tick_weighted'] if v is None else v for v in prof['by_server_hour']]) * pip(pair)
    cost = (prof.get('commission_pips', COMMISSION_PIPS) + SLIP_PIPS) * pip(pair)
    # Interest booked at each rollover: one night, three on the night to Thursday.
    nights = np.where(first_bar, np.where(day.dayofweek == 3, 3, 1), 0)
    base, quote = pair[:3], pair[3:]
    diff = np.zeros(n)
    if base in rates and quote in rates:
        m = rates[[base, quote]].shift(1)
        r = m.reindex(m.index.union(df.index)).ffill().reindex(df.index) / 100
        diff = (r[base] - r[quote]).fillna(0).to_numpy()
    return dict(pair=pair, t=df.index, o=o, h=h, l=l, c=c, n=n, srv=srv, day=day_id, a=a, pdh=pdh, pdl=pdl, nh=nh, nl=nl,
                run_h=run_h, run_l=run_l, e50=e50, e200=e200, sp=by_hour[srv], cost=cost,
                interest=np.cumsum(nights * diff / 365 * o), markup=np.cumsum(nights * MARKUP / 365 * o))


def signals(P):
    """(bar, pattern, side, stop price) for every bar where a rule fires."""
    o, h, l, c, a, srv = P['o'], P['h'], P['l'], P['c'], P['a'], P['srv']
    pdh, pdl, nh, nl, run_h, run_l, e50, e200 = P['pdh'], P['pdl'], P['nh'], P['nl'], P['run_h'], P['run_l'], P['e50'], P['e200']
    hours = (srv >= FIRST - 1) & (srv <= LAST - 1) & (a > 0)        # the next bar opens between FIRST and LAST
    rng = np.maximum(h - l, 1e-12)
    up_wick = (h - np.maximum(o, c)) / rng
    dn_wick = (np.minimum(o, c) - l) / rng
    tol = 0.15 * a
    out = []

    def add(mask, pattern, side, stop):
        for i in np.flatnonzero(mask & hours & np.isfinite(stop)):
            out.append((i, pattern, side, float(stop[i])))

    fresh_h = ~(run_h > pdh)       # yesterday's high not passed earlier today
    fresh_l = ~(run_l < pdl)
    # 1. false breakout of yesterday's high / low
    add((h > pdh) & (c < pdh) & fresh_h, 1, -1, h + 0.1 * a)
    add((l < pdl) & (c > pdl) & fresh_l, 1, 1, l - 0.1 * a)
    # 2. false breakout of the night range
    nfresh_h = ~(run_h > nh)
    nfresh_l = ~(run_l < nl)
    add((h > nh) & (c < nh) & nfresh_h, 2, -1, h + 0.1 * a)
    add((l < nl) & (c > nl) & nfresh_l, 2, 1, l - 0.1 * a)
    # 3. bounce at yesterday's high / low (touch without passing)
    add((h <= pdh) & (h >= pdh - tol) & (up_wick >= 0.4) & (c < o) & fresh_h, 3, -1, pdh + 0.5 * a)
    add((l >= pdl) & (l <= pdl + tol) & (dn_wick >= 0.4) & (c > o) & fresh_l, 3, 1, pdl - 0.5 * a)
    # 4. bounce at a round number (every 100 pips)
    step = P['step'] if MARKETS else 100 * pip(P['pair'])
    above = np.ceil((h - tol) / step) * step        # the level this bar's high reached for
    below = np.floor((l + tol) / step) * step
    add((np.abs(h - above) <= tol) & (up_wick >= 0.4) & (c < o) & (c < above), 4, -1, above + 0.5 * a)
    add((np.abs(l - below) <= tol) & (dn_wick >= 0.4) & (c > o) & (c > below), 4, 1, below - 0.5 * a)
    # 5. breakout of the night range, 09:00-14:00
    early = (srv >= 9) & (srv <= 13)
    mid = (nh + nl) / 2
    add((c > nh) & nfresh_h & early & ~(np.r_[np.nan, c[:-1]] > nh), 5, 1, mid)
    add((c < nl) & nfresh_l & early & ~(np.r_[np.nan, c[:-1]] < nl), 5, -1, mid)
    # 6. breakout of yesterday's high / low
    add((c > pdh) & fresh_h, 6, 1, pdh - a)
    add((c < pdl) & fresh_l, 6, -1, pdl + a)
    # 7. trend with a pullback to the 50-bar average
    rising = e50 > np.r_[np.full(24, np.nan), e50[:-24]]
    falling = e50 < np.r_[np.full(24, np.nan), e50[:-24]]
    add((e50 > e200) & rising & (l <= e50) & (c > e50) & (c > o), 7, 1, l - 0.3 * a)
    add((e50 < e200) & falling & (h >= e50) & (c < e50) & (c < o), 7, -1, h + 0.3 * a)
    if MARKETS:
        hh, hl = P['hh'], P['hl']           # the range before the home session; NaN outside its five hours
        hfresh_h = ~(run_h > hh)
        hfresh_l = ~(run_l < hl)
        # 8. false breakout of the range before the home session
        add((h > hh) & (c < hh) & hfresh_h, 8, -1, h + 0.1 * a)
        add((l < hl) & (c > hl) & hfresh_l, 8, 1, l - 0.1 * a)
        # 9. breakout of the range before the home session
        hmid = (hh + hl) / 2
        add((c > hh) & hfresh_h & ~(np.r_[np.nan, c[:-1]] > hh), 9, 1, hmid)
        add((c < hl) & hfresh_l & ~(np.r_[np.nan, c[:-1]] < hl), 9, -1, hmid)
    out.sort()
    return out


def trade(P, i, side, stop, day_trade):
    """One trade entered at the open of bar i+1: (result in R after costs, result in R before costs, exit bar)."""
    o, h, l, c, sp, srv, day = P['o'], P['h'], P['l'], P['c'], P['sp'], P['srv'], P['day']
    e_bar = i + 1
    if e_bar >= P['n'] - 1:
        return None
    if MARKETS:
        if not P['can_enter'][e_bar]:
            return None
        sp_in, sp_out, last_bar = P['sp_open'], P['sp_exit'], P['last_bar']    # the spread on the hour, in and out
    else:
        sp_in = sp_out = sp
        last_bar = None
    entry = o[e_bar] + (sp_in[e_bar] if side == 1 else 0.0)        # a buy opens at the ask
    risk = (entry - stop) * side
    if not (0.5 * P['a'][i] <= risk <= 4 * P['a'][i]):
        return None
    target = entry + side * REWARD * risk
    last = min(P['n'] - 1, e_bar + (10_000 if day_trade else 120))
    pnl, x = None, e_bar
    for j in range(e_bar, last + 1):
        if j > e_bar and (day[j] != day[e_bar] or srv[j] >= FLAT or (last_bar is not None and last_bar[j])) and day_trade:
            pnl, x = (o[j] + (0.0 if side == 1 else sp_out[j]) - entry) * side, j     # flat at 22:00, at the open
            break
        # What this side can get out at: a long sells at the bid, a short buys at the ask.
        hi, lo, op = (h[j], l[j], o[j]) if side == 1 else (h[j] + sp[j], l[j] + sp[j], o[j] + sp[j])
        if side == 1:
            if j > e_bar and op <= stop:
                pnl, x = op - entry, j
                break
            if lo <= stop:
                pnl, x = stop - entry, j
                break
            if hi >= target:
                pnl, x = target - entry, j
                break
        else:
            if j > e_bar and op >= stop:
                pnl, x = entry - op, j
                break
            if hi >= stop:
                pnl, x = entry - stop, j
                break
            if lo <= target:
                pnl, x = entry - target, j
                break
    if pnl is None:
        x = last
        pnl = (c[x] + (0.0 if side == 1 else sp[x]) - entry) * side
    if MARKETS:
        book = P['swap_l'] if side == 1 else P['swap_s']
        swap = book[x] - book[e_bar]
    else:
        swap = side * (P['interest'][x] - P['interest'][e_bar]) - (P['markup'][x] - P['markup'][e_bar])
    # "Before costs" puts back the spread this trade paid (at entry for a buy, at exit for a sell).
    return (pnl + swap - P['cost']) / risk, (pnl + swap + (sp_in[e_bar] if side == 1 else sp[x])) / risk, x


def run(pair, df, rates):
    P = prepare(pair, df, rates)
    busy = {}
    rows = []
    for i, pattern, side, stop in signals(P):
        if busy.get(pattern, -1) >= i:
            continue
        res = trade(P, i, side, stop, day_trade=pattern != 7)
        if res is None:
            continue
        net, gross, x = res
        busy[pattern] = x
        rows.append((pattern, pair, (P['t'][i] + pd.Timedelta(hours=2)).date(), side, net, gross))
    return rows


def report(book):
    days = pd.bdate_range(book['day'].min(), book['day'].max())
    print(f'{len(book)} trades on {book["pair"].nunique()} pairs, {days[0]:%Y-%m} to {days[-1]:%Y-%m} · every trade risks 1R and aims for {REWARD:g}R')
    reached = []
    for pattern, name in NAMES.items():
        b = book[book['pattern'] == pattern]
        if len(b) < 50:
            print(f'\n{pattern}. {name}: {len(b)} trades, too few to judge')
            continue
        daily = b.groupby('day')['net'].sum().reindex(days, fill_value=0.0)
        sharpe = daily.mean() / daily.std(ddof=1) * np.sqrt(252)
        t = daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily)))
        se = b['net'].std(ddof=1) / np.sqrt(len(b))
        gse = b['gross'].std(ddof=1) / np.sqrt(len(b))
        per = []
        for a0, b0 in PERIODS:
            seg = b[(b['day'].dt.year >= a0) & (b['day'].dt.year <= b0)]
            per.append((f'{a0}-{b0}', seg['net'].mean() if len(seg) >= 30 else np.nan, len(seg)))
        up = sum(1 for _, m, _ in per if m > 0)
        sells = b[b['side'] == -1]['net'].mean()
        ok = (t >= BAR_T_MARKETS and up >= 3 and sells >= 0) if MARKETS else (sharpe >= BAR_SHARPE and t >= BAR_T and up >= 3)
        if ok:
            reached.append(name)
        print(f'\n{pattern}. {name}: {len(b)} trades ({len(b) / len(days):.2f} a day) · wins {np.mean(b["net"] > 0) * 100:.0f}%')
        print(f'   before costs {b["gross"].mean():+.3f}R (±{gse:.3f}, t={b["gross"].mean() / gse:+.2f}) · after costs {b["net"].mean():+.3f}R (±{se:.3f}) · '
              f'Sharpe {sharpe:+.2f} (per-day t={t:+.2f}) · 10,000 at 1% risk: {b["net"].sum() * 100:+,.0f}')
        print('   per period: ' + ' · '.join(f'{n} {m:+.3f}R ({k})' for n, m, k in per) +
              f' · buys {b[b["side"] == 1]["net"].mean():+.3f}R, sells {b[b["side"] == -1]["net"].mean():+.3f}R')
        best = b.groupby('pair')['net'].agg(['mean', 'count'])
        print('   per pair: ' + ' · '.join(f'{p} {r["mean"]:+.2f}' for p, r in best.iterrows() if r['count'] >= 30))
        print(f'   THE BAR: {"REACHED" if ok else "not reached"} (Sharpe {sharpe:+.2f}, t {t:+.2f}, positive in {up} of {len(PERIODS)} periods'
              + (f', sells {sells:+.3f}R; needed: t {BAR_T_MARKETS:g}, three periods, sells not negative)' if MARKETS else ')'))
    print('\nPatterns that reach the bar: ' + (', '.join(reached) if reached else 'none'))


def main(hourly_folder, rates_folder=None):
    data = load_hourly(hourly_folder)
    until = max(df.index[-1] for df in data.values())
    if MARKETS:
        rates = {}
        known = {s: d for s, d in data.items() if s in GROUP and s in (SPREAD_PROFILE or {})}
        data = {s: d for s, d in known.items() if (d.index[-1] - d.index[0]).days >= MIN_YEARS * 365.25}
        if len(data) < len(known):
            print(f'left out, fewer than {MIN_YEARS:g} years of bars: ' + ', '.join(s for s in known if s not in data))
        if SPREAD_MULT != 1:
            print(f'STRESS TEST: spreads and slippage x{SPREAD_MULT:g}')
    else:
        rates, _ = load_rates(rates_folder, until)
    rows = []
    for pair, df in data.items():
        rows += run(pair, df, rates)
    book = pd.DataFrame(rows, columns=['pattern', 'pair', 'day', 'side', 'net', 'gross'])
    book['day'] = pd.to_datetime(book['day'])
    report(book)


if __name__ == '__main__':
    main(*sys.argv[1:3])
