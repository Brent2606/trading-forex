"""
Reads the export of mt5/NeonfxExportMarkets.mq5 (gold, silver, oil and stock indices from the
broker's own history), checks it, and writes it in the format the research scripts use.

    python icm_import_markets.py <export folder> <out folder>

Writes <out>/hourly/<NAME>_H1_real.csv (UTC), <out>/daily/<NAME>_D1.csv, <out>/m15/<NAME>_M15.csv
and <out>/spreads.json. Per market that file holds, in the unit named there as "pip" (an index
point, 10 cents of gold, a cent of silver or oil):
  by_server_hour       the spread per hour of the broker's clock, averaged over time
  open_by_server_hour  the spread in the first minute of each hour (what an entry on the hour pays)
  commission_pips, slip_pips, the swap per night as a share of the price, group and home session

Checks, each of which must pass before the data is used:
  - the server keeps "New York time + 7 hours" (as for currencies), also in the weeks in which
    the United States and Europe are on different sides of a clock change: the busiest hour of
    the US indices must be the one that holds the 16:30 cash open;
  - bars are consistent, and no year has far fewer hourly bars than the others;
  - a daily bar is the hourly bars of its trading day put together.
"""
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd

from common import GROUP, HOME
from icm_import import read_meta, read_rates, server_to_utc

warnings.filterwarnings('ignore', category=DeprecationWarning)

# The unit results are reported in.
PIP = {'XAUUSD': 0.1, 'XAGUSD': 0.01, 'XTIUSD': 0.01, 'XBRUSD': 0.01}
# Commission, as the broker publishes it for this account type: 7 dollars per lot round trip on metals,
# none on indices. Its pages do not say for oil: charged as for metals, to be safe.
COMMISSION_USD_PER_LOT = {'metal': 7.0, 'oil': 7.0, 'index': 0.0}
# Rough dividend yield per year, for trades held overnight: a short is charged it, a long is not
# credited it (DE40 is a total-return index: no dividends drop out of it).
DIVIDEND_YIELD = {'US500': 0.013, 'USTEC': 0.007, 'US30': 0.018, 'US2000': 0.013, 'DE40': 0.0, 'UK100': 0.035,
                  'F40': 0.03, 'STOXX50': 0.03, 'JP225': 0.018, 'AUS200': 0.04, 'HK50': 0.035}
ENTRY_HOURS = range(3, 21)      # the hours in which the tests may enter
MIN_SECONDS = 3600              # an hour counts as measured with at least this much quoted time in it
MIN_OPEN_SECONDS = 120          # and its first minute with at least this much
DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']


def true_range(df):
    pc = df['close'].shift(1)
    return pd.concat([df['high'] - df['low'], (df['high'] - pc).abs(), (df['low'] - pc).abs()], axis=1).max(axis=1)


def check_bars(name, df, kind):
    """Consistent bars, and how many there are per year."""
    bad = ((df['high'] < df[['open', 'close']].max(axis=1)) | (df['low'] > df[['open', 'close']].min(axis=1))).mean()
    per_year = df.groupby(df.index.year).size()
    full = per_year.iloc[1:-1]
    thin = [int(y) for y, n in full.items() if n < 0.6 * full.median()] if len(full) >= 3 else []
    ok = bad < 0.001 and not thin
    years = (df.index[-1] - df.index[0]).days / 365.25
    print(f'  {kind}: {len(df)} bars, {df.index[0]:%Y-%m-%d} to {df.index[-1]:%Y-%m-%d} ({years:.1f} years), '
          f'inconsistent {bad * 100:.2f}%' + (f', thin years {thin}' if thin else '') + ('' if ok else '  <-- CHECK'))
    if kind == 'hourly':
        print('    bars per year: ' + ' '.join(f"{int(y) % 100:02d}:{n}" for y, n in per_year.items()))
    return ok


def busiest_hours(raw):
    """Per hour of the server's own clock: the average range of the hourly bars, over the last three years."""
    wall = pd.to_datetime(raw['time'].to_numpy(), unit='s')
    df = raw.set_index(wall)
    df = df[df.index >= df.index[-1] - pd.Timedelta(days=3 * 365)]
    return df, (df['high'] - df['low']) / df['close']


def clock_check(name, raw):
    """The US cash market opens at 09:30 New York = 16:30 on a server that keeps New York + 7 h, all
    year. Looked at three ways: winter, summer, and the weeks in which the US and Europe are on
    different sides of a clock change (a server on European time would show the open an hour early)."""
    df, rng = busiest_hours(raw)
    utc = server_to_utc(raw['time'].to_numpy())
    utc = utc[-len(df):]
    keep = ~utc.isna()
    gap = (utc[keep].tz_convert('Europe/Berlin').tz_localize(None) - utc[keep].tz_convert('America/New_York').tz_localize(None)) / pd.Timedelta(hours=1)
    rng, hours, months = rng[keep], df.index[keep].hour, df.index[keep].month
    out, ok = [], True
    for label, mask in (('winter', np.isin(months, [12, 1, 2])), ('summer', np.isin(months, [6, 7, 8])), ('clock-change weeks', np.asarray(gap) < 5.5)):
        if mask.sum() < 200:
            out.append(f'{label}: too few bars')
            continue
        by = rng[mask].groupby(hours[mask]).mean()
        top = int(by.loc[13:19].idxmax())
        ok &= top in (16, 17)
        out.append(f'{label} busiest hour {top}:00')
    print(f'  clock: {", ".join(out)}' + ('' if ok else '  <-- CHECK (expected 16:00 or 17:00)'))
    return ok


def swap_per_night(row, price):
    """The broker's swap for one night as a share of the price (negative = paid), long and short."""
    mode, point = str(row['swap_mode']), float(row['point'])
    lng, sht = float(row['swap_long']), float(row['swap_short'])
    if mode.endswith('_POINTS'):
        return lng * point / price, sht * point / price, 'points'
    if mode.endswith('INTEREST_CURRENT') or mode.endswith('INTEREST_OPEN'):
        return lng / 100 / 360, sht / 100 / 360, 'percent a year'
    if mode.endswith('CURRENCY_SYMBOL') or mode.endswith('CURRENCY_MARGIN') or mode.endswith('CURRENCY_DEPOSIT'):
        size = float(row['contract_size'])
        return lng / size / price, sht / size / price, 'money per lot (taken as the profit currency)'
    return float('nan'), float('nan'), f'unknown mode {mode}'


def main(src, dst):
    info, meta = read_meta(src)
    print(f"Broker {info.get('company')} · server {info.get('server')} · account {info.get('account')} in {info.get('account_currency')} · "
          f"server minus UTC now {int(info.get('server_minus_utc_seconds', 0)) / 3600:+.1f} h · at most {info.get('max_bars')} bars per chart")
    exported = int(info['exported_server_time'])
    expected = (pd.Timestamp(exported, unit='s') - server_to_utc([exported])[0].tz_localize(None)).total_seconds()
    off = int(info.get('server_minus_utc_seconds', 0))
    if abs(expected - off) > 900:
        print(f'  !! the server is {off / 3600:+.1f} h from UTC, "New York + 7" says {expected / 3600:+.1f} h: '
              f'time conversion does not fit this broker, stopping')
        sys.exit(1)
    for sub in ('hourly', 'daily', 'm15'):
        os.makedirs(os.path.join(dst, sub), exist_ok=True)
    sp = pd.read_csv(os.path.join(src, 'spreads.csv'))
    ses = pd.read_csv(os.path.join(src, 'sessions.csv'))

    problems = 0
    profile = {}
    for name in GROUP:
        if name not in meta.index:
            print(f'{name}: not in the export (the broker does not offer it under a known name)')
            continue
        row = meta.loc[name]
        raw = read_rates(src, name, 'H1')
        d1 = read_rates(src, name, 'D1')
        m15 = read_rates(src, name, 'M15')
        if raw is None or d1 is None or len(raw) < 1000:
            print(f'{name}: no usable history')
            problems += 1
            continue
        print(f'{name} ({row["symbol"]}, {row["description"]}; {row["path"]}; quoted in {row["currency_profit"]}, lot {float(row["contract_size"]):g}):')
        h1 = raw.copy()
        h1.index = server_to_utc(h1['time'])
        h1 = h1[h1.index.notna()]
        problems += not check_bars(name, h1, 'hourly')
        d1.index = pd.DatetimeIndex(pd.to_datetime(d1['time'], unit='s', utc=True)).normalize()
        d1 = d1[d1.index.dayofweek < 5]
        problems += not check_bars(name, d1, 'daily')
        # A daily bar must be the hourly bars of its trading day put together.
        day = (h1.index.tz_convert('America/New_York').tz_localize(None) + pd.Timedelta(hours=7)).normalize().tz_localize('UTC')
        agg = h1.groupby(day).agg(open=('open', 'first'), high=('high', 'max'), low=('low', 'min'), close=('close', 'last'))
        both = d1.join(agg, rsuffix='_h', how='inner')
        typical = float((h1['high'] - h1['low']).tail(5000).median())
        if len(both) > 100:
            diff = {c: (both[c] - both[f'{c}_h']).abs().median() / typical for c in ('open', 'high', 'low', 'close')}
            share = ((both['close'] - both['close_h']).abs() < 0.25 * typical).mean()
            fits = all(v < 0.05 for v in diff.values()) and share > 0.9
            problems += not fits
            print(f'  daily vs hourly on {len(both)} days: median gap as a share of an hourly range ' +
                  ' '.join(f'{k} {v:.3f}' for k, v in diff.items()) + f', closes agree on {share * 100:.0f}% of days' + ('' if fits else '  <-- CHECK'))
        if name in ('US500', 'USTEC', 'US30'):
            problems += not clock_check(name, raw)
        else:
            _, rng = busiest_hours(raw)
            by = rng.groupby(rng.index.hour).mean()
            print(f'  busiest hours on the server clock: ' + ', '.join(f'{int(h)}:00' for h in by.sort_values(ascending=False).index[:3]))
        # Bars that jump far more than the market moves: bad ticks or real shocks, listed to be looked at.
        tr = true_range(h1)
        base = tr.rolling(500, min_periods=100).median().shift(1)
        wild = h1[(h1['close'].diff().abs() > 25 * base)]
        if len(wild):
            print(f'  {len(wild)} hourly closes moved more than 25 x the usual range: ' + ', '.join(f'{t:%Y-%m-%d %H:%M}' for t in wild.index[:8]) + (' ...' if len(wild) > 8 else ''))

        point = float(row['point'])
        unit = PIP.get(name, 1.0)
        g = sp[sp['pair'] == name].set_index('server_hour')
        during = [None] * 24
        at_open = [None] * 24
        for hr, r in g.iterrows():
            if r['seconds'] >= MIN_SECONDS and np.isfinite(r['time_spread_points']):
                during[int(hr)] = round(float(r['time_spread_points']) * point / unit, 4)
            if r['open_seconds'] >= MIN_OPEN_SECONDS and np.isfinite(r['open_spread_points']):
                at_open[int(hr)] = round(float(r['open_spread_points']) * point / unit, 4)
        if not g.empty and any(v is not None for v in during):
            day_hours = [during[h] for h in ENTRY_HOURS if during[h] is not None]
            average = float(np.mean(day_hours)) if day_hours else float(np.nanmean([v for v in during if v is not None]))
            price = float(row['bid']) if float(row['bid']) > 0 else float(h1['close'].iloc[-1])
            swap_l, swap_s, swap_unit = swap_per_night(row, price)
            lot = float(row['contract_size'])
            commission = COMMISSION_USD_PER_LOT[GROUP[name]] / lot / unit if lot > 0 else 0.0
            three = str(row['swap_3day']).upper()
            hours = ses[(ses['pair'] == name) & (ses['kind'] == 'trade')]
            profile[name] = {
                'pip': unit, 'group': GROUP[name], 'home': list(HOME[name]),
                'by_server_hour': during, 'open_by_server_hour': at_open,
                'tick_weighted': round(float((g['mean_spread_points'] * g['ticks']).sum() / g['ticks'].sum() * point / unit), 4),
                'average_spread': round(average, 4),
                'commission_pips': round(commission, 4), 'slip_pips': round(0.5 * average, 4),
                'swap_long_rate': swap_l, 'swap_short_rate': swap_s,
                'swap_3day': DAYS.index(three) if three in DAYS else 2,
                'dividend_yield': DIVIDEND_YIELD.get(name, 0.0),
                'years': round((h1.index[-1] - h1.index[0]).days / 365.25, 2),
            }
            closed = [h for h in range(24) if during[h] is None]
            print(f'  spread in {unit:g}: day average {average:.3f} (per tick {profile[name]["tick_weighted"]:.3f}) · on the hour, hours 3-20: ' +
                  ' '.join('-' if at_open[h] is None else f'{at_open[h]:.2f}' for h in ENTRY_HOURS) +
                  (f' · no quotes in hours {closed}' if closed else ''))
            print(f'  commission {commission:.3f}, slippage {0.5 * average:.3f} per round trip · swap per night as a share of the price: '
                  f'long {swap_l * 1e4:+.3f}, short {swap_s * 1e4:+.3f} per 10,000 ({swap_unit}; = {swap_l * 365 * 100:+.1f}% / {swap_s * 365 * 100:+.1f}% a year), three nights on {three.title()}')
            if not hours.empty:
                mon = hours[hours['day_of_week'] == 1]
                fri = hours[hours['day_of_week'] == 5]
                fmt = lambda x: ' '.join(f"{int(a) // 3600:02d}:{int(a) % 3600 // 60:02d}-{int(b) // 3600:02d}:{int(b) % 3600 // 60:02d}" for a, b in zip(x['from_seconds'], x['to_seconds']))
                print(f'  trading hours (server clock): Monday {fmt(mon)} · Friday {fmt(fri)}')
        else:
            print('  no spread measurement: this market cannot be tested  <-- CHECK')
            problems += 1
        out = h1[['open', 'high', 'low', 'close', 'spread_points', 'tick_volume']].copy()
        out.insert(0, 'time', out.index.astype('int64') // 10 ** 9)
        out.to_csv(os.path.join(dst, 'hourly', f'{name}_H1_real.csv'), index=False)
        outd = d1[['open', 'high', 'low', 'close']].copy()
        outd.insert(0, 'time', outd.index.astype('int64') // 10 ** 9)
        outd.to_csv(os.path.join(dst, 'daily', f'{name}_D1.csv'), index=False)
        if m15 is not None and len(m15) > 1000:
            m15.index = server_to_utc(m15['time'])
            m15 = m15[m15.index.notna()]
            outm = m15[['open', 'high', 'low', 'close', 'spread_points', 'tick_volume']].copy()
            outm.insert(0, 'time', outm.index.astype('int64') // 10 ** 9)
            outm.to_csv(os.path.join(dst, 'm15', f'{name}_M15.csv'), index=False)
            print(f'  quarter-hour bars: {len(m15)} from {m15.index[0]:%Y-%m-%d}')

    with open(os.path.join(dst, 'spreads.json'), 'w') as f:
        json.dump(profile, f, indent=1)
    print(f'\n{len(profile)} markets written to {dst}')
    print(f'{"ALL CHECKS PASSED" if problems == 0 else f"{problems} CHECK(S) FAILED: look before using this data"}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
