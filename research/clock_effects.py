"""
Two effects that follow the clock instead of the chart, tested on the broker's own hourly bars.

A. THE TRIPLE-SWAP NIGHT. A broker books the interest on an open position once a day, at the
   daily rollover (17:00 New York, 00:00 on the broker's clock). In the night from Wednesday to
   Thursday it books three days at once, to cover the weekend. A position that is open only
   around that rollover collects three days of interest for a few hours of price risk.
B. TIME OF DAY. Do pairs move in the same direction at the same hours often enough to trade?

Rules, fixed before the first run (27 November 2026):
A. Every Wednesday, for every pair whose interest difference pays after the broker's cut: open
   at 23:00 on the broker's clock (an hour before the rollover) on the side that receives
   interest, close at 02:00 (two hours after it). Interest received: three nights of (the
   difference in central-bank rates minus the broker's mark-up). A pair is traded that night
   only if this interest is larger than what the trade costs (the spread at that hour,
   commission and slippage). Fills as at a broker: a buy opens at the ask and closes at the bid.
   What the history can and cannot show: it shows whether prices drift against the trade in
   those hours (they should not) and how wild those hours get. It cannot show what the broker
   really paid in the past: the interest is worked out from central-bank rates and today's
   mark-up. Today's real swap rates are printed next to it.
B. For each pair and each year from the fifth year on: take the four years before, average the
   move of every hour of the day between 02:00 and 22:00 on the broker's clock, and find the
   run of hours with the largest total rise and the run with the largest total fall. In the
   year itself, buy at the start of the first run and sell at its end (and the reverse for the
   second) on every trading day, but only where the four-year average is larger than the cost.
   If the two runs overlap, only the stronger one is traded.
The bar for either: after all costs a Sharpe ratio of at least 0.5 with a t-value of at least 2,
on years the rule never saw.

Usage: SPREADS=<spreads.json> python clock_effects.py <hourly folder> <rates folder> <MetaTrader meta.csv>
"""
import sys

import numpy as np
import pandas as pd

from carry_daily import load_rates
from common import COMMISSION_PIPS, SLIP_PIPS, SPREAD_PROFILE, load_hourly, pip

ENTRY_HOUR, EXIT_HOUR = 23, 2       # A: in an hour before the rollover, out two hours after it
FIRST_HOUR, LAST_HOUR = 2, 22       # B: only the hours with normal spreads
BAR_SHARPE, BAR_T = 0.5, 2.0
PERIODS = [(2010, 2014), (2015, 2018), (2019, 2022), (2023, 2026)]


def clock_table(df):
    """Opening price (bid) per broker day and hour: rows are broker days, columns the hours 0..23."""
    wall = df.index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)
    t = pd.DataFrame({'day': wall.normalize(), 'hour': wall.hour, 'open': df['open'].to_numpy()})
    return t.drop_duplicates(['day', 'hour']).pivot(index='day', columns='hour', values='open').reindex(columns=range(24))


def costs(pair):
    """Spread per broker hour and the fixed part (commission and slippage) of a round trip, in price."""
    prof = (SPREAD_PROFILE or {}).get(pair)
    if not prof:
        raise SystemExit('Set SPREADS to the broker spread profile (icm_import.py writes it)')
    typical = prof['tick_weighted']
    sp = np.array([typical if v is None else v for v in prof['by_server_hour']]) * pip(pair)
    return sp, (prof.get('commission_pips', COMMISSION_PIPS) + SLIP_PIPS) * pip(pair)


def line(x, scale=1.0, unit=''):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    if len(x) < 3:
        return f'n={len(x)}'
    se = x.std(ddof=1) / np.sqrt(len(x))
    return f'{x.mean() * scale:+.2f}{unit} (±{se * scale:.2f}, t={x.mean() / se:+.2f}, n={len(x)})'


def yearly(r, per_year):
    """Mean per year, volatility, Sharpe and t of a series of results (fractions of the money in the trade)."""
    r = r.dropna()
    se = r.std(ddof=1) / np.sqrt(len(r))
    sharpe = r.mean() / r.std(ddof=1) * np.sqrt(per_year)
    return r.mean() * per_year * 100, r.std(ddof=1) * np.sqrt(per_year) * 100, sharpe, r.mean() / se


def triple_swap(tables, rates, markup, meta):
    print('\n=== A. THE TRIPLE-SWAP NIGHT: in at 23:00 Wednesday, out at 02:00, on the side that receives interest')
    print('What it would pay this week at this broker (its real swap rates: three nights against one trade, in pips):')
    for pair in tables:
        if pair not in meta.index:
            continue
        m = meta.loc[pair]
        sp, fixed = costs(pair)
        side = 'buy' if m['swap_long'] >= m['swap_short'] else 'sell'
        got = 3 * max(m['swap_long'], m['swap_short']) * float(m['point']) / pip(pair)
        cost = ((sp[ENTRY_HOUR] if side == 'buy' else sp[EXIT_HOUR]) + fixed) / pip(pair)
        if got > 0:
            print(f'  {pair} {side}: interest {got:+.2f}, cost {cost:.2f} -> {got - cost:+.2f}')

    monthly = rates.copy()
    monthly.index = monthly.index.tz_localize(None)
    monthly = monthly.shift(1)          # the rate at the end of last month
    rows = []
    for pair, tab in tables.items():
        base, quote = pair[:3], pair[3:]
        if base not in monthly or quote not in monthly:
            continue
        sp, fixed = costs(pair)
        entry = tab[ENTRY_HOUR]
        out = tab[EXIT_HOUR].shift(-1)
        next_day = pd.Series(tab.index, index=tab.index).shift(-1) - tab.index == pd.Timedelta(days=1)
        r = monthly[[base, quote]].reindex(monthly.index.union(tab.index)).ffill().reindex(tab.index) / 100
        diff = r[base] - r[quote]
        side = np.sign(diff)
        rows.append(pd.DataFrame({
            'pair': pair, 'weekday': tab.index.dayofweek, 'price': entry,
            'move': side * (out - entry).where(next_day),                       # bid to bid, in the direction of the trade
            'interest': 3 * (diff.abs() - markup) / 365 * entry,
            'cost': np.where(side > 0, sp[ENTRY_HOUR], sp[EXIT_HOUR]) + fixed,
        }).dropna())
    nights = pd.concat(rows)
    nights['pips'] = nights['pair'].map(pip)
    wed = nights[nights['weekday'] == 2]
    other = nights[nights['weekday'].isin([0, 1, 3])]
    print(f'\nHistory, with interest worked out from central-bank rates minus a {markup * 100:.2f}%/yr mark-up.')
    print('Do prices drift in those three hours? Move in the direction that receives interest, in pips, all pairs:')
    print(f'  Wednesday nights {line(wed["move"] / wed["pips"])} · other nights {line(other["move"] / other["pips"])}')
    print(f'  how wild: a typical Wednesday night moves {(wed["move"] / wed["pips"]).std():.1f} pips; the worst 1% lose more than {-(wed["move"] / wed["pips"]).quantile(0.01):.0f} pips')

    traded = wed[wed['interest'] > wed['cost']].copy()
    traded['net'] = traded['move'] + traded['interest'] - traded['cost']
    print('Per pair, the Wednesday nights where the interest beats the cost (per night, in pips):')
    for pair, g in traded.groupby('pair'):
        q = g['pips']
        print(f'  {pair}: {len(g)} nights {g.index[0]:%Y}-{g.index[-1]:%Y} · price move {(g["move"] / q).mean():+.2f} · interest {(g["interest"] / q).mean():+.2f} · '
              f'cost {(g["cost"] / q).mean():.2f} · result {line(g["net"] / q)} · worst {(g["net"] / q).min():.0f}')
    if not len(traded):
        print('  none')
        return
    week = (traded['net'] / traded['price']).groupby(level=0).mean()
    pairs_per_week = traded.groupby(level=0).size().mean()
    ann, vol, sharpe, t = yearly(week, 52)
    by_year = week.groupby(week.index.year).sum()
    print(f'All of them together, equal amounts, per Wednesday: {len(week)} weeks, {pairs_per_week:.1f} pairs a week on average · '
          f'{ann:+.2f}%/yr of the money in the trades at {vol:.2f}% vol · Sharpe {sharpe:+.2f} (t={t:+.2f}) · {int((by_year > 0).sum())}/{len(by_year)} years up')
    for a, b in PERIODS:
        seg = week[(week.index.year >= a) & (week.index.year <= b)]
        if len(seg) >= 20:
            pa, pv, ps, pt = yearly(seg, 52)
            print(f'  {a}-{b}: {len(seg)} weeks · {pa:+.2f}%/yr · Sharpe {ps:+.2f} (t={pt:+.2f})')
    moves_only = (traded['move'] / traded['price']).groupby(level=0).mean()
    print(f'  of which price moves alone: {yearly(moves_only, 52)[0]:+.2f}%/yr (t={yearly(moves_only, 52)[3]:+.2f}); the rest is interest minus costs')
    lev = 10
    print(f'  on a 10,000 account with {lev} times the account in these trades: about {ann / 100 * lev * 10000:+,.0f} a year, '
          f'a typical week moves {week.std() * lev * 10000:,.0f}, the worst week was {week.min() * lev * 10000:+,.0f}')
    ok = sharpe >= BAR_SHARPE and t >= BAR_T
    print(f'THE BAR (Sharpe at least {BAR_SHARPE}, t at least {BAR_T}): Sharpe {sharpe:+.2f}, t {t:+.2f} -> {"REACHED" if ok else "NOT REACHED"}')


def best_run(mu):
    """The run of consecutive hours with the largest total: (total, first index, last index)."""
    best = (-np.inf, 0, 0)
    for a in range(len(mu)):
        total = 0.0
        for b in range(a, len(mu)):
            total += mu[b]
            if total > best[0]:
                best = (total, a, b)
    return best


def time_of_day(tables):
    print('\n=== B. TIME OF DAY: the strongest run of hours of the past four years, traded in the next year')
    hours = list(range(FIRST_HOUR, LAST_HOUR))      # the move from the start of that hour to the start of the next
    trades, seen, later = [], [], []
    for pair, tab in tables.items():
        sp, fixed = costs(pair)
        rel = (tab.shift(-1, axis=1) / tab - 1)[hours]
        for y in sorted(set(tab.index.year)):
            train = rel[(tab.index.year >= y - 4) & (tab.index.year < y)]
            test_tab = tab[tab.index.year == y]
            if train.index.year.nunique() < 4 or len(train) < 800 or len(test_tab) < 100:
                continue
            mu = train.mean().to_numpy()
            seen.append(mu)
            later.append(rel[tab.index.year == y].mean().to_numpy())
            ref = float(tab[tab.index.year == y - 1][FIRST_HOUR].mean())
            up, down = best_run(mu), best_run(-mu)
            runs = [(1, *up), (-1, *down)]
            if not (up[2] < down[1] or down[2] < up[1]):          # they overlap: keep the stronger one
                runs = [max(runs, key=lambda r: r[1])]
            for side, total, a, b in runs:
                h_in, h_out = hours[a], hours[b] + 1
                cost = (sp[h_in] if side > 0 else sp[h_out]) + fixed
                if total * ref <= cost:
                    continue
                gross = side * (test_tab[h_out] / test_tab[h_in] - 1)
                net = gross - cost / test_tab[h_in]
                trades.append(pd.DataFrame({'pair': pair, 'year': y, 'side': side, 'in': h_in, 'out': h_out, 'gross': gross, 'net': net,
                                            'pips': pip(pair), 'price': test_tab[h_in], 'expected': total}).dropna())
    seen, later = np.concatenate(seen), np.concatenate(later)
    print(f'Does the pattern of one period come back in the next year? Correlation over {len(seen)} pair-hours: {np.corrcoef(seen, later)[0, 1]:+.3f} (0 = not at all, 1 = fully)')
    if not trades:
        print('No run of hours was larger than its cost in any year: nothing to trade.')
        return
    tr = pd.concat(trades)
    print('Per pair, on the years the rule never saw (per trade, in pips):')
    for pair, g in tr.groupby('pair'):
        runs = g.groupby(['year', 'side', 'in', 'out']).size()
        common = runs.groupby(level=[1, 2, 3]).size().idxmax()
        print(f'  {pair}: {len(runs)} year-runs, most often {"buy" if common[0] > 0 else "sell"} {common[1]:02d}:00-{common[2]:02d}:00 · '
              f'expected {(g["expected"] * g["price"] / g["pips"]).mean():+.2f} · before costs {line(g["gross"] * g["price"] / g["pips"])} · after costs {line(g["net"] * g["price"] / g["pips"])}')
    for name, col in (('before costs', 'gross'), ('after costs', 'net')):
        day = tr[col].groupby(level=0).mean()
        ann, vol, sharpe, t = yearly(day, 252)
        by_year = day.groupby(day.index.year).sum()
        print(f'All together, equal amounts, {name}: {len(day)} days · {ann:+.2f}%/yr of the money in the trades at {vol:.2f}% vol · Sharpe {sharpe:+.2f} (t={t:+.2f}) · '
              f'{int((by_year > 0).sum())}/{len(by_year)} years up')
    ok = sharpe >= BAR_SHARPE and t >= BAR_T
    print(f'THE BAR (Sharpe at least {BAR_SHARPE}, t at least {BAR_T}, after costs): Sharpe {sharpe:+.2f}, t {t:+.2f} -> {"REACHED" if ok else "NOT REACHED"}')


def main(hourly_folder, rates_folder, meta_path):
    data = load_hourly(hourly_folder)
    tables = {pair: clock_table(df) for pair, df in data.items()}
    until = max(df.index[-1] for df in data.values())
    rates, _ = load_rates(rates_folder, until)
    meta = pd.read_csv(meta_path, comment='#', encoding='latin-1').set_index('pair')
    # The broker's cut: half the gap between what a buyer pays and a seller receives, per year.
    cuts = [-(m['swap_long'] + m['swap_short']) / 2 * float(m['point']) / float(tables[p][FIRST_HOUR].dropna().iloc[-1]) * 365
            for p, m in meta.iterrows() if p in tables and m['swap_mode'] == 'SYMBOL_SWAP_MODE_POINTS']
    markup = float(np.median(cuts))
    print(f'{len(tables)} pairs, hourly bars {min(t.index[0] for t in tables.values()):%Y-%m} to {until:%Y-%m} · broker mark-up on interest {markup * 100:.2f}%/yr')
    triple_swap(tables, rates, markup, meta)
    time_of_day({p: t for p, t in tables.items() if t.index.year.nunique() >= 6})


if __name__ == '__main__':
    main(*sys.argv[1:4])
