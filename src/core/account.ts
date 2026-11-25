import { getInstrument, LOT_UNITS, MAX_LOTS, MIN_UNITS, roundPrice, type Instrument } from './instruments';
import { marginRequired, pipValuePerLot, profitUsd, type MidLookup, type Quote } from './rates';
import { riskUsdFor } from './risk';
import { tradingDayKey } from './time';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type CloseReason = 'manual' | 'sl' | 'tp' | 'trail' | 'stopout' | 'guard' | 'reverse' | 'signal';

export interface Position {
  id: number;
  symbol: string;
  side: Side;
  units: number;
  entry: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  trailPips: number | null;
  /** Stop / target distances (pips) requested at entry. */
  slPips: number | null;
  tpPips: number | null;
  /** True once a trailing stop has moved the stop loss. */
  trailed: boolean;
  /** Opening commission still attributable to the open units (already debited). */
  openCommission: number;
  /** Money at risk at entry (stop distance + round-trip commission), for R multiples. */
  initialRisk: number | null;
  /** Maximum favourable / adverse excursion in pips. */
  mfe: number;
  mae: number;
  /** Pending order this position came from, if any. */
  fromOrder: number | null;
}

export interface PendingOrder {
  id: number;
  symbol: string;
  side: Side;
  type: 'limit' | 'stop';
  price: number;
  units: number;
  slPips: number | null;
  tpPips: number | null;
  trailPips: number | null;
  createdAt: number;
}

export interface ClosedTrade {
  id: number;
  positionId: number;
  symbol: string;
  side: Side;
  units: number;
  entry: number;
  exit: number;
  openTime: number;
  closeTime: number;
  pips: number;
  gross: number;
  commission: number;
  net: number;
  reason: CloseReason;
  /** Net result in multiples of initial risk, when a stop was set at entry. */
  r: number | null;
  mfe: number;
  mae: number;
}

export interface AccountSettings {
  startBalance: number;
  leverage: number;
  /** Commission per lot per side, account currency. */
  commissionPerLot: number;
  /** Positions are closed when margin level falls below this (%). */
  stopOutLevel: number;
  marginCallLevel: number;
}

export interface GuardSettings {
  enabled: boolean;
  requireStopLoss: boolean;
  /** Max money at risk per trade, % of equity. */
  maxRiskPct: number;
  /** Lock trading for the rest of the trading day after losing this % (0 = off). */
  dailyLossPct: number;
  /** Max open positions + pending orders. */
  maxPositions: number;
  /** Close everything when the daily loss limit is hit. */
  autoFlatten: boolean;
}

export interface DayState {
  key: number;
  startEquity: number;
  locked: boolean;
  lockReason: string;
  trades: number;
}

export interface AccountState {
  version: 1;
  balance: number;
  nextId: number;
  positions: Position[];
  orders: PendingOrder[];
  history: ClosedTrade[];
  settings: AccountSettings;
  guard: GuardSettings;
  day: DayState;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  units: number;
  type: OrderType;
  /** Required for limit / stop orders. */
  price?: number;
  slPips?: number | null;
  tpPips?: number | null;
  trailPips?: number | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type EngineEvent =
  | { type: 'open'; position: Position }
  | { type: 'close'; trade: ClosedTrade }
  | { type: 'order'; order: PendingOrder }
  | { type: 'cancel'; order: PendingOrder; reason: string }
  | { type: 'modify'; position: Position }
  | { type: 'margin-call'; level: number }
  | { type: 'guard-lock'; reason: string }
  | { type: 'reset' };

export interface MarketView {
  quote(symbol: string): Quote | undefined;
  mid: MidLookup;
  now(): number;
  /** False while the FX market is closed (weekend). Omit for an always-open market. */
  isOpen?(): boolean;
}

export const MARKET_CLOSED = 'The FX market is closed for the weekend. It reopens Sunday 17:00 New York time';

export interface AccountMetrics {
  balance: number;
  equity: number;
  floating: number;
  margin: number;
  freeMargin: number;
  /** Equity / margin × 100, or Infinity with no open positions. */
  marginLevel: number;
  dayPnl: number;
  dayPnlPct: number;
}

export const DEFAULT_SETTINGS: AccountSettings = {
  startBalance: 10_000,
  leverage: 30,
  commissionPerLot: 3.5,
  stopOutLevel: 50,
  marginCallLevel: 100,
};

export const DEFAULT_GUARD: GuardSettings = {
  enabled: true,
  requireStopLoss: true,
  maxRiskPct: 2,
  dailyLossPct: 5,
  maxPositions: 10,
  autoFlatten: false,
};

const HISTORY_CAP = 2000;
const cents = (v: number) => Math.round(v * 100) / 100;

export function freshState(settings: AccountSettings = DEFAULT_SETTINGS, guard: GuardSettings = DEFAULT_GUARD): AccountState {
  return {
    version: 1,
    balance: settings.startBalance,
    nextId: 1001,
    positions: [],
    orders: [],
    history: [],
    settings: { ...settings },
    guard: { ...guard },
    day: { key: -1, startEquity: settings.startBalance, locked: false, lockReason: '', trades: 0 },
  };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validates persisted state. Returns null when it cannot be trusted. */
export function parseState(raw: unknown): AccountState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as AccountState;
  if (s.version !== 1 || !isNum(s.balance) || !isNum(s.nextId)) return null;
  if (!Array.isArray(s.positions) || !Array.isArray(s.orders) || !Array.isArray(s.history)) return null;
  if (!s.settings || !isNum(s.settings.leverage) || !isNum(s.settings.startBalance)) return null;
  for (const p of s.positions) {
    if (!p || !isNum(p.id) || !isNum(p.units) || !isNum(p.entry) || (p.side !== 'buy' && p.side !== 'sell')) return null;
    try {
      getInstrument(p.symbol);
    } catch {
      return null;
    }
  }
  for (const o of s.orders) {
    if (!o || !isNum(o.id) || !isNum(o.units) || !isNum(o.price)) return null;
    try {
      getInstrument(o.symbol);
    } catch {
      return null;
    }
  }
  return {
    ...s,
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    guard: { ...DEFAULT_GUARD, ...(s.guard ?? {}) },
    day: s.day && isNum(s.day.key) ? s.day : { key: -1, startEquity: s.balance, locked: false, lockReason: '', trades: 0 },
  };
}

function validPips(v: number | null | undefined, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (!isNum(v) || v <= 0) return `${name} must be a positive number of pips`;
  if (v > 10_000) return `${name} is too far away`;
  return null;
}

export class TradingEngine {
  state: AccountState;
  private readonly market: MarketView;
  private readonly listeners: ((e: EngineEvent) => void)[] = [];
  private marginCallActive = false;

  constructor(state: AccountState, market: MarketView) {
    this.state = state;
    this.market = market;
  }

  on(fn: (e: EngineEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: EngineEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  // ---------------------------------------------------------------- metrics

  /** Current exit price of a position: bid for longs, ask for shorts. */
  exitPrice(p: { symbol: string; side: Side }): number {
    const q = this.market.quote(p.symbol);
    if (!q) throw new Error(`No quote for ${p.symbol}`);
    return p.side === 'buy' ? q.bid : q.ask;
  }

  floating(p: Position): number {
    return profitUsd(getInstrument(p.symbol), p.side, p.units, p.entry, this.exitPrice(p), this.market.mid);
  }

  floatingPips(p: Position): number {
    const inst = getInstrument(p.symbol);
    const dir = p.side === 'buy' ? 1 : -1;
    return ((this.exitPrice(p) - p.entry) * dir) / inst.pip;
  }

  metrics(): AccountMetrics {
    const { balance, settings, positions, day } = this.state;
    let floating = 0;
    let margin = 0;
    for (const p of positions) {
      floating += this.floating(p);
      margin += marginRequired(getInstrument(p.symbol), p.units, settings.leverage, this.market.mid);
    }
    const equity = balance + floating;
    const dayPnl = day.key === -1 ? 0 : equity - day.startEquity;
    return {
      balance,
      equity,
      floating,
      margin,
      freeMargin: equity - margin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : Infinity,
      dayPnl,
      dayPnlPct: day.startEquity > 0 ? (dayPnl / day.startEquity) * 100 : 0,
    };
  }

  // ---------------------------------------------------------------- orders

  /** Checks applied to every new order and to pending orders when they trigger. */
  private preTradeChecks(inst: Instrument, req: OrderRequest): string | null {
    const g = this.state.guard;
    if (!g.enabled) return null;
    if (this.state.day.locked) return `Risk guard: trading locked for today (${this.state.day.lockReason})`;
    const stop = req.slPips ?? req.trailPips ?? null;
    if (g.requireStopLoss && !stop) return 'Risk guard: a stop loss (or trailing stop) is required';
    if (stop && g.maxRiskPct > 0) {
      const eq = this.metrics().equity;
      const risk = riskUsdFor(req.units, stop, pipValuePerLot(inst, this.market.mid), this.state.settings.commissionPerLot);
      const pct = (risk / eq) * 100;
      if (pct > g.maxRiskPct + 1e-9) {
        return `Risk guard: this trade risks ${pct.toFixed(2)}% of equity (limit ${g.maxRiskPct}%). Reduce size or tighten the stop`;
      }
    }
    return null;
  }

  /** Stop/target prices for a fill at the current quote, or an error if the stop sits inside the spread. */
  private stopsFor(inst: Instrument, req: OrderRequest, q: Quote): Result<{ entry: number; sl: number | null; tp: number | null }> {
    const buy = req.side === 'buy';
    const entry = buy ? q.ask : q.bid;
    const dir = buy ? 1 : -1;
    let sl = req.slPips ? roundPrice(entry - dir * req.slPips * inst.pip, inst.digits) : null;
    const tp = req.tpPips ? roundPrice(entry + dir * req.tpPips * inst.pip, inst.digits) : null;
    if (sl !== null && (buy ? sl >= q.bid : sl <= q.ask)) {
      return { ok: false, error: `Stop loss is inside the spread (${q.spread.toFixed(1)} pips). Widen it` };
    }
    if (req.trailPips) {
      // A trailing stop trails the exit price (bid for longs, ask for shorts) from the start.
      const trail = roundPrice(buy ? q.bid - req.trailPips * inst.pip : q.ask + req.trailPips * inst.pip, inst.digits);
      if (sl === null || (buy ? trail > sl : trail < sl)) sl = trail;
    }
    return { ok: true, value: { entry, sl, tp } };
  }

  submit(req: OrderRequest): Result<Position | PendingOrder> {
    let inst: Instrument;
    try {
      inst = getInstrument(req.symbol);
    } catch {
      return { ok: false, error: `Unknown pair ${req.symbol}` };
    }
    const q = this.market.quote(req.symbol);
    if (!q) return { ok: false, error: `No price for ${req.symbol}` };
    if (!Number.isInteger(req.units) || req.units < MIN_UNITS || req.units % MIN_UNITS !== 0) {
      return { ok: false, error: 'Size must be a multiple of 0.01 lots (minimum 0.01)' };
    }
    if (req.units > MAX_LOTS * LOT_UNITS) return { ok: false, error: `Maximum size is ${MAX_LOTS} lots` };
    for (const [v, n] of [
      [req.slPips, 'Stop loss'],
      [req.tpPips, 'Take profit'],
      [req.trailPips, 'Trailing stop'],
    ] as const) {
      const err = validPips(v, n);
      if (err) return { ok: false, error: err };
    }
    const g = this.state.guard;
    if (g.enabled && this.state.positions.length + this.state.orders.length >= g.maxPositions) {
      return { ok: false, error: `Risk guard: max ${g.maxPositions} open positions/orders` };
    }

    if (req.type === 'market') {
      if (this.market.isOpen && !this.market.isOpen()) return { ok: false, error: MARKET_CLOSED };
      const err = this.preTradeChecks(inst, req);
      if (err) return { ok: false, error: err };
      return this.openPosition(inst, req, q, null);
    }

    const price = req.price;
    if (!isNum(price) || price <= 0) return { ok: false, error: 'Enter a valid order price' };
    const px = roundPrice(price, inst.digits);
    const valid =
      req.type === 'limit' ? (req.side === 'buy' ? px < q.ask : px > q.bid) : req.side === 'buy' ? px > q.ask : px < q.bid;
    if (!valid) {
      const rel = (req.type === 'limit') === (req.side === 'buy') ? 'below' : 'above';
      const ref = req.side === 'buy' ? 'ask' : 'bid';
      return { ok: false, error: `A ${req.side} ${req.type} must be ${rel} the current ${ref}` };
    }
    const err = this.preTradeChecks(inst, req);
    if (err) return { ok: false, error: err };
    const order: PendingOrder = {
      id: this.state.nextId++,
      symbol: inst.symbol,
      side: req.side,
      type: req.type,
      price: px,
      units: req.units,
      slPips: req.slPips ?? null,
      tpPips: req.tpPips ?? null,
      trailPips: req.trailPips ?? null,
      createdAt: this.market.now(),
    };
    this.state.orders.push(order);
    this.emit({ type: 'order', order });
    return { ok: true, value: order };
  }

  private openPosition(inst: Instrument, req: OrderRequest, q: Quote, fromOrder: number | null): Result<Position> {
    const stops = this.stopsFor(inst, req, q);
    if (!stops.ok) return stops;
    const { entry, sl, tp } = stops.value;
    const need = marginRequired(inst, req.units, this.state.settings.leverage, this.market.mid);
    const free = this.metrics().freeMargin;
    if (need > free) {
      return { ok: false, error: `Not enough free margin: need $${need.toFixed(2)}, free $${free.toFixed(2)}` };
    }
    const lots = req.units / LOT_UNITS;
    const commission = cents(this.state.settings.commissionPerLot * lots);
    this.state.balance = cents(this.state.balance - commission);
    const stopDist = req.slPips ?? req.trailPips ?? null;
    const p: Position = {
      id: this.state.nextId++,
      symbol: inst.symbol,
      side: req.side,
      units: req.units,
      entry,
      openTime: q.t,
      sl,
      tp,
      trailPips: req.trailPips ?? null,
      slPips: req.slPips ?? null,
      tpPips: req.tpPips ?? null,
      trailed: false,
      openCommission: commission,
      initialRisk: stopDist
        ? riskUsdFor(req.units, stopDist, pipValuePerLot(inst, this.market.mid), this.state.settings.commissionPerLot)
        : null,
      mfe: 0,
      mae: 0,
      fromOrder,
    };
    this.state.positions.push(p);
    this.state.day.trades++;
    this.emit({ type: 'open', position: p });
    return { ok: true, value: p };
  }

  cancelOrder(id: number, reason = 'Cancelled'): Result<PendingOrder> {
    const i = this.state.orders.findIndex((o) => o.id === id);
    if (i < 0) return { ok: false, error: `No pending order #${id}` };
    const [o] = this.state.orders.splice(i, 1);
    this.emit({ type: 'cancel', order: o, reason });
    return { ok: true, value: o };
  }

  // ---------------------------------------------------------------- positions

  close(id: number, units?: number, reason: CloseReason = 'manual'): Result<ClosedTrade> {
    const idx = this.state.positions.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: `No open position #${id}` };
    if ((reason === 'manual' || reason === 'reverse') && this.market.isOpen && !this.market.isOpen()) {
      return { ok: false, error: MARKET_CLOSED };
    }
    const p = this.state.positions[idx];
    const qty = units ?? p.units;
    if (!Number.isInteger(qty) || qty < MIN_UNITS || qty % MIN_UNITS !== 0 || qty > p.units) {
      return { ok: false, error: 'Close size must be a multiple of 0.01 lots and no larger than the position' };
    }
    const inst = getInstrument(p.symbol);
    const exit = this.exitPrice(p);
    const dir = p.side === 'buy' ? 1 : -1;
    const frac = qty / p.units;
    const gross = cents(profitUsd(inst, p.side, qty, p.entry, exit, this.market.mid));
    const openComm = qty === p.units ? p.openCommission : cents(p.openCommission * frac);
    const closeComm = cents(this.state.settings.commissionPerLot * (qty / LOT_UNITS));
    this.state.balance = cents(this.state.balance + gross - closeComm);
    const net = cents(gross - openComm - closeComm);
    const risk = p.initialRisk !== null ? p.initialRisk * frac : null;
    const trade: ClosedTrade = {
      id: this.state.nextId++,
      positionId: p.id,
      symbol: p.symbol,
      side: p.side,
      units: qty,
      entry: p.entry,
      exit,
      openTime: p.openTime,
      closeTime: this.market.now(),
      pips: Math.round((((exit - p.entry) * dir) / inst.pip) * 10) / 10,
      gross,
      commission: cents(openComm + closeComm),
      net,
      reason,
      r: risk && risk > 0 ? net / risk : null,
      mfe: p.mfe,
      mae: p.mae,
    };
    if (qty === p.units) this.state.positions.splice(idx, 1);
    else {
      p.units -= qty;
      p.openCommission = cents(p.openCommission - openComm);
      if (p.initialRisk !== null) p.initialRisk -= risk ?? 0;
    }
    this.state.history.push(trade);
    if (this.state.history.length > HISTORY_CAP) this.state.history.splice(0, this.state.history.length - HISTORY_CAP);
    this.emit({ type: 'close', trade });
    return { ok: true, value: trade };
  }

  /** Closes every position matching the predicate; returns the closed trades. */
  closeWhere(pred: (p: Position) => boolean, reason: CloseReason = 'manual'): ClosedTrade[] {
    const out: ClosedTrade[] = [];
    for (const p of this.state.positions.filter(pred)) {
      const r = this.close(p.id, undefined, reason);
      if (r.ok) out.push(r.value);
    }
    return out;
  }

  modify(id: number, changes: { sl?: number | null; tp?: number | null; trailPips?: number | null }): Result<Position> {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return { ok: false, error: `No open position #${id}` };
    const inst = getInstrument(p.symbol);
    const q = this.market.quote(p.symbol);
    if (!q) return { ok: false, error: `No price for ${p.symbol}` };
    const sl = changes.sl === undefined ? p.sl : changes.sl === null ? null : roundPrice(changes.sl, inst.digits);
    const tp = changes.tp === undefined ? p.tp : changes.tp === null ? null : roundPrice(changes.tp, inst.digits);
    const trail = changes.trailPips === undefined ? p.trailPips : changes.trailPips;
    const trailErr = validPips(trail, 'Trailing stop');
    if (trailErr) return { ok: false, error: trailErr };
    if (p.side === 'buy') {
      if (sl !== null && sl >= q.bid) return { ok: false, error: `Stop loss must be below the bid (${q.bid})` };
      if (tp !== null && tp <= q.bid) return { ok: false, error: `Take profit must be above the bid (${q.bid})` };
    } else {
      if (sl !== null && sl <= q.ask) return { ok: false, error: `Stop loss must be above the ask (${q.ask})` };
      if (tp !== null && tp >= q.ask) return { ok: false, error: `Take profit must be below the ask (${q.ask})` };
    }
    const g = this.state.guard;
    if (g.enabled && g.requireStopLoss && sl === null && !trail) {
      return { ok: false, error: 'Risk guard: a stop loss (or trailing stop) is required' };
    }
    p.sl = sl;
    p.tp = tp;
    p.trailPips = trail ?? null;
    this.emit({ type: 'modify', position: p });
    return { ok: true, value: p };
  }

  /** Moves the stop loss to the entry price (position must already be beyond entry). */
  breakEven(id: number): Result<Position> {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return { ok: false, error: `No open position #${id}` };
    const q = this.market.quote(p.symbol);
    if (!q) return { ok: false, error: `No price for ${p.symbol}` };
    const inProfit = p.side === 'buy' ? q.bid > p.entry : q.ask < p.entry;
    if (!inProfit) return { ok: false, error: `#${id} must be in profit to move the stop to break-even` };
    return this.modify(id, { sl: p.entry });
  }

  /** Closes a position and opens the same size in the opposite direction. */
  reverse(id: number): Result<Position> {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return { ok: false, error: `No open position #${id}` };
    const inst = getInstrument(p.symbol);
    const q = this.market.quote(p.symbol);
    if (!q) return { ok: false, error: `No price for ${p.symbol}` };
    const side: Side = p.side === 'buy' ? 'sell' : 'buy';
    const req: OrderRequest = {
      symbol: p.symbol,
      side,
      units: p.units,
      type: 'market',
      slPips: p.slPips,
      tpPips: p.tpPips,
      trailPips: p.trailPips,
    };
    // Validate the new trade before touching the existing one.
    const err = this.preTradeChecks(inst, req);
    if (err) return { ok: false, error: err };
    const stops = this.stopsFor(inst, req, q);
    if (!stops.ok) return stops;
    const closed = this.close(id, undefined, 'reverse');
    if (!closed.ok) return closed;
    const r = this.openPosition(inst, req, q, null);
    if (!r.ok) return { ok: false, error: `Closed #${id}, but the reverse trade failed. ${r.error}` };
    return r;
  }

  // ---------------------------------------------------------------- tick processing

  /** Runs after every price update: pending orders, trailing stops, SL/TP, risk guard, stop-out. */
  onTick(): void {
    const now = this.market.now();
    this.rollDay(now);

    // Pending orders
    for (const o of [...this.state.orders]) {
      const q = this.market.quote(o.symbol);
      if (!q) continue;
      const hit =
        o.type === 'limit'
          ? o.side === 'buy'
            ? q.ask <= o.price
            : q.bid >= o.price
          : o.side === 'buy'
            ? q.ask >= o.price
            : q.bid <= o.price;
      if (!hit) continue;
      this.state.orders.splice(this.state.orders.indexOf(o), 1);
      const inst = getInstrument(o.symbol);
      const req: OrderRequest = {
        symbol: o.symbol,
        side: o.side,
        units: o.units,
        type: 'market',
        slPips: o.slPips,
        tpPips: o.tpPips,
        trailPips: o.trailPips,
      };
      if (this.state.guard.enabled && this.state.day.locked) {
        this.emit({ type: 'cancel', order: o, reason: 'Risk guard lock' });
        continue;
      }
      const r = this.openPosition(inst, req, q, o.id);
      if (!r.ok) this.emit({ type: 'cancel', order: o, reason: r.error });
    }

    // Positions: excursions, trailing stops, SL / TP
    for (const p of [...this.state.positions]) {
      const q = this.market.quote(p.symbol);
      if (!q) continue;
      const inst = getInstrument(p.symbol);
      if (p.side === 'buy') {
        const pips = (q.bid - p.entry) / inst.pip;
        if (pips > p.mfe) p.mfe = pips;
        if (pips < p.mae) p.mae = pips;
        if (p.trailPips) {
          const cand = roundPrice(q.bid - p.trailPips * inst.pip, inst.digits);
          if (p.sl === null || cand > p.sl) {
            if (p.sl !== null) p.trailed = true;
            p.sl = cand;
          }
        }
        if (p.sl !== null && q.bid <= p.sl) this.close(p.id, undefined, p.trailed ? 'trail' : 'sl');
        else if (p.tp !== null && q.bid >= p.tp) this.close(p.id, undefined, 'tp');
      } else {
        const pips = (p.entry - q.ask) / inst.pip;
        if (pips > p.mfe) p.mfe = pips;
        if (pips < p.mae) p.mae = pips;
        if (p.trailPips) {
          const cand = roundPrice(q.ask + p.trailPips * inst.pip, inst.digits);
          if (p.sl === null || cand < p.sl) {
            if (p.sl !== null) p.trailed = true;
            p.sl = cand;
          }
        }
        if (p.sl !== null && q.ask >= p.sl) this.close(p.id, undefined, p.trailed ? 'trail' : 'sl');
        else if (p.tp !== null && q.ask <= p.tp) this.close(p.id, undefined, 'tp');
      }
    }

    if (this.state.positions.length === 0) {
      this.marginCallActive = false;
      this.checkDailyLoss();
      return;
    }

    // Stop-out: close the worst position until the margin level recovers.
    let m = this.metrics();
    while (this.state.positions.length > 0 && m.marginLevel < this.state.settings.stopOutLevel) {
      let worst = this.state.positions[0];
      let worstPl = this.floating(worst);
      for (const p of this.state.positions) {
        const pl = this.floating(p);
        if (pl < worstPl) {
          worst = p;
          worstPl = pl;
        }
      }
      if (!this.close(worst.id, undefined, 'stopout').ok) break;
      m = this.metrics();
    }
    if (m.marginLevel < this.state.settings.marginCallLevel) {
      if (!this.marginCallActive) {
        this.marginCallActive = true;
        this.emit({ type: 'margin-call', level: m.marginLevel });
      }
    } else this.marginCallActive = false;

    this.checkDailyLoss();
  }

  private rollDay(now: number): void {
    const key = tradingDayKey(now);
    const d = this.state.day;
    if (d.key === key) return;
    this.state.day = { key, startEquity: this.metrics().equity, locked: false, lockReason: '', trades: 0 };
  }

  private checkDailyLoss(): void {
    const g = this.state.guard;
    const d = this.state.day;
    if (!g.enabled || d.locked || !(g.dailyLossPct > 0) || d.key === -1) return;
    const m = this.metrics();
    if (m.dayPnl <= -(d.startEquity * g.dailyLossPct) / 100) {
      d.locked = true;
      d.lockReason = `daily loss limit of ${g.dailyLossPct}% reached`;
      for (const o of [...this.state.orders]) this.cancelOrder(o.id, 'Risk guard lock');
      if (g.autoFlatten) this.closeWhere(() => true, 'guard');
      this.emit({ type: 'guard-lock', reason: d.lockReason });
    }
  }

  reset(startBalance = this.state.settings.startBalance): void {
    const settings = { ...this.state.settings, startBalance };
    this.state = freshState(settings, this.state.guard);
    this.marginCallActive = false;
    this.emit({ type: 'reset' });
  }
}
