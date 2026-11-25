import { describe, expect, it } from 'vitest';
import { checkAlerts, inferCondition, validateAlert, type PriceAlert } from '../src/core/alerts';
import { correlationMatrix, currencyStrength, pearson } from '../src/core/analytics';
import { parseCommand } from '../src/core/command';
import { parseCsv, parseDateTime, symbolFromFilename } from '../src/core/csv';
import { money, moneySigned, pct, pips, ratio } from '../src/core/format';
import { getInstrument, INSTRUMENTS, lotsToUnits, normalizeSymbol, unitsToLots } from '../src/core/instruments';
import { convert, marginRequired, pipValuePerLot } from '../src/core/rates';
import { lotsForRisk, previewTrade } from '../src/core/risk';
import { technicalSummary, verdictFor } from '../src/core/signals';
import { bySymbol, computeStats } from '../src/core/stats';
import { FakeMarket, fromCloses } from './helpers';

describe('instruments', () => {
  it('pip sizes and digits', () => {
    expect(getInstrument('EURUSD')).toMatchObject({ pip: 0.0001, digits: 5 });
    expect(getInstrument('GBPJPY')).toMatchObject({ pip: 0.01, digits: 3 });
    expect(INSTRUMENTS).toHaveLength(16);
  });
  it('normalises symbols', () => {
    expect(normalizeSymbol('eur/usd')).toBe('EURUSD');
    expect(normalizeSymbol('GBP_JPY')).toBe('GBPJPY');
    expect(normalizeSymbol('usdeur')).toBeUndefined();
  });
  it('lots <-> units', () => {
    expect(lotsToUnits(0.01)).toBe(1000);
    expect(lotsToUnits(1.23)).toBe(123_000);
    expect(lotsToUnits(0.07)).toBe(7000);
    expect(unitsToLots(7000)).toBe(0.07);
  });
});

describe('conversion, pip value, margin', () => {
  const m = new FakeMarket();
  it('converts directly, inversely and through USD', () => {
    expect(convert(100, 'EUR', 'USD', m.mid)).toBeCloseTo(110.005, 9);
    expect(convert(150.005, 'JPY', 'USD', m.mid)).toBeCloseTo(1, 9);
    expect(convert(100, 'GBP', 'JPY', m.mid)).toBeCloseTo(100 * 1.30005 * 150.005, 6);
    expect(convert(5, 'USD', 'USD', m.mid)).toBe(5);
  });
  it('pip value per lot', () => {
    expect(pipValuePerLot(getInstrument('EURUSD'), m.mid)).toBe(10);
    expect(pipValuePerLot(getInstrument('USDJPY'), m.mid)).toBeCloseTo(1000 / 150.005, 9);
    expect(pipValuePerLot(getInstrument('EURGBP'), m.mid)).toBeCloseTo(10 * 1.30005, 9);
  });
  it('margin', () => {
    expect(marginRequired(getInstrument('USDCHF'), 100_000, 50, m.mid)).toBe(2000);
    expect(marginRequired(getInstrument('EURJPY'), 100_000, 100, m.mid)).toBeCloseTo(1100.05, 6);
  });
});

describe('position sizing', () => {
  it('risk-based lots round down and include commission', () => {
    // $100 risk, 20 pips × $10 + $7 commission per lot = $207/lot -> 0.48 lots
    expect(lotsForRisk({ equity: 10_000, riskPct: 1, slPips: 20, pipValuePerLot: 10, commissionPerLotRoundTrip: 7 })).toBe(0.48);
    expect(lotsForRisk({ equity: 10_000, riskPct: 2, slPips: 20, pipValuePerLot: 10, commissionPerLotRoundTrip: 0 })).toBe(1);
    expect(lotsForRisk({ equity: 100, riskPct: 0.5, slPips: 50, pipValuePerLot: 10, commissionPerLotRoundTrip: 7 })).toBe(0);
    expect(lotsForRisk({ equity: 10_000, riskPct: 1, slPips: 0, pipValuePerLot: 10, commissionPerLotRoundTrip: 7 })).toBe(0);
  });
  it('previews a trade', () => {
    const m = new FakeMarket();
    const p = previewTrade({
      inst: getInstrument('EURUSD'),
      side: 'buy',
      units: 50_000,
      entry: 1.1001,
      slPips: 20,
      tpPips: 40,
      equity: 10_000,
      leverage: 30,
      commissionPerLotSide: 3.5,
      mid: m.mid,
    });
    expect(p.slPrice).toBeCloseTo(1.0981, 10);
    expect(p.tpPrice).toBeCloseTo(1.1041, 10);
    expect(p.pipValue).toBe(5);
    expect(p.commission).toBe(3.5);
    expect(p.riskUsd).toBeCloseTo(103.5, 9);
    expect(p.rewardUsd).toBeCloseTo(196.5, 9);
    expect(p.rr).toBeCloseTo(196.5 / 103.5, 9);
    expect(p.riskPct).toBeCloseTo(1.035, 9);
  });
});

describe('stats', () => {
  const trades = [100, -50, 30, -20].map((net, i) => ({ net, closeTime: i, symbol: i % 2 ? 'EURUSD' : 'GBPUSD', r: net / 50 }));
  const s = computeStats(trades, 10_000);
  it('core figures', () => {
    expect(s.trades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBe(0.5);
    expect(s.net).toBe(60);
    expect(s.profitFactor).toBeCloseTo(130 / 70, 12);
    expect(s.avgWin).toBe(65);
    expect(s.avgLoss).toBe(35);
    expect(s.expectancy).toBe(15);
    expect(s.maxDrawdown).toBe(50);
    expect(s.maxDrawdownPct).toBeCloseTo((50 / 10_100) * 100, 9);
    expect(s.largestLoss).toBe(-50);
    expect(s.avgR).toBeCloseTo(0.3, 12);
    expect(s.curve).toEqual([10_000, 10_100, 10_050, 10_080, 10_060]);
  });
  it('edge cases', () => {
    expect(Number.isNaN(computeStats([], 1000).profitFactor)).toBe(true);
    expect(computeStats([{ net: 5, closeTime: 1 }], 1000).profitFactor).toBe(Infinity);
  });
  it('by symbol', () => {
    const b = bySymbol(trades);
    expect(b[0]).toMatchObject({ symbol: 'GBPUSD', trades: 2, net: 130 });
  });
});

describe('technical summary', () => {
  it('thresholds', () => {
    expect(verdictFor(0.6)).toBe('STRONG BUY');
    expect(verdictFor(0.2)).toBe('BUY');
    expect(verdictFor(0)).toBe('NEUTRAL');
    expect(verdictFor(-0.2)).toBe('SELL');
    expect(verdictFor(-0.5)).toBe('STRONG SELL');
  });
  it('reads trends', () => {
    const up = fromCloses(Array.from({ length: 260 }, (_, i) => 1 + i * 0.0005 + Math.sin(i) * 0.0003));
    const down = fromCloses(Array.from({ length: 260 }, (_, i) => 2 - i * 0.0005 + Math.sin(i) * 0.0003));
    expect(technicalSummary(up).score).toBeGreaterThan(0.1);
    expect(technicalSummary(down).score).toBeLessThan(-0.1);
    expect(technicalSummary(up).movingAverages).toHaveLength(10);
    expect(technicalSummary(up).oscillators).toHaveLength(7);
  });
  it('is neutral without enough data', () => {
    const s = technicalSummary(fromCloses([1, 1.1]));
    expect(s.movingAverages.every((m) => m.action === 'NEUTRAL')).toBe(true);
  });
});

describe('analytics', () => {
  it('pearson', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
  it('currency strength', () => {
    const series: Record<string, ReturnType<typeof fromCloses>> = {
      EURUSD: fromCloses([1, 1.01]),
      USDJPY: fromCloses([100, 100]),
    };
    const s = currencyStrength(
      [getInstrument('EURUSD'), getInstrument('USDJPY')],
      (sym) => series[sym],
      1,
    );
    expect(s.EUR).toBeCloseTo(1, 9);
    expect(s.USD).toBeCloseTo(-0.5, 9);
    expect(s.JPY).toBeCloseTo(0, 9);
  });
  it('correlation matrix aligns on time', () => {
    const a = fromCloses([1, 1.1, 1.05, 1.2, 1.1, 1.3]);
    const b = fromCloses([2, 2.2, 2.1, 2.4, 2.2, 2.6]);
    const m = correlationMatrix(['A', 'B'], (s) => (s === 'A' ? a : b), 10);
    expect(m[0][0]).toBe(1);
    expect(m[0][1]).toBeCloseTo(1, 2);
  });
});

describe('alerts', () => {
  it('validates and fires on the bid', () => {
    const m = new FakeMarket();
    expect(inferCondition(1.2, 1.1)).toBe('above');
    expect(validateAlert('above', 1.09, 1.1)).toMatch(/already/);
    const alerts: PriceAlert[] = [
      { id: 1, symbol: 'EURUSD', cond: 'above', price: 1.101, createdAt: 0, triggeredAt: null },
      { id: 2, symbol: 'EURUSD', cond: 'below', price: 1.09, createdAt: 0, triggeredAt: null },
    ];
    expect(checkAlerts(alerts, m.quote, 1)).toHaveLength(0);
    m.set('EURUSD', 1.101);
    const fired = checkAlerts(alerts, m.quote, 2);
    expect(fired.map((a) => a.id)).toEqual([1]);
    expect(checkAlerts(alerts, m.quote, 3)).toHaveLength(0);
  });
});

describe('format', () => {
  it('money', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(-12.3)).toBe('-$12.30');
    expect(money(-0.001)).toBe('$0.00');
    expect(moneySigned(5)).toBe('+$5.00');
    expect(moneySigned(-5)).toBe('-$5.00');
    expect(pct(1.234, 2, true)).toBe('+1.23%');
    expect(pips(-3.04)).toBe('-3.0');
    expect(ratio(Infinity)).toBe('∞');
  });
});

describe('command line', () => {
  it('market orders', () => {
    expect(parseCommand('buy eurusd 0.5 sl 20 tp 40')).toEqual({
      kind: 'order',
      side: 'buy',
      type: 'market',
      symbol: 'EURUSD',
      lots: 0.5,
      slPips: 20,
      tpPips: 40,
    });
    expect(parseCommand('SELL GBP/JPY 1% sl=30 tp=60 trail 15')).toMatchObject({
      side: 'sell',
      symbol: 'GBPJPY',
      riskPct: 1,
      slPips: 30,
      tpPips: 60,
      trailPips: 15,
    });
    expect(parseCommand('buy')).toEqual({ kind: 'order', side: 'buy', type: 'market' });
    expect(parseCommand('long eurusd 2lots')).toMatchObject({ side: 'buy', lots: 2 });
  });
  it('pending orders', () => {
    expect(parseCommand('buy limit eurusd 0.2 @1.0800 sl 15')).toMatchObject({
      type: 'limit',
      price: 1.08,
      lots: 0.2,
      slPips: 15,
    });
    expect(parseCommand('sellstop usdjpy 1 @ 149.5')).toMatchObject({ side: 'sell', type: 'stop', price: 149.5 });
    expect(parseCommand('buy limit eurusd 0.2').kind).toBe('error');
    expect(parseCommand('buy eurusd 0.2 @1.08').kind).toBe('error');
    expect(parseCommand('buy eurusd 1 1%').kind).toBe('error');
    expect(parseCommand('buy eurusd sl').kind).toBe('error');
  });
  it('position management', () => {
    expect(parseCommand('close all')).toEqual({ kind: 'close', target: 'all' });
    expect(parseCommand('close #1004')).toEqual({ kind: 'close', target: { id: 1004 } });
    expect(parseCommand('close eurusd')).toEqual({ kind: 'close', target: { symbol: 'EURUSD' } });
    expect(parseCommand('close losers')).toEqual({ kind: 'close', target: 'losers' });
    expect(parseCommand('be all')).toEqual({ kind: 'breakeven', target: 'all' });
    expect(parseCommand('cancel 1007')).toEqual({ kind: 'cancel', target: { id: 1007 } });
    expect(parseCommand('rev 1004')).toEqual({ kind: 'reverse', id: 1004 });
    expect(parseCommand('flatten')).toEqual({ kind: 'close', target: 'all' });
  });
  it('chart, alert, risk, reset', () => {
    expect(parseCommand('chart gbpusd h4')).toEqual({ kind: 'chart', symbol: 'GBPUSD', tf: 'H4' });
    expect(parseCommand('m15')).toEqual({ kind: 'chart', symbol: undefined, tf: 'M15' });
    expect(parseCommand('eurjpy')).toEqual({ kind: 'chart', symbol: 'EURJPY', tf: undefined });
    expect(parseCommand('alert eurusd > 1.0850')).toEqual({ kind: 'alert', symbol: 'EURUSD', cond: 'above', price: 1.085 });
    expect(parseCommand('alert 1.05')).toEqual({ kind: 'alert', symbol: undefined, cond: undefined, price: 1.05 });
    expect(parseCommand('risk 1.5%')).toEqual({ kind: 'risk', pct: 1.5 });
    expect(parseCommand('reset')).toEqual({ kind: 'reset', confirmed: false, balance: undefined });
    expect(parseCommand('reset 25,000 confirm')).toEqual({ kind: 'reset', confirmed: true, balance: 25_000 });
    expect(parseCommand('nonsense').kind).toBe('error');
    expect(parseCommand('').kind).toBe('error');
  });
});

describe('CSV import', () => {
  it('parses date formats', () => {
    const t = Date.UTC(2024, 0, 2, 13, 45);
    expect(parseDateTime('2024.01.02', '13:45')).toBe(t);
    expect(parseDateTime('2024-01-02 13:45:00')).toBe(t);
    expect(parseDateTime('2024-01-02T13:45:00Z')).toBe(t);
    expect(parseDateTime('2024-01-02T15:45:00+02:00')).toBe(t);
    expect(parseDateTime('02.01.2024 13:45:00.000')).toBe(t);
    expect(parseDateTime('02.01.2024 15:45:00.000 GMT+0200')).toBe(t);
    expect(parseDateTime('20240102 134500')).toBe(t);
    expect(parseDateTime(String(t / 1000))).toBe(t);
    expect(parseDateTime(String(t))).toBe(t);
    expect(parseDateTime('01/15/2024')).toBe(Date.UTC(2024, 0, 15));
    expect(parseDateTime('2024-02-31')).toBeNull();
    expect(parseDateTime('hello')).toBeNull();
  });

  it('MetaTrader 4 (no header)', () => {
    const r = parseCsv('2024.01.02,00:00,1.10372,1.10418,1.10328,1.10388,1029\n2024.01.02,01:00,1.10388,1.10500,1.10300,1.10450,900\n', 'EURUSD60.csv');
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]).toEqual({ t: Date.UTC(2024, 0, 2, 0), o: 1.10372, h: 1.10418, l: 1.10328, c: 1.10388, v: 1029 });
    expect(r.symbol).toBe('EURUSD');
    expect(r.pip).toBe(0.0001);
    expect(r.barMs).toBe(3_600_000);
  });

  it('MetaTrader 5 (tab separated, header)', () => {
    const text =
      '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n' +
      '2024.01.02\t00:00:00\t141.000\t141.200\t140.900\t141.100\t500\t0\t8\n' +
      '2024.01.02\t00:15:00\t141.100\t141.300\t141.050\t141.250\t400\t0\t8\n';
    const r = parseCsv(text, 'USDJPY_M15.csv');
    expect(r.candles).toHaveLength(2);
    expect(r.candles[1].c).toBe(141.25);
    expect(r.symbol).toBe('USDJPY');
    expect(r.pip).toBe(0.01);
    expect(r.barMs).toBe(900_000);
  });

  it('Dukascopy', () => {
    const r = parseCsv('Gmt time,Open,High,Low,Close,Volume\n01.01.2024 22:00:00.000,1.10,1.11,1.09,1.105,12.5\n01.01.2024 23:00:00.000,1.105,1.12,1.10,1.11,10\n');
    expect(r.candles[0].t).toBe(Date.UTC(2024, 0, 1, 22));
    expect(r.candles).toHaveLength(2);
  });

  it('HistData (semicolon, no header)', () => {
    const r = parseCsv('20240102 000000;1.103720;1.104180;1.103280;1.103880;0\n20240102 000100;1.103880;1.104000;1.103800;1.103900;0\n', 'DAT_ASCII_GBPUSD_M1_2024.csv');
    expect(r.candles).toHaveLength(2);
    expect(r.symbol).toBe('GBPUSD');
    expect(r.barMs).toBe(60_000);
  });

  it('TradingView (epoch seconds)', () => {
    const r = parseCsv('time,open,high,low,close\n1704153600,1.1,1.2,1.0,1.15\n1704157200,1.15,1.25,1.1,1.2\n');
    expect(r.candles[0].t).toBe(1704153600_000);
  });

  it('skips invalid rows, sorts and de-duplicates', () => {
    const r = parseCsv(
      'date,open,high,low,close\n2024-01-03,1,1.2,0.9,1.1\n2024-01-02,1,1.2,0.9,1.1\nbad,row,,,\n2024-01-04,1,0.5,0.9,1.1\n2024-01-03,1,1.3,0.9,1.2\n',
    );
    expect(r.candles.map((c) => c.t)).toEqual([Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3)]);
    expect(r.candles[1].h).toBe(1.3);
    expect(r.skipped).toBe(3);
  });

  it('errors clearly', () => {
    expect(() => parseCsv('')).toThrow(/empty/);
    expect(() => parseCsv('a,b,c\n1,2,3\n')).toThrow(/columns/);
  });

  it('symbol from file name', () => {
    expect(symbolFromFilename('EURUSD_H1.csv')).toBe('EURUSD');
    expect(symbolFromFilename('eur-jpy daily.csv')).toBe('EURJPY');
    expect(symbolFromFilename('prices.csv')).toBeNull();
  });
});
