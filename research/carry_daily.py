"""
Carry: hold the currencies with the highest interest rate against those with the lowest, and
collect the difference in interest every night.

This is a different source of return from predicting prices: it has decades of published
evidence (and a known weakness: it loses sharply when markets panic). The question here is the
practical one: what is left for a retail account once the broker has taken its mark-up on the
overnight financing?

Everything is fixed in advance: currencies are ranked once a month on the central-bank rate at
the end of the month before; the top K are bought and the bottom K sold in equal parts, against the US dollar.
Nothing is tuned to the data, so the whole history is an honest test.

Crash filters (added 27 November 2026, rules written down before the first run). Carry loses
most when markets panic, so three well-known ways of stepping aside are tested on the main
basket, each using only what was known the day before and each looked at once a week:
  1. smaller when the basket gets rough: size = typical roughness / current roughness, never
     above 1. Roughness is the volatility of the unfiltered basket over the past 21 trading
     days; typical is the median of that number over all history so far (at least two years).
  2. out when currencies are restless: no position while the average daily move of all
     currencies against the dollar over the past 21 days is in the top quarter of its own
     history so far.
  3. out after three losing months: no position while the unfiltered basket's result over the
     past 63 trading days is negative.
A filter earns its place only if it does better than simply holding a smaller position all the
time, so each is compared with the unfiltered basket at the filter's own average size.

Usage: python carry_daily.py <daily csv folder> <rates folder> [<MetaTrader meta.csv>]
"""
import os
import sys
import time
import urllib.request

import numpy as np
import pandas as pd

from common import cost_pips, load_daily, pip
from trend_daily import stats

# The pair that prices each currency against the US dollar.
USD_PAIR = {'EUR': 'EURUSD', 'GBP': 'GBPUSD', 'AUD': 'AUDUSD', 'NZD': 'NZDUSD', 'JPY': 'USDJPY', 'CHF': 'USDCHF', 'CAD': 'USDCAD'}
# Central-bank policy rates per currency area, monthly (Bank for International Settlements).
# They stand in for short-term market rates. One known gap: for the euro the series is the main
# refinancing rate, which stayed at 0% in 2014-2022 while market rates were about -0.5%.
AREA = {'USD': 'US', 'EUR': 'XM', 'JPY': 'JP', 'GBP': 'GB', 'CHF': 'CH', 'AUD': 'AU', 'CAD': 'CA', 'NZD': 'NZ'}
BIS_URL = 'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.' + '+'.join(AREA.values()) + '?format=csv&startPeriod=1990-01'
DEFAULT_MARKUP = 0.011   # the broker's cut on overnight financing, per year, per unit of money in a pair


def fetch_rates(folder):
    """Downloads the monthly policy rates once (a file under 30 days old is kept)."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, 'policy_rates.csv')
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 30 * 86400 and os.path.getsize(path) > 10_000:
        return
    req = urllib.request.Request(BIS_URL, headers={'user-agent': 'neonfx-research'})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode('utf-8', 'replace')
    if not body.startswith('FREQ,REF_AREA'):
        raise SystemExit('The rates download is not the expected data file: stopping')
    with open(path, 'w') as f:
        f.write(body)


def load_rates(folder, until):
    """Policy rate per currency in % per year, one row per month (the value at the end of that
    month). A currency whose series stops more than six months before the prices end is left out."""
    df = pd.read_csv(os.path.join(folder, 'policy_rates.csv'), usecols=['REF_AREA', 'TIME_PERIOD', 'OBS_VALUE'])
    df['OBS_VALUE'] = pd.to_numeric(df['OBS_VALUE'], errors='coerce')
    df['t'] = pd.to_datetime(df['TIME_PERIOD'] + '-01', utc=True)
    table = df.dropna().pivot_table(index='t', columns='REF_AREA', values='OBS_VALUE', aggfunc='last')
    out, used = {}, {}
    for ccy, area in AREA.items():
        if area not in table:
            continue
        s = table[area].dropna()
        if (until - s.index[-1]).days < 220:
            out[ccy], used[ccy] = s, f'{s.index[0]:%Y-%m} to {s.index[-1]:%Y-%m}'
        else:
            print(f'  {ccy}: rates stop at {s.index[-1]:%Y-%m}, left out')
    return pd.DataFrame(out), used


def broker_markup(meta_path, closes):
    """The broker's financing mark-up per year, read from its own swap rates: what a buyer pays
    and a seller receives differ, and half that gap is the broker's cut. Also returns what holding
    each pair pays today, in % per year."""
    meta = pd.read_csv(meta_path, comment='#', encoding='latin-1').set_index('pair')
    rows, cuts = [], []
    for pair, m in meta.iterrows():
        if m['swap_mode'] != 'SYMBOL_SWAP_MODE_POINTS' or pair not in closes:
            continue
        px = closes[pair].iloc[-1]
        yearly = lambda pts: pts * float(m['point']) / px * 365 * 100
        lo, sh = yearly(m['swap_long']), yearly(m['swap_short'])
        rows.append((pair, lo, sh))
        cuts.append(-(lo + sh) / 2 / 100)
    return (float(np.median(cuts)) if cuts else DEFAULT_MARKUP), rows


def build(closes, rates, k, shuffle=None):
    """The carry basket: per day the weight of each currency (top K bought, bottom K sold, decided
    once a month), with everything needed to work out its result."""
    ccys = [c for c in rates.columns if c == 'USD' or USD_PAIR[c] in closes]
    px = pd.DataFrame({c: closes[USD_PAIR[c]] for c in ccys if c != 'USD'}).sort_index().ffill(limit=3)
    # Value of each currency in dollars.
    usd = pd.DataFrame({c: (px[c] if USD_PAIR[c].endswith('USD') else 1 / px[c]) for c in px})
    usd['USD'] = 1.0
    spot = usd.pct_change()
    # The rate at the end of last month, known when the new month starts.
    rate = (rates[ccys].shift(1).reindex(usd.index.union(rates.index)).ffill().reindex(usd.index)) / 100
    month = usd.index.year * 12 + usd.index.month
    month_start = np.r_[True, month[1:] != month[:-1]]
    w = pd.DataFrame(np.nan, index=usd.index, columns=ccys)
    for t in usd.index[month_start]:
        ok = [c for c in ccys if not np.isnan(rate.at[t, c]) and (c == 'USD' or not np.isnan(usd.at[t, c]))]
        if len(ok) < 2 * k + 1:
            continue
        order = rate.loc[t, ok].sort_values()
        if shuffle is not None:   # placebo: the same machinery with the ranking thrown away
            order = order.sample(frac=1, random_state=shuffle)
        row = pd.Series(0.0, index=ccys)
        row[order.index[-k:]] = 1 / k
        row[order.index[:k]] = -1 / k
        w.loc[t] = row
    w = w.ffill().shift(1)   # decided on the month's first close, held from the next day
    return {
        'w': w, 'spot': spot, 'rate': rate, 'pairs': list(px.columns), 'valid': w.notna().all(axis=1),
        'usd': usd, 'ccys': ccys, 'month_start': month_start,
        'days': pd.Series(usd.index, index=usd.index).diff().dt.days.fillna(1).clip(upper=5),
        'cost_frac': pd.Series({c: cost_pips(USD_PAIR[c]) * pip(USD_PAIR[c]) for c in px}) / px,
    }


def evaluate(p, markup, exposure=None):
    """Daily returns of the basket: before costs, after trading costs, and after the broker's
    financing mark-up in the cheapest (netted through crosses) and the plain (every currency
    against the dollar) way of holding it. `exposure` (0..1 per day) is a crash filter's size."""
    w = p['w'] if exposure is None else p['w'].mul(exposure.reindex(p['w'].index).fillna(1.0), axis=0)
    days, v = p['days'], p['valid']
    gross = (w * p['spot']).sum(axis=1) + (w * p['rate']).sum(axis=1) * days / 365
    after_trading = gross - (w[p['pairs']].diff().abs() * p['cost_frac'] / 2).sum(axis=1)
    held_usd = w[p['pairs']].abs().sum(axis=1)                       # every currency against the dollar
    held_net = np.maximum(w.clip(lower=0).sum(axis=1), -w.clip(upper=0).sum(axis=1))   # paired into crosses
    return (gross[v], after_trading[v], (after_trading - held_net * markup * days / 365)[v],
            (after_trading - held_usd * markup * days / 365)[v])


def run(closes, rates, k, markup, shuffle=None):
    p = build(closes, rates, k, shuffle)
    return evaluate(p, markup) + (p['w'][p['valid']], p['rate'][p['valid']])


def crash_filters(base, spot, window=21):
    """The three filters described at the top: per day the size to hold, between 0 and 1.
    `base` is the unfiltered basket's daily result before costs. `window` is filter 1's look-back
    (21 days is the rule that was fixed in advance; other values only show how much hangs on it)."""
    weekly = pd.Series(np.arange(len(base)) % 5 == 0, index=base.index)

    def hold(signal):   # looked at once a week on the close, acted on from the next day
        return signal.where(weekly).ffill().shift(1).fillna(1.0)

    rough = base.rolling(window).std() * np.sqrt(252)
    typical = rough.expanding(min_periods=504).median()
    moves = spot.drop(columns='USD').abs().mean(axis=1).reindex(base.index).rolling(21).mean()
    top_quarter = moves.expanding(min_periods=504).quantile(0.75)
    three_months = base.rolling(63).sum()
    return {
        '1. smaller when the basket gets rough': hold((typical / rough).clip(upper=1.0)),
        '2. out when currencies are restless': hold((moves <= top_quarter).astype(float).where(top_quarter.notna())),
        '3. out after three losing months': hold((three_months >= 0).astype(float).where(three_months.notna())),
    }


def sharpe(r):
    return r.mean() * 252 / (r.std() * np.sqrt(252)) if r.std() > 0 else 0.0


def report_filters(p, markup, base_gross, base_net):
    """Each filter against no filter, and against the unfiltered basket held at the filter's
    average size all the time (the fair yardstick: a filter must beat simply betting less)."""
    year = lambda r, y: ((1 + r[r.index.year == y]).prod() - 1) * 100
    worst = lambda r: ((1 + r).cumprod() / (1 + r).cumprod().cummax() - 1).min() * 100
    periods = [(1998, 2008), (2009, 2015), (2016, 2021), (2022, 2026)]
    by_period = lambda r: ' / '.join(f'{sharpe(r[(r.index.year >= a) & (r.index.year <= b)]):+.2f}' for a, b in periods
                                     if ((r.index.year >= a) & (r.index.year <= b)).sum() > 200)
    print('\n=== CRASH FILTERS ON THE MAIN TEST · after trading costs and the mark-up (paired into crosses)')
    print(stats('no filter', base_net) + f' · 2008: {year(base_net, 2008):+.0f}%')
    print(f'    Sharpe per period: {by_period(base_net)}')
    for name, e in crash_filters(base_gross, p['spot']).items():
        gross, traded, net, _ = evaluate(p, markup, e)
        size = e.reindex(net.index).fillna(1.0)
        extra = net - size.mean() * base_net
        t = extra.mean() / (extra.std(ddof=1) / np.sqrt(len(extra)))
        print(stats(name, net) + f' · 2008: {year(net, 2008):+.0f}%')
        print(f'    Sharpe per period: {by_period(net)} · average size {size.mean() * 100:.0f}%, fully out {np.mean(size < 0.01) * 100:.0f}% of the days'
              f' · extra trading costs {(gross - traded).mean() * 252 * 100:.2f}%/yr')
        print(f'    against the unfiltered basket at {size.mean() * 100:.0f}% size all the time: {extra.mean() * 252 * 100:+.2f}%/yr (t={t:+.2f}), '
              f'worst drop {worst(net):.0f}% against {worst(size.mean() * base_net):.0f}%')
    # Not a search for the best setting: does filter 1 depend on the 21 days that were fixed in advance?
    print('filter 1 with another look-back (Sharpe, worst drop, 2008): ' + ' · '.join(
        f'{n} days {sharpe(r):+.2f}, {worst(r):.0f}%, {year(r, 2008):+.0f}%'
        for n in (10, 21, 42, 63)
        for r in [evaluate(p, markup, crash_filters(base_gross, p['spot'], n)['1. smaller when the basket gets rough'])[2]]))


def main(daily_folder, rates_folder, meta_path=None):
    data = load_daily(daily_folder)
    closes = {p: d['close'] for p, d in data.items() if len(d) > 1500}
    until = max(c.index[-1] for c in closes.values())
    fetch_rates(rates_folder)
    rates, used = load_rates(rates_folder, until)
    missing = [c for c in AREA if c not in rates.columns]
    print('Interest rates used: ' + ', '.join(f'{c} {u}' for c, u in used.items()))
    if 'USD' in missing or len(rates.columns) < 6:
        raise SystemExit(f'No usable interest rates for {missing}: stopping')
    last = rates.ffill().iloc[-1]
    print('Latest rates, % per year: ' + ' · '.join(f'{c} {last[c]:.2f}' for c in last.sort_values(ascending=False).index))
    markup, today = (broker_markup(meta_path, closes) if meta_path else (DEFAULT_MARKUP, []))
    print(f'Broker mark-up on financing: {markup * 100:.2f}% per year per unit of money in a pair' + (' (read from its swap rates)' if meta_path else ' (assumed)'))
    if today:
        print('\n=== WHAT HOLDING A PAIR PAYS TODAY AT THIS BROKER, % per year (buy / sell)')
        for pair, lo, sh in sorted(today, key=lambda r: -max(r[1], r[2])):
            print(f'  {pair}: {lo:+.2f} / {sh:+.2f}')

    for k, name in ((2, 'TOP 2 AGAINST BOTTOM 2 (the main test)'), (3, 'TOP 3 AGAINST BOTTOM 3'), (1, 'HIGHEST AGAINST LOWEST')):
        p = build(closes, rates, k)
        gross, traded, net_best, net_plain = evaluate(p, markup)
        w, rate = p['w'][p['valid']], p['rate'][p['valid']]
        ccys = list(w.columns)
        print(f'\n=== {name} · {len(ccys)} currencies ({" ".join(ccys)}), monthly')
        print(stats('before any costs', gross))
        print(stats('after trading costs', traded))
        print(stats('after the mark-up, paired into crosses', net_best))
        print(stats('after the mark-up, each against the dollar', net_plain))
        if k == 2:
            earned = ((w * rate).sum(axis=1)).mean() * 100
            turns = (w.diff().abs().sum(axis=1) > 1e-9).sum() / (len(w) / 252)
            print(f'interest difference collected: {earned:.2f}% per year on average · the basket changes about {turns:.1f} times a year')
            print('per period, after the mark-up (paired into crosses):')
            for a, b in [(1999, 2008), (2009, 2015), (2016, 2021), (2022, 2026)]:
                seg = net_best[(net_best.index.year >= a) & (net_best.index.year <= b)]
                if len(seg) > 200:
                    print(stats(f'  {a}-{b}', seg))
            now = w.iloc[-1]
            print('held now: buy ' + ' '.join(now[now > 0].index) + ' · sell ' + ' '.join(now[now < 0].index))
            # Check on the machinery: with random rankings the result must be about zero.
            rng = np.random.default_rng(3)
            fake = [run(closes, rates, k, markup, shuffle=rng)[0].mean() * 252 * 100 for _ in range(40)]
            print(f'check, 40 random rankings instead of interest rates, before costs: {np.mean(fake):+.1f}%/yr on average '
                  f'(from {np.min(fake):+.1f} to {np.max(fake):+.1f}); the real ranking: {gross.mean() * 252 * 100:+.1f}%/yr')
            report_filters(p, markup, gross, net_best)


if __name__ == '__main__':
    main(*sys.argv[1:4])
