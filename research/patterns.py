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
"""
import sys

import numpy as np
import pandas as pd

from carry_daily import load_rates
from common import COMMISSION_PIPS, SLIP_PIPS, SPREAD_PROFILE, atr, load_hourly, pip, server_hours

REWARD = 2.0                    # target = 2 x the risk
MARKUP = 0.0104                 # the broker's cut on overnight interest, per year (read from its swap rates)
FIRST, LAST = 3, 20             # entries between these broker hours (the bar that decides opens at 02:00 at the
                                # earliest, so no bar distorted by the rollover's wide spreads can set off a rule)
FLAT = 22
PERIODS = [(2010, 2014), (2015, 2018), (2019, 2022), (2023, 2026)]
BAR_SHARPE, BAR_T = 0.5, 2.0
NAMES = {
    1: 'false breakout of yesterday\'s high / low',
    2: 'false breakout of the night range',
    3: 'bounce at yesterday\'s high / low',
    4: 'bounce at a round number',
    5: 'breakout of the night range',
    6: 'breakout of yesterday\'s high / low',
    7: 'trend with a pullback',
}


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
    by_hour = np.array([prof['tick_weighted'] if v is None else v for v in prof['by_server_hour']]) * pip(pair)
    cost = (prof.get('commission_pips', COMMISSION_PIPS) + SLIP_PIPS) * pip(pair)
    # Interest booked at each rollover: one night, three on the night to Thursday.
    first_bar = np.r_[False, day_id[1:] != day_id[:-1]]
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
    step = 100 * pip(P['pair'])
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
    out.sort()
    return out


def trade(P, i, side, stop, day_trade):
    """One trade entered at the open of bar i+1: (result in R after costs, result in R before costs, exit bar)."""
    o, h, l, c, sp, srv, day = P['o'], P['h'], P['l'], P['c'], P['sp'], P['srv'], P['day']
    e_bar = i + 1
    if e_bar >= P['n'] - 1:
        return None
    entry = o[e_bar] + (sp[e_bar] if side == 1 else 0.0)        # a buy opens at the ask
    risk = (entry - stop) * side
    if not (0.5 * P['a'][i] <= risk <= 4 * P['a'][i]):
        return None
    target = entry + side * REWARD * risk
    last = min(P['n'] - 1, e_bar + (10_000 if day_trade else 120))
    pnl, x = None, e_bar
    for j in range(e_bar, last + 1):
        if j > e_bar and (day[j] != day[e_bar] or srv[j] >= FLAT) and day_trade:
            pnl, x = (o[j] + (0.0 if side == 1 else sp[j]) - entry) * side, j     # flat at 22:00, at the open
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
    swap = side * (P['interest'][x] - P['interest'][e_bar]) - (P['markup'][x] - P['markup'][e_bar])
    # "Before costs" puts back the spread this trade paid (at entry for a buy, at exit for a sell).
    return (pnl + swap - P['cost']) / risk, (pnl + swap + (sp[e_bar] if side == 1 else sp[x])) / risk, x


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
        ok = sharpe >= BAR_SHARPE and t >= BAR_T and up >= 3
        if ok:
            reached.append(name)
        print(f'\n{pattern}. {name}: {len(b)} trades ({len(b) / len(days):.2f} a day) · wins {np.mean(b["net"] > 0) * 100:.0f}%')
        print(f'   before costs {b["gross"].mean():+.3f}R (±{gse:.3f}, t={b["gross"].mean() / gse:+.2f}) · after costs {b["net"].mean():+.3f}R (±{se:.3f}) · '
              f'Sharpe {sharpe:+.2f} (per-day t={t:+.2f}) · 10,000 at 1% risk: {b["net"].sum() * 100:+,.0f}')
        print('   per period: ' + ' · '.join(f'{n} {m:+.3f}R ({k})' for n, m, k in per) +
              f' · buys {b[b["side"] == 1]["net"].mean():+.3f}R, sells {b[b["side"] == -1]["net"].mean():+.3f}R')
        best = b.groupby('pair')['net'].agg(['mean', 'count'])
        print('   per pair: ' + ' · '.join(f'{p} {r["mean"]:+.2f}' for p, r in best.iterrows() if r['count'] >= 30))
        print(f'   THE BAR: {"REACHED" if ok else "not reached"} (Sharpe {sharpe:+.2f}, t {t:+.2f}, positive in {up} of {len(PERIODS)} periods)')
    print('\nPatterns that reach the bar: ' + (', '.join(reached) if reached else 'none'))


def main(hourly_folder, rates_folder):
    data = load_hourly(hourly_folder)
    until = max(df.index[-1] for df in data.values())
    rates, _ = load_rates(rates_folder, until)
    rows = []
    for pair, df in data.items():
        rows += run(pair, df, rates)
    book = pd.DataFrame(rows, columns=['pattern', 'pair', 'day', 'side', 'net', 'gross'])
    book['day'] = pd.to_datetime(book['day'])
    report(book)


if __name__ == '__main__':
    main(*sys.argv[1:3])
