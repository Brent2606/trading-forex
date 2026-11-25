import { describe, expect, it } from 'vitest';
import { defaultParams, runBacktest, STRATEGIES, type BacktestConfig, type Strategy } from '../src/core/backtest';
import { FALLBACK_RATES } from '../src/core/instruments';
import { MarketSim } from '../src/core/market';
import { bar } from './helpers';

/** A strategy that fires fixed signals at given bar indices. */
function scripted(sig: Record<number, 1 | -1>): Strategy {
  return {
    id: 'scripted',
    name: 'Scripted',
    blurb: '',
    params: [],
    signals: (c) => {
      const out = new Int8Array(c.length);
      for (const [i, s] of Object.entries(sig)) out[Number(i)] = s;
      return out;
    },
  };
}

const H = 3_600_000;
function flat(n: number, price = 1.1, range = 0.001) {
  return Array.from({ length: n }, (_, i) => bar(i * H, price, price + range / 2, price - range / 2, price));
}

function cfg(over: Partial<BacktestConfig>): BacktestConfig {
  return {
    candles: [],
    strategy: scripted({}),
    params: {},
    pip: 0.0001,
    spreadPips: 1,
    commissionPerLot: 0,
    startBalance: 10_000,
    riskPct: 1,
    fixedLots: 1,
    slAtr: 0,
    tpAtr: 0,
    exitOnOpposite: true,
    allowLong: true,
    allowShort: true,
    trendFilter: 0,
    leverage: 100,
    quoteToUsd: () => 1,
    ...over,
  };
}

describe('backtest engine', () => {
  it('enters on the NEXT bar open (no look-ahead) and pays the spread', () => {
    const c = flat(30);
    c[21] = bar(21 * H, 1.105, 1.1055, 1.1045, 1.105);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: 1 }) }));
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryIdx).toBe(21);
    expect(t.entry).toBeCloseTo(1.105 + 0.0001, 10);
    expect(t.reason).toBe('end');
    expect(t.exitIdx).toBe(29);
    // exit at 1.1 bid: (1.1 - 1.1051) × 100,000 = -510
    expect(t.net).toBeCloseTo(-510, 6);
  });

  it('exits on the opposite signal at the next open and reverses', () => {
    const c = flat(30);
    c[16] = bar(16 * H, 1.101, 1.1015, 1.1005, 1.101);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 10: 1, 15: -1 }) }));
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]).toMatchObject({ side: 'buy', entryIdx: 11, exitIdx: 16, reason: 'signal' });
    expect(r.trades[0].exit).toBeCloseTo(1.101, 10);
    expect(r.trades[1]).toMatchObject({ side: 'sell', entryIdx: 16 });
    expect(r.trades[1].entry).toBeCloseTo(1.101, 10);
  });

  it('assumes the stop is hit first when a bar touches stop and target', () => {
    const c = flat(30, 1.1, 0.0002); // ATR ≈ 0.0002 (ATR(14) is valid from bar 13)
    c[22] = bar(22 * H, 1.1, 1.11, 1.09, 1.1);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: 1 }), slAtr: 5, tpAtr: 5 }));
    expect(r.trades[0].reason).toBe('sl');
  });

  it('fills a gap through the stop at the open', () => {
    const c = flat(30, 1.1, 0.0002);
    c[23] = bar(23 * H, 1.09, 1.0905, 1.0895, 1.09);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: 1 }), slAtr: 5 }));
    expect(r.trades[0].reason).toBe('sl');
    expect(r.trades[0].exit).toBe(1.09);
    expect(r.trades[0].exitIdx).toBe(23);
  });

  it('applies stop slippage, bounded by the bar, and fills gaps at the open', () => {
    const c = flat(30, 1.1, 0.0002); // ATR ≈ 0.0002
    c[22] = bar(22 * H, 1.1, 1.1001, 1.0980, 1.0985);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: 1 }), slAtr: 5, stopSlipAtr: 1 }));
    const t = r.trades[0];
    expect(t.reason).toBe('sl');
    const sl = t.entry - 5 * 0.0002;
    expect(t.exit).toBeCloseTo(sl - 0.0002, 6); // one ATR worse than the stop
    const tight = flat(30, 1.1, 0.0002);
    tight[22] = bar(22 * H, 1.1, 1.1001, 1.0989, 1.0995);
    const r2 = runBacktest(cfg({ candles: tight, strategy: scripted({ 20: 1 }), slAtr: 5, stopSlipAtr: 50 }));
    expect(r2.trades[0].exit).toBe(1.0989); // never worse than the bar's low
  });

  it('sizes positions from risk and the ATR stop', () => {
    const c = flat(40, 1.1, 0.002);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: 1 }), slAtr: 1, riskPct: 1 }));
    // ATR = 0.002 (no gaps), stop 0.002, risk $100 -> 50,000 units
    expect(r.trades[0].units).toBe(50_000);
  });

  it('shorts fill at the bid and exit at the ask; TP hit', () => {
    const c = flat(40, 1.1, 0.0002);
    c[25] = bar(25 * H, 1.1, 1.1, 1.0, 1.0);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 20: -1 }), slAtr: 10, tpAtr: 10 }));
    const t = r.trades[0];
    expect(t.side).toBe('sell');
    expect(t.entry).toBe(1.1);
    expect(t.reason).toBe('tp');
    expect(t.exit).toBeCloseTo(1.1 - 0.002, 10);
  });

  it('respects the trend filter and direction switches', () => {
    const c = flat(60);
    const r1 = runBacktest(cfg({ candles: c, strategy: scripted({ 30: 1 }), allowLong: false }));
    expect(r1.trades).toHaveLength(0);
    const falling = Array.from({ length: 60 }, (_, i) => {
      const p = 1.2 - i * 0.001;
      return bar(i * H, p + 0.001, p + 0.0012, p - 0.0002, p);
    });
    const blocked = runBacktest(cfg({ candles: falling, strategy: scripted({ 30: 1 }), trendFilter: 10 }));
    expect(blocked.trades).toHaveLength(0); // long below a falling EMA
    const allowed = runBacktest(cfg({ candles: falling, strategy: scripted({ 30: -1 }), trendFilter: 10 }));
    expect(allowed.trades).toHaveLength(1);
    expect(allowed.trades[0].side).toBe('sell');
  });

  it('equity curve starts at the start balance and ends at the final balance', () => {
    const c = flat(30);
    const r = runBacktest(cfg({ candles: c, strategy: scripted({ 5: 1, 15: -1 }) }));
    expect(r.equity[0]).toBe(10_000);
    const finalBal = 10_000 + r.trades.reduce((a, t) => a + t.net, 0);
    expect(r.equity[r.equity.length - 1]).toBeCloseTo(finalBal, 6);
    expect(r.returnPct).toBeCloseTo(((finalBal - 10_000) / 10_000) * 100, 6);
  });

  it('runs every built-in strategy on simulated data', () => {
    const sim = new MarketSim({ rates: FALLBACK_RATES, source: 'builtin', label: 't' }, Date.UTC(2026, 10, 25, 12), 3);
    const candles = sim.candles.EURUSD.H1;
    for (const s of STRATEGIES) {
      const r = runBacktest(
        cfg({ candles, strategy: s, params: defaultParams(s), slAtr: 2, tpAtr: 3, commissionPerLot: 3.5, spreadPips: 0.6 }),
      );
      expect(r.equity.length).toBe(candles.length);
      expect(r.trades.length).toBeGreaterThan(5);
      for (const t of r.trades) expect(t.exitIdx).toBeGreaterThanOrEqual(t.entryIdx);
      for (const t of r.trades) expect(t.entryIdx).toBeGreaterThan(0);
      expect(Number.isFinite(r.stats.net)).toBe(true);
    }
  });
});
