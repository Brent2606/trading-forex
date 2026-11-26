/**
 * Bot mode: the terminal as a window on the 24/7 bot.
 *
 * When the bot serves the terminal it puts its token in <meta name="neonfx-bot">. The terminal then
 * shows the bot's prices and the bot's account instead of its own simulator and paper account:
 *   - RemoteMarket holds the bot's quotes and candles (history once, then a tick per second).
 *   - RemoteEngine mirrors the bot's account. Manual actions run on the mirror first, so the
 *     ticket gets the same instant answer as before, and are then sent to the bot, whose state
 *     replaces the mirror on the next poll. Stops and pending orders are only evaluated by the bot.
 */
import { TradingEngine, type AccountState, type ClosedTrade, type CloseReason, type MarketView, type OrderRequest, type PendingOrder, type Position, type Result } from '../core/account';
import type { CandleRow, EngineOp, EngineOpResult, LiveDump, MarketDump } from '../core/botTypes';
import { aggregate, applyTick, TIMEFRAMES, type Candle, type Timeframe } from '../core/candles';
import { INSTRUMENTS } from '../core/instruments';
import type { MidLookup, Quote } from '../core/rates';
import type { UiMarket } from './context';

export interface BotLink {
  base: string;
  token: string;
}

/** The bot link of a terminal served by the bot, or null for the stand-alone terminal. */
export function readBotLink(doc: Document = document): BotLink | null {
  const token = doc.querySelector<HTMLMetaElement>('meta[name="neonfx-bot"]')?.content?.trim();
  return token && token.length >= 12 ? { base: location.origin, token } : null;
}

export async function botGet<T>(link: BotLink, path: string, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(link.base + path, { headers: { 'x-neonfx-token': link.token }, cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function botPost<T>(link: BotLink, path: string, body: unknown): Promise<T> {
  const res = await fetch(link.base + path, {
    method: 'POST',
    headers: { 'x-neonfx-token': link.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const toCandles = (rows: CandleRow[] | undefined): Candle[] => (rows ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));

// ---------------------------------------------------------------------------

export class RemoteMarket implements UiMarket {
  time: number;
  label: string;
  real: boolean;
  /** Market open on the bot side. */
  open: boolean;
  /** False while the bot cannot be reached. */
  connected = true;
  respectHours = true;
  readonly events: UiMarket['events'] = [];
  readonly candles: Record<string, Record<Timeframe, Candle[]>> = {};
  private readonly quotes = new Map<string, Quote>();
  private fresh = false;

  constructor(d: MarketDump) {
    this.time = d.time;
    this.label = d.label;
    this.real = d.real;
    this.open = d.open;
    this.loadCandles(d);
    for (const q of d.quotes) this.quotes.set(q.symbol, q);
  }

  get seed(): UiMarket['seed'] {
    return { label: this.label, source: 'bot' };
  }

  /** Replaces the candle history (at start-up and after the tab was asleep). */
  loadCandles(d: MarketDump): void {
    for (const inst of INSTRUMENTS) {
      const c = d.candles[inst.symbol];
      const minutes = toCandles(c?.M1);
      const hours = toCandles(c?.H1);
      this.candles[inst.symbol] = {
        M1: minutes,
        M5: aggregate(minutes, 'M5'),
        M15: aggregate(minutes, 'M15'),
        H1: hours,
        H4: aggregate(hours, 'H4'),
        D1: aggregate(hours, 'D1'),
      };
    }
  }

  /** Applies the prices of a live poll; new prices extend the candles like a tick. */
  apply(d: Pick<LiveDump, 'time' | 'label' | 'real' | 'open' | 'quotes'>): void {
    this.time = d.time;
    this.label = d.label;
    this.real = d.real;
    this.open = d.open;
    for (const q of d.quotes) {
      const prev = this.quotes.get(q.symbol);
      this.quotes.set(q.symbol, q);
      const series = this.candles[q.symbol];
      if (series && (!prev || prev.t !== q.t)) {
        for (const tf of TIMEFRAMES) applyTick(series[tf], q.t, q.bid, tf, prev && prev.bid !== q.bid ? 1 : 0);
      }
    }
    this.fresh = true;
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  readonly mid: MidLookup = (symbol) => this.quotes.get(symbol)?.mid;

  series(symbol: string, tf: Timeframe): Candle[] {
    return this.candles[symbol]?.[tf] ?? [];
  }

  isOpen(): boolean {
    return this.open && this.connected;
  }

  /** Runs onStep once after new prices arrived (the terminal's per-tick work). */
  advanceTo(_now: number, onStep?: () => void): void {
    if (!this.fresh) return;
    this.fresh = false;
    onStep?.();
  }

  snapshotRates(): Record<string, number> {
    return {};
  }
}

// ---------------------------------------------------------------------------

const closeKey = (t: Pick<ClosedTrade, 'positionId' | 'units'>) => `${t.positionId}:${t.units}`;

export class RemoteEngine extends TradingEngine {
  /** Positions the bot's autopilot opened. */
  owned = new Set<number>();
  /** Called when the bot refuses an action the mirror accepted. */
  onRejected: (message: string) => void = () => {};
  /** Called after an action was sent, so the terminal can poll right away. */
  onSent: () => void = () => {};
  private depth = 0;
  private synced = false;
  /** Trades the bot has confirmed: the next poll asks for history after this index. */
  confirmed = 0;
  private readonly seenOpen = new Set<number>();
  private readonly seenClose = new Set<string>();
  private readonly seenOrder = new Set<number>();

  constructor(
    state: AccountState,
    market: MarketView,
    private readonly link: BotLink,
  ) {
    super(state, market);
    this.on((e) => {
      if (e.type === 'open') this.seenOpen.add(e.position.id);
      else if (e.type === 'close') this.seenClose.add(closeKey(e.trade));
      else if (e.type === 'order') this.seenOrder.add(e.order.id);
    });
  }

  /** Runs a mirror action; only the outermost call is sent to the bot. */
  private act<T>(run: () => T, op: (r: T) => EngineOp | null): T {
    if (this.depth > 0) return run();
    this.depth++;
    let r: T;
    try {
      r = run();
    } finally {
      this.depth--;
    }
    const o = op(r);
    if (o) void this.send(o);
    return r;
  }

  async send(op: EngineOp): Promise<void> {
    try {
      const r = await botPost<EngineOpResult>(this.link, '/api/engine', op);
      if (!r.ok) this.onRejected(r.error);
    } catch (e) {
      this.onRejected(`Can't reach the bot: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.onSent();
  }

  override submit(req: OrderRequest): Result<Position | PendingOrder> {
    return this.act(
      () => super.submit(req),
      (r) => (r.ok ? { op: 'submit', req } : null),
    );
  }

  override close(id: number, units?: number, reason: CloseReason = 'manual'): Result<ClosedTrade> {
    return this.act(
      () => super.close(id, units, reason),
      (r) => (r.ok ? { op: 'close', id, ...(units !== undefined ? { units } : {}) } : null),
    );
  }

  override closeWhere(pred: (p: Position) => boolean, reason: CloseReason = 'manual'): ClosedTrade[] {
    const ids = this.state.positions.filter(pred).map((p) => p.id);
    return this.act(
      () => super.closeWhere(pred, reason),
      () => (ids.length ? { op: 'closeIds', ids } : null),
    );
  }

  override modify(id: number, changes: { sl?: number | null; tp?: number | null; trailPips?: number | null }): Result<Position> {
    return this.act(
      () => super.modify(id, changes),
      (r) => (r.ok ? { op: 'modify', id, changes } : null),
    );
  }

  override breakEven(id: number): Result<Position> {
    return this.act(
      () => super.breakEven(id),
      (r) => (r.ok ? { op: 'breakEven', id } : null),
    );
  }

  override reverse(id: number): Result<Position> {
    return this.act(
      () => super.reverse(id),
      (r) => (r.ok ? { op: 'reverse', id } : null),
    );
  }

  override cancelOrder(id: number, reason = 'Cancelled'): Result<PendingOrder> {
    return this.act(
      () => super.cancelOrder(id, reason),
      (r) => (r.ok ? { op: 'cancelOrder', id } : null),
    );
  }

  /** The bot evaluates stops, targets and pending orders; the mirror only shows the result. */
  override onTick(): void {}

  /** The bot's account is never wiped from a browser. */
  override reset(): void {
    this.onRejected('The bot account cannot be reset from the terminal');
  }

  /** Sends the risk guard and account settings to the bot. */
  pushConfig(): void {
    const s = this.state;
    void this.send({ op: 'config', guard: { ...s.guard }, leverage: s.settings.leverage, commissionPerLot: s.settings.commissionPerLot });
  }

  /** Replaces the mirror with the bot's account and raises events for what the bot did. */
  sync(d: LiveDump): boolean {
    const prev = this.state;
    const history = d.historyFrom === 0 ? d.state.history : prev.history.slice(0, d.historyFrom).concat(d.state.history);
    const next: AccountState = { ...d.state, history };
    this.owned = new Set(d.owned);
    this.confirmed = history.length;
    const changed =
      next.positions.length !== prev.positions.length ||
      next.orders.length !== prev.orders.length ||
      next.history.length !== prev.history.length ||
      next.balance !== prev.balance ||
      next.positions.some((p, i) => p.id !== prev.positions[i]?.id || p.sl !== prev.positions[i]?.sl || p.tp !== prev.positions[i]?.tp || p.units !== prev.positions[i]?.units);
    this.state = next;
    if (!this.synced) {
      this.synced = true;
      for (const p of next.positions) this.seenOpen.add(p.id);
      for (const t of next.history) this.seenClose.add(closeKey(t));
      for (const o of next.orders) this.seenOrder.add(o.id);
      return true;
    }
    for (const o of next.orders) if (!this.seenOrder.has(o.id)) this.emit({ type: 'order', order: o });
    for (const p of next.positions) if (!this.seenOpen.has(p.id)) this.emit({ type: 'open', position: p });
    for (const t of next.history) if (!this.seenClose.has(closeKey(t))) this.emit({ type: 'close', trade: t });
    if (next.day.locked && !prev.day.locked) this.emit({ type: 'guard-lock', reason: next.day.lockReason });
    return changed;
  }
}
