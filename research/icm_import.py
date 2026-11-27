"""
Reads the export of mt5/NeonfxExport.mq5 (the broker's own history), checks it, and writes it in
the format the research scripts use.

    python icm_import.py <export folder> <out folder> [<yahoo hourly folder>]

Writes <out>/hourly/<PAIR>_H1_real.csv (UTC), <out>/daily/<PAIR>_D1.csv and <out>/spreads.json
(average spread in pips per hour of the broker's clock, measured from real ticks).

Broker time: MetaTrader servers of this kind keep "New York time + 7 hours", so a day ends at the
New York close (17:00 New York) and a week has five daily bars. The export records the server's
offset from UTC at that moment; the conversion is checked against it and, when a Yahoo folder is
given, by lining hourly moves up with Yahoo's (the best match must be at a shift of 0 hours, in
winter and in summer).
"""
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd

from common import PAIRS

warnings.filterwarnings('ignore', category=DeprecationWarning)


def read_meta(folder):
    with open(os.path.join(folder, 'meta.csv'), encoding='latin-1') as f:
        head = f.readline().lstrip('#').strip()
    info = dict(kv.split('=', 1) for kv in head.split(';') if '=' in kv)
    table = pd.read_csv(os.path.join(folder, 'meta.csv'), comment='#', encoding='latin-1')
    return info, table.set_index('pair')


def server_to_utc(seconds):
    """Server wall-clock seconds -> UTC timestamps, for a server that keeps New York time + 7 h."""
    wall = pd.to_datetime(np.asarray(seconds, dtype='int64'), unit='s')
    ny = (wall - pd.Timedelta(hours=7)).tz_localize('America/New_York', ambiguous='NaT', nonexistent='NaT')
    return ny.tz_convert('UTC')


def read_rates(folder, pair, tf):
    path = os.path.join(folder, f'{pair}_{tf}.csv')
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path)
    return df[(df[['open', 'high', 'low', 'close']] > 0).all(axis=1)].drop_duplicates('time').sort_values('time')


def check_bars(name, df, per_year):
    """Basic sanity: consistent bars and enough of them per year."""
    bad = ((df['high'] < df[['open', 'close']].max(axis=1)) | (df['low'] > df[['open', 'close']].min(axis=1))).mean()
    years = (df.index[-1] - df.index[0]).days / 365.25
    rate = len(df) / max(years, 1e-9)
    ok = bad < 0.001 and rate > per_year * 0.8
    print(f'  {name}: {len(df)} bars, {df.index[0]:%Y-%m-%d} to {df.index[-1]:%Y-%m-%d}, {rate:.0f}/year, '
          f'inconsistent {bad * 100:.2f}%{"" if ok else "  <-- CHECK"}')
    return ok


def lag_check(pair, icm, yahoo_folder):
    """Correlation of hourly returns with Yahoo's at shifts of -3..+3 hours, winter and summer apart."""
    path = os.path.join(yahoo_folder, f'{pair}_H1_real.csv')
    if not os.path.exists(path):
        return None
    y = pd.read_csv(path)
    y.index = pd.to_datetime(y['time'], unit='s', utc=True)
    ry = np.log(y['close']).diff()
    ri = np.log(icm['close']).diff()

    def corr(a, k):  # Yahoo's series moved k hours later in time
        return a.corr(pd.Series(ry.to_numpy(), index=ry.index + pd.Timedelta(hours=k)).reindex(a.index))

    out = {}
    for season, months in (('winter', [11, 12, 1, 2]), ('summer', [5, 6, 7, 8])):
        a = ri[ri.index.month.isin(months) & (ri.index >= ry.index[0])]
        if a.notna().sum() < 500:
            continue
        best = max(range(-3, 4), key=lambda k: corr(a, k))
        out[season] = (best, corr(a, best))
    return out


COMMISSION_USD_PER_LOT = 7.0  # raw-spread account: $3.50 per lot (100,000 units) per side


def commission_pips(pair, last):
    """The round-trip commission expressed in pips of this pair, at the latest exchange rates."""
    quote = pair[3:]
    if quote == 'USD':
        usd = 1.0
    elif f'USD{quote}' in last:
        usd = 1.0 / last[f'USD{quote}']
    elif f'{quote}USD' in last:
        usd = last[f'{quote}USD']
    else:
        return 0.7
    pip_value = 100_000 * (0.01 if quote == 'JPY' else 0.0001) * usd
    return round(COMMISSION_USD_PER_LOT / pip_value, 3)


def main(src, dst, yahoo=None):
    info, meta = read_meta(src)
    print(f"Broker {info.get('company')} · server {info.get('server')} · account {info.get('account')} · "
          f"server minus UTC now {int(info.get('server_minus_utc_seconds', 0)) / 3600:+.1f} h")
    exported = int(info['exported_server_time'])
    expected = (pd.Timestamp(exported, unit='s') - server_to_utc([exported])[0].tz_localize(None)).total_seconds()
    off = int(info.get('server_minus_utc_seconds', 0))
    if abs(expected - off) > 900:
        print(f'  !! the server is {off / 3600:+.1f} h from UTC, "New York + 7" says {expected / 3600:+.1f} h: '
              f'time conversion does not fit this broker, stopping')
        sys.exit(1)
    os.makedirs(os.path.join(dst, 'hourly'), exist_ok=True)
    os.makedirs(os.path.join(dst, 'daily'), exist_ok=True)

    problems = 0
    last = {}
    for pair in PAIRS:
        # A pair counts only once the export has listed it in meta.csv (its files are complete then).
        h1 = read_rates(src, pair, 'H1') if pair in meta.index else None
        d1 = read_rates(src, pair, 'D1') if pair in meta.index else None
        if h1 is None or d1 is None:
            print(f'{pair}: missing')
            problems += 1
            continue
        print(f'{pair} ({meta.loc[pair, "symbol"]}):')
        h1.index = server_to_utc(h1['time'])
        h1 = h1[h1.index.notna()]
        problems += not check_bars('hourly', h1, 5 * 24 * 52)
        # Daily bars keep the broker's trading day (it ends at the New York close) as their date.
        d1.index = pd.DatetimeIndex(pd.to_datetime(d1['time'], unit='s', utc=True)).normalize()
        d1 = d1[d1.index.dayofweek < 5]
        problems += not check_bars('daily', d1, 5 * 52)
        # A daily bar must be the hourly bars of its trading day put together.
        day = (h1.index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)).normalize().tz_localize('UTC')
        agg = h1.groupby(day).agg(open=('open', 'first'), high=('high', 'max'), low=('low', 'min'), close=('close', 'last'))
        both = d1.join(agg, rsuffix='_h', how='inner')
        if len(both) > 100:
            p = 0.01 if pair.endswith('JPY') else 0.0001
            diff = {c: ((both[c] - both[f'{c}_h']).abs() / p).median() for c in ('open', 'high', 'low', 'close')}
            fits = all(v < 0.5 for v in diff.values())
            problems += not fits
            print(f'  daily vs hourly on {len(both)} days: median gap in pips ' +
                  ' '.join(f'{k} {v:.2f}' for k, v in diff.items()) + ('' if fits else '  <-- CHECK'))
        if yahoo:
            lags = lag_check(pair, h1, yahoo)
            if lags:
                fits = all(k == 0 and c > 0.5 for k, c in lags.values())
                problems += not fits
                print('  lined up with Yahoo: ' + ', '.join(f'{s} best shift {k:+d} h (corr {c:.2f})' for s, (k, c) in lags.items()) +
                      ('' if fits else '  <-- CHECK'))
        last[pair] = float(h1['close'].iloc[-1])
        out = h1[['open', 'high', 'low', 'close', 'spread_points']].copy()
        out.insert(0, 'time', out.index.astype('int64') // 10 ** 9)
        out.to_csv(os.path.join(dst, 'hourly', f'{pair}_H1_real.csv'), index=False)
        outd = d1[['open', 'high', 'low', 'close']].copy()
        outd.insert(0, 'time', outd.index.astype('int64') // 10 ** 9)
        outd.to_csv(os.path.join(dst, 'daily', f'{pair}_D1.csv'), index=False)

    # Spread profile: ticks were measured per server hour; stored the same way, in pips.
    spreads = {}
    sp = pd.read_csv(os.path.join(src, 'spreads.csv'))
    for pair, g in sp.groupby('pair'):
        point = float(meta.loc[pair, 'point'])
        pip = 0.01 if pair.endswith('JPY') else 0.0001
        prof = [None] * 24  # per hour of the broker's clock, as measured
        for _, r in g.iterrows():
            prof[int(r['server_hour'])] = round(r['mean_spread_points'] * point / pip, 3)
        w = g['ticks'] / g['ticks'].sum()
        spreads[pair] = {'by_server_hour': prof, 'tick_weighted': round(float((g['mean_spread_points'] * w).sum() * point / pip), 3),
                         'commission_pips': commission_pips(pair, last)}
    with open(os.path.join(dst, 'spreads.json'), 'w') as f:
        json.dump(spreads, f, indent=1)
    print('\nPer pair, in pips: average spread (real ticks) / spread in the rollover hour / commission')
    for p, v in spreads.items():
        print(f'  {p}: {v["tick_weighted"]:.2f} / {v["by_server_hour"][0] or float("nan"):.2f} / {v["commission_pips"]:.2f}')
    swaps = meta[['swap_mode', 'swap_long', 'swap_short']]
    print('Swap per night (broker units):\n' + swaps.to_string())
    print(f'\n{"ALL CHECKS PASSED" if problems == 0 else f"{problems} CHECK(S) FAILED: look before using this data"}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
