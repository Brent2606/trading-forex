import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD,
  DEFAULT_SETTINGS,
  freshState,
  parseState,
  TradingEngine,
  type EngineEvent,
  type Position,
} from '../src/core/account';
import { HOUR } from '../src/core/time';
import { FakeMarket } from './helpers';

const NO_GUARD = { ...DEFAULT_GUARD, enabled: false };
const NO_COMM = { ...DEFAULT_SETTINGS, commissionPerLot: 0 };

function setup(opts: { guard?: typeof DEFAULT_GUARD; settings?: typeof DEFAULT_SETTINGS } = {}) {
  const m = new FakeMarket();
  const e = new TradingEngine(freshState(opts.settings ?? NO_COMM, opts.guard ?? NO_GUARD), m);
  const events: EngineEvent[] = [];
  e.on((ev) => events.push(ev));
  e.onTick();
  return { m, e, events };
}

function open(e: TradingEngine, req: Parameters<TradingEngine['submit']>[0]): Position {
  const r = e.submit(req);
  if (!r.ok) throw new Error(r.error);
  return r.value as Position;
}

describe('market orders', () => {
  it('buys at the ask and sells at the bid', () => {
    const { e } = setup();
    const b = open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market' });
    const s = open(e, { symbol: 'EURUSD', side: 'sell', units: 100_000, type: 'market' });
    expect(b.entry).toBe(1.1001);
    expect(s.entry).toBe(1.1);
  });

  it('a round trip at the same quote costs exactly the spread', () => {
    const { e } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market' });
    const r = e.close(p.id);
    expect(r.ok && r.value.net).toBe(-10); // 1 pip × $10
    expect(e.state.balance).toBe(9990);
  });

  it('computes USD P/L on a USD-quoted pair', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market' });
    m.set('EURUSD', 1.1011); // bid 10 pips above entry ask
    expect(e.floating(p)).toBeCloseTo(100, 6);
    expect(e.floatingPips(p)).toBeCloseTo(10, 6);
    const r = e.close(p.id);
    expect(r.ok && r.value.net).toBe(100);
    expect(r.ok && r.value.pips).toBe(10);
  });

  it('converts JPY P/L at the current USDJPY rate', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'USDJPY', side: 'buy', units: 100_000, type: 'market' });
    expect(p.entry).toBe(150.01);
    m.set('USDJPY', 150.51);
    // 0.5 JPY × 100,000 = 50,000 JPY at mid 150.515
    expect(e.floating(p)).toBeCloseTo(50_000 / 150.515, 6);
  });

  it('converts crosses through USD (EURGBP -> GBP -> USD)', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURGBP', side: 'sell', units: 200_000, type: 'market' });
    m.set('EURGBP', p.entry - 0.0021); // ask 20 pips below the short entry
    const gbp = 200_000 * 0.002;
    expect(e.floating(p)).toBeCloseTo(gbp * 1.30005, 6);
  });

  it('charges commission per side', () => {
    const { e } = setup({ settings: { ...DEFAULT_SETTINGS, commissionPerLot: 3.5 } });
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 200_000, type: 'market' });
    expect(e.state.balance).toBe(10_000 - 7);
    const r = e.close(p.id);
    expect(r.ok && r.value.commission).toBe(14);
    expect(r.ok && r.value.net).toBe(-20 - 14);
    expect(e.state.balance).toBe(10_000 - 34);
  });

  it('rejects bad sizes', () => {
    const { e } = setup();
    for (const units of [0, 500, 1500, 100_000.5, 6_000_000]) {
      expect(e.submit({ symbol: 'EURUSD', side: 'buy', units, type: 'market' }).ok).toBe(false);
    }
    expect(e.submit({ symbol: 'XXXYYY', side: 'buy', units: 1000, type: 'market' }).ok).toBe(false);
  });

  it('rejects a stop inside the spread', () => {
    const { m, e } = setup();
    m.set('EURUSD', 1.1, 2);
    const r = e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('margin', () => {
  it('requires notional / leverage', () => {
    const { e } = setup();
    open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market' });
    const m = e.metrics();
    expect(m.margin).toBeCloseTo((100_000 * 1.10005) / 30, 6);
    expect(m.freeMargin).toBeCloseTo(m.equity - m.margin, 9);
    expect(m.marginLevel).toBeCloseTo((m.equity / m.margin) * 100, 9);
  });

  it('USD-base pairs need units / leverage', () => {
    const { e } = setup();
    open(e, { symbol: 'USDJPY', side: 'sell', units: 30_000, type: 'market' });
    expect(e.metrics().margin).toBeCloseTo(1000, 9);
  });

  it('rejects orders without enough free margin', () => {
    const { e } = setup();
    const r = e.submit({ symbol: 'EURUSD', side: 'buy', units: 300_000, type: 'market' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/free margin/);
  });

  it('stops out the worst position below the stop-out level', () => {
    const { e, m, events } = setup();
    const a = open(e, { symbol: 'EURUSD', side: 'buy', units: 200_000, type: 'market' });
    const b = open(e, { symbol: 'GBPUSD', side: 'buy', units: 10_000, type: 'market' });
    m.set('EURUSD', 1.0605); // ~ -$9,900 floating on 2 lots
    e.onTick();
    expect(e.state.positions.find((p) => p.id === a.id)).toBeUndefined();
    expect(e.state.positions.find((p) => p.id === b.id)).toBeDefined();
    const closed = events.find((ev) => ev.type === 'close');
    expect(closed && closed.type === 'close' && closed.trade.reason).toBe('stopout');
  });
});

describe('stops, targets and trailing', () => {
  it('long SL triggers on the bid', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20, tpPips: 40 });
    expect(p.sl).toBe(1.0981);
    expect(p.tp).toBe(1.1041);
    m.set('EURUSD', 1.0982);
    e.onTick();
    expect(e.state.positions).toHaveLength(1);
    m.set('EURUSD', 1.0981);
    e.onTick();
    expect(e.state.positions).toHaveLength(0);
    expect(e.state.history[0].reason).toBe('sl');
    expect(e.state.history[0].exit).toBe(1.0981);
    expect(e.state.history[0].r).toBeCloseTo(-1, 6);
  });

  it('long TP triggers on the bid', () => {
    const { e, m } = setup();
    open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20, tpPips: 40 });
    m.set('EURUSD', 1.1041);
    e.onTick();
    expect(e.state.history[0].reason).toBe('tp');
    expect(e.state.history[0].net).toBe(40);
    expect(e.state.history[0].r).toBeCloseTo(2, 6);
  });

  it('short SL / TP trigger on the ask', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'sell', units: 10_000, type: 'market', slPips: 10, tpPips: 10 });
    expect(p.entry).toBe(1.1);
    expect(p.sl).toBe(1.101);
    expect(p.tp).toBe(1.099);
    m.set('EURUSD', 1.0989); // ask 1.0990 -> TP
    e.onTick();
    expect(e.state.history[0].reason).toBe('tp');
    expect(e.state.history[0].exit).toBe(1.099);
  });

  it('a gap through the stop fills at the market price', () => {
    const { e, m } = setup();
    open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20 });
    m.set('EURUSD', 1.09);
    e.onTick();
    expect(e.state.history[0].exit).toBe(1.09);
    expect(e.state.history[0].pips).toBeCloseTo(-101, 6);
  });

  it('trailing stop follows the bid and only moves up', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', trailPips: 10 });
    expect(p.sl).toBe(1.099);
    m.set('EURUSD', 1.105);
    e.onTick();
    expect(p.sl).toBe(1.104);
    m.set('EURUSD', 1.1045);
    e.onTick();
    expect(p.sl).toBe(1.104);
    m.set('EURUSD', 1.104);
    e.onTick();
    expect(e.state.history[0].reason).toBe('trail');
    expect(e.state.history[0].net).toBeCloseTo(39, 6); // 1.1001 -> 1.1040 on 0.1 lot
  });

  it('tracks excursions', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market' });
    m.set('EURUSD', 1.1021);
    e.onTick();
    m.set('EURUSD', 1.0991);
    e.onTick();
    expect(p.mfe).toBeCloseTo(20, 6);
    expect(p.mae).toBeCloseTo(-10, 6);
  });

  it('modify validates sides', () => {
    const { e } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market' });
    expect(e.modify(p.id, { sl: 1.1005 }).ok).toBe(false);
    expect(e.modify(p.id, { tp: 1.0995 }).ok).toBe(false);
    expect(e.modify(p.id, { sl: 1.095, tp: 1.11 }).ok).toBe(true);
    expect(p.sl).toBe(1.095);
  });

  it('break-even requires profit', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20 });
    expect(e.breakEven(p.id).ok).toBe(false);
    m.set('EURUSD', 1.102);
    expect(e.breakEven(p.id).ok).toBe(true);
    expect(p.sl).toBe(p.entry);
  });
});

describe('partial close and reverse', () => {
  it('closes part of a position with proportional commission', () => {
    const { e, m } = setup({ settings: { ...DEFAULT_SETTINGS, commissionPerLot: 4 } });
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market', slPips: 20 });
    m.set('EURUSD', 1.1021);
    const r = e.close(p.id, 40_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.units).toBe(40_000);
    expect(r.value.gross).toBe(80);
    expect(r.value.commission).toBe(3.2); // 1.6 open share + 1.6 close
    expect(p.units).toBe(60_000);
    expect(p.openCommission).toBe(2.4);
    expect(e.close(p.id, 70_000).ok).toBe(false);
  });

  it('reverses a position', () => {
    const { e } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20, tpPips: 30 });
    const r = e.reverse(p.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.side).toBe('sell');
    expect(r.value.units).toBe(10_000);
    expect(r.value.sl).toBe(1.102);
    expect(e.state.history[0].reason).toBe('reverse');
  });
});

describe('pending orders', () => {
  it('validates price vs market', () => {
    const { e } = setup();
    const bad = [
      { side: 'buy', type: 'limit', price: 1.102 },
      { side: 'buy', type: 'stop', price: 1.099 },
      { side: 'sell', type: 'limit', price: 1.099 },
      { side: 'sell', type: 'stop', price: 1.101 },
    ] as const;
    for (const b of bad) expect(e.submit({ symbol: 'EURUSD', units: 1000, ...b }).ok).toBe(false);
    const good = [
      { side: 'buy', type: 'limit', price: 1.099 },
      { side: 'buy', type: 'stop', price: 1.102 },
      { side: 'sell', type: 'limit', price: 1.102 },
      { side: 'sell', type: 'stop', price: 1.099 },
    ] as const;
    for (const g of good) expect(e.submit({ symbol: 'EURUSD', units: 1000, ...g }).ok).toBe(true);
  });

  it('buy limit fills at the ask when the ask reaches the price, with stops from the fill', () => {
    const { e, m } = setup();
    e.submit({ symbol: 'EURUSD', side: 'buy', type: 'limit', price: 1.095, units: 10_000, slPips: 10, tpPips: 20 });
    m.set('EURUSD', 1.095);
    e.onTick();
    expect(e.state.positions).toHaveLength(0);
    m.set('EURUSD', 1.0949);
    e.onTick();
    expect(e.state.orders).toHaveLength(0);
    const p = e.state.positions[0];
    expect(p.entry).toBe(1.095);
    expect(p.sl).toBe(1.094);
    expect(p.tp).toBe(1.097);
  });

  it('sell stop fills when the bid drops to the price', () => {
    const { e, m } = setup();
    e.submit({ symbol: 'EURUSD', side: 'sell', type: 'stop', price: 1.098, units: 10_000 });
    m.set('EURUSD', 1.098);
    e.onTick();
    expect(e.state.positions[0].entry).toBe(1.098);
  });

  it('cancels', () => {
    const { e } = setup();
    const r = e.submit({ symbol: 'EURUSD', side: 'buy', type: 'limit', price: 1.09, units: 1000 });
    expect(r.ok && e.cancelOrder(r.value.id).ok).toBe(true);
    expect(e.state.orders).toHaveLength(0);
  });
});

describe('risk guard', () => {
  it('requires a stop loss', () => {
    const { e } = setup({ guard: DEFAULT_GUARD });
    const r = e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market' });
    expect(r.ok).toBe(false);
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 10 }).ok).toBe(true);
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', trailPips: 10 }).ok).toBe(true);
  });

  it('caps risk per trade', () => {
    const { e } = setup({ guard: { ...DEFAULT_GUARD, maxRiskPct: 1 } });
    // 1 lot × 20 pips = $200 = 2% of 10k
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market', slPips: 20 }).ok).toBe(false);
    // 0.5 lots × 20 pips = $100 = 1%
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 50_000, type: 'market', slPips: 20 }).ok).toBe(true);
  });

  it('limits the number of positions', () => {
    const { e } = setup({ guard: { ...DEFAULT_GUARD, maxPositions: 2 } });
    const req = { symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 10 } as const;
    expect(e.submit(req).ok).toBe(true);
    expect(e.submit(req).ok).toBe(true);
    expect(e.submit(req).ok).toBe(false);
  });

  it('locks trading after the daily loss limit, until the next trading day', () => {
    const { e, m, events } = setup({ guard: { ...DEFAULT_GUARD, dailyLossPct: 2, maxRiskPct: 10, autoFlatten: true } });
    open(e, { symbol: 'EURUSD', side: 'buy', units: 100_000, type: 'market', slPips: 50 });
    m.set('EURUSD', 1.0981); // -$200 floating = -2%
    e.onTick();
    expect(e.state.day.locked).toBe(true);
    expect(e.state.positions).toHaveLength(0);
    expect(events.some((ev) => ev.type === 'guard-lock')).toBe(true);
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 10 }).ok).toBe(false);
    m.t += 24 * HOUR;
    e.onTick();
    expect(e.state.day.locked).toBe(false);
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 10 }).ok).toBe(true);
  });
});

describe('market hours', () => {
  it('rejects market orders and manual closes while the market is closed', () => {
    const { e, m } = setup();
    const p = open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20 });
    let open_ = false;
    (m as unknown as { isOpen: () => boolean }).isOpen = () => open_;
    const r = e.submit({ symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/closed/);
    expect(e.close(p.id).ok).toBe(false);
    expect(e.submit({ symbol: 'EURUSD', side: 'buy', type: 'limit', price: 1.09, units: 1000, slPips: 10 }).ok).toBe(true);
    expect(e.modify(p.id, { tp: 1.12 }).ok).toBe(true);
    open_ = true;
    expect(e.close(p.id).ok).toBe(true);
  });
});

describe('persistence', () => {
  let e: TradingEngine;
  beforeEach(() => {
    e = setup().e;
  });
  it('round-trips through JSON', () => {
    open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 10 });
    const parsed = parseState(JSON.parse(JSON.stringify(e.state)));
    expect(parsed).toEqual(e.state);
  });
  it('rejects garbage', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState({ version: 2 })).toBeNull();
    expect(parseState({ ...e.state, positions: [{ id: 1, symbol: 'NOPE', side: 'buy', units: 1, entry: 1 }] })).toBeNull();
  });
  it('reset restores the starting balance', () => {
    open(e, { symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market' });
    e.reset(25_000);
    expect(e.state.balance).toBe(25_000);
    expect(e.state.positions).toHaveLength(0);
    expect(e.state.settings.startBalance).toBe(25_000);
  });
});
