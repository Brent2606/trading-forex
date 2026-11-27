"""
Can the carry result be improved with two other well-documented currency "styles"?

  value         buy the currencies that have become cheap and sell those that have become dear,
                measured over five years and corrected for inflation (purchasing power)
  dollar carry  buy all other currencies against the US dollar while their interest rates are on
                average above the American rate, otherwise sell them all

Rules, fixed before the first run (27 November 2026):
  - carry: as in carry_daily.py (top 2 against bottom 2 on the central-bank rate, monthly).
  - value: once a month, rank the currencies on how much their real value in dollars has
    changed against its own average of 4.5 to 5.5 years ago (the change in the exchange rate
    plus the difference in consumer-price inflation; price indices are used three months late).
    Buy the 2 that fell most, sell the 2 that rose most.
  - dollar carry: once a month; all other currencies in equal parts against the dollar, the whole
    account on each side, bought when their average rate is above the US rate and sold otherwise.
  - the candidate for the bot: the three in equal parts, with the one crash filter that worked
    for carry (smaller when the basket gets rough, 21 days).
  - the bar, set in advance: the candidate is worth building into the bot only if, after trading
    costs and this broker's financing mark-up, its Sharpe ratio is at least 0.5 on both data sets
    and its result is positive in all periods but at most one.
Everything else that is printed is there to understand the result, not to pick a winner.

Usage: python fx_styles.py <daily csv folder> <rates folder> [<MetaTrader meta.csv>]
"""
import os
import sys
import time
import urllib.request

import numpy as np
import pandas as pd

from carry_daily import AREA, DEFAULT_MARKUP, broker_markup, build, crash_filters, evaluate, fetch_rates, load_rates, sharpe
from common import load_daily
from trend_daily import stats

CPI_URL = 'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LONG_CPI/1.0/M.' + '+'.join(AREA.values()) + '.628?format=csv&startPeriod=1985-01'
PERIODS = [(1998, 2008), (2009, 2015), (2016, 2021), (2022, 2026)]
BAR = 0.5
FILTER = '1. smaller when the basket gets rough'


def load_cpi(folder):
    """Consumer price index per currency area, monthly (Bank for International Settlements)."""
    path = os.path.join(folder, 'consumer_prices.csv')
    if not (os.path.exists(path) and time.time() - os.path.getmtime(path) < 30 * 86400 and os.path.getsize(path) > 10_000):
        req = urllib.request.Request(CPI_URL, headers={'user-agent': 'neonfx-research'})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode('utf-8', 'replace')
        if not body.startswith('FREQ,REF_AREA'):
            raise SystemExit('The price-index download is not the expected data file: stopping')
        with open(path, 'w') as f:
            f.write(body)
    df = pd.read_csv(path, usecols=['REF_AREA', 'TIME_PERIOD', 'OBS_VALUE'])
    df['OBS_VALUE'] = pd.to_numeric(df['OBS_VALUE'], errors='coerce')
    df['t'] = pd.to_datetime(df['TIME_PERIOD'] + '-01', utc=True)
    table = df.dropna().pivot_table(index='t', columns='REF_AREA', values='OBS_VALUE', aggfunc='last')
    return table.rename(columns={v: k for k, v in AREA.items()})


def ranked(p, score, k=2):
    """Top k bought and bottom k sold in equal parts, decided on each month's first close on
    `score` (higher = buy) and held from the next day."""
    usd, ccys = p['usd'], p['ccys']
    w = pd.DataFrame(np.nan, index=usd.index, columns=ccys)
    for t in usd.index[p['month_start']]:
        ok = [c for c in ccys if not np.isnan(score.at[t, c]) and not np.isnan(usd.at[t, c])]
        if len(ok) < 2 * k + 1:
            continue
        order = score.loc[t, ok].sort_values()
        row = pd.Series(0.0, index=ccys)
        row[order.index[-k:]] = 1 / k
        row[order.index[:k]] = -1 / k
        w.loc[t] = row
    return w.ffill().shift(1)


def value_score(p, cpi=None):
    """How far each currency's value in dollars lies below its own average of 4.5-5.5 years ago,
    in real terms when price indices are given (they are used three months late)."""
    usd = p['usd']
    real = np.log(usd)
    if cpi is not None:
        c = np.log(cpi[p['ccys']].shift(3).reindex(usd.index.union(cpi.index)).ffill().reindex(usd.index))
        real = real + c.sub(c['USD'], axis=0)
    return -(real - real.rolling(252, min_periods=200).mean().shift(1134))


def dollar_weights(p):
    """All other currencies in equal parts against the dollar: bought while their average rate is
    above the US rate, sold otherwise. Decided on each month's first close."""
    usd, rate, ccys = p['usd'], p['rate'], p['ccys']
    w = pd.DataFrame(np.nan, index=usd.index, columns=ccys)
    for t in usd.index[p['month_start']]:
        ok = [c for c in ccys if c != 'USD' and not np.isnan(rate.at[t, c]) and not np.isnan(usd.at[t, c])]
        if len(ok) < 3 or np.isnan(rate.at[t, 'USD']):
            continue
        side = 1.0 if rate.loc[t, ok].mean() > rate.at[t, 'USD'] else -1.0
        row = pd.Series(0.0, index=ccys)
        row[ok] = side / len(ok)
        row['USD'] = -side
        w.loc[t] = row
    return w.ffill().shift(1)


def result(p, w, markup, exposure=None):
    """(before costs, after trading costs and the mark-up) for a table of weights."""
    q = dict(p, w=w, valid=w.notna().all(axis=1))
    gross, _, net, _ = evaluate(q, markup, exposure)
    return gross, net


def by_period(r):
    out = []
    for a, b in PERIODS:
        seg = r[(r.index.year >= a) & (r.index.year <= b)]
        if len(seg) >= 252:
            out.append((f'{max(a, seg.index[0].year)}-{b}', sharpe(seg), seg.mean() * 252 * 100))
    return out


def main(daily_folder, rates_folder, meta_path=None):
    data = load_daily(daily_folder)
    closes = {s: d['close'] for s, d in data.items() if len(d) > 1500}
    until = max(c.index[-1] for c in closes.values())
    fetch_rates(rates_folder)
    rates, _ = load_rates(rates_folder, until)
    cpi = load_cpi(rates_folder)
    markup, _ = (broker_markup(meta_path, closes) if meta_path else (DEFAULT_MARKUP, []))
    p = build(closes, rates, 2)
    styles = {
        'carry': p['w'],
        'value (purchasing power)': ranked(p, value_score(p, cpi)),
        'dollar carry': dollar_weights(p),
    }
    both = (styles['carry'] + styles['value (purchasing power)']) / 2
    three = sum(styles.values()) / 3
    start = three.dropna().index[0]
    since = lambda r: r[r.index >= start]
    print(f'{len(p["ccys"])} currencies ({" ".join(p["ccys"])}) · broker mark-up {markup * 100:.2f}%/yr · all three styles exist from {start:%Y-%m}; every line below covers that period')

    print('\n=== EACH STYLE ON ITS OWN · after trading costs and the mark-up')
    gross = {}
    for name, w in list(styles.items()) + [('value without the inflation correction', ranked(p, value_score(p)))]:
        g, n = result(p, w, markup)
        gross[name] = since(g)
        print(stats(name, since(n)) + ' · before costs ' + f'{sharpe(since(g)):+.2f}')
    names = list(styles)
    print('how alike they are (correlation of daily results): ' + ' · '.join(
        f'{a} / {b} {gross[a].corr(gross[b]):+.2f}' for i, a in enumerate(names) for b in names[i + 1:]))

    print('\n=== TOGETHER · after trading costs and the mark-up')
    g2, n2 = result(p, both, markup)
    print(stats('carry + value, half each', since(n2)) + ' · before costs ' + f'{sharpe(since(g2)):+.2f}')
    g3, n3 = result(p, three, markup)
    print(stats('all three, a third each', n3) + ' · before costs ' + f'{sharpe(g3):+.2f}')
    size = crash_filters(g3, p['spot'])[FILTER]
    gc, nc = result(p, three, markup, size)
    worst = ((1 + nc).cumprod() / (1 + nc).cumprod().cummax() - 1).min() * 100
    print(stats('THE CANDIDATE: all three + crash filter', nc) + ' · before costs ' + f'{sharpe(gc):+.2f}')
    periods = by_period(nc)
    print('    per period (Sharpe, % per year): ' + ' · '.join(f'{name} {s:+.2f}, {y:+.1f}%' for name, s, y in periods))
    _, cheap = result(p, three, 0.003, size)
    print(f'    if the broker took 0.3% a year instead of {markup * 100:.1f}%: {cheap.mean() * 252 * 100:+.1f}%/yr, Sharpe {sharpe(cheap):+.2f}')
    held = three.dropna().iloc[-1]
    print('    held now: ' + ' '.join(f'{c} {v * 100:+.0f}%' for c, v in held.items() if abs(v) > 0.005) + f' · size {size.iloc[-1] * 100:.0f}%')

    up = sum(1 for _, _, y in periods if y > 0)
    ok = sharpe(nc) >= BAR and up >= len(periods) - 1
    print(f'\nTHE BAR (Sharpe at least {BAR} after all costs, positive in all periods but at most one): '
          f'Sharpe {sharpe(nc):+.2f}, positive in {up} of {len(periods)} periods, worst drop {worst:.0f}% -> {"REACHED" if ok else "NOT REACHED"} on this data set')


if __name__ == '__main__':
    main(*sys.argv[1:4])
