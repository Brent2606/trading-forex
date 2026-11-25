/**
 * OANDA v20 REST integration for the 24/7 bot (PRACTICE accounts only).
 *
 *   NEONFX_OANDA_TOKEN     personal access token of a practice account (required)
 *   NEONFX_OANDA_ACCOUNT   account id (optional: the first account of the token is used)
 *   NEONFX_OANDA_TRADE     on|off (off): mirror the bot's trades to the practice account
 *   NEONFX_OANDA_MAX_UNITS largest order sent to OANDA (100000 = 1 lot)
 *
 * With a token the bot uses OANDA's real prices and candle history instead of the
 * simulator. Real-money accounts are deliberately not supported.
 */
import type { ClosedTrade, Position, TradingEngine } from '../src/core/account';
import { aggregate, applyTick, TIMEFRAMES, type Candle, type Timeframe } from '../src/core/candles';
import { ACCOUNT_CCY, CURRENCIES, getInstrument, INSTRUMENTS, type Ccy } from '../src/core/instruments';
import { convert, type MidLookup, type Quote } from '../src/core/rates';
import { isFxOpen } from '../src/core/time';

export const OANDA_PRACTICE = 'https://api-fxpractice.oanda.com';
const OANDA_LIVE_HOSTS = ['api-fxtrade.oanda.com', 'stream-fxtrade.oanda.com'];

export const toOanda = (symbol: string) => `${symbol.slice(0, 3)}_${symbol.slice(3)}`;
export const fromOanda = (instrument: string) => instrument.replace('_', '');

/** Practice API, or a local URL for testing. Live endpoints are refused. */
export function resolveBaseUrl(override?: string): string {
  if (!override) return OANDA_PRACTICE;
  const u = new URL(override);
  if (OANDA_LIVE_HOSTS.includes(u.hostname)) {
    throw new Error('Real-money OANDA accounts are not supported by NEONFX. Use a practice (demo) account.');
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!local && u.origin !== OANDA_PRACTICE) throw new Error(`NEONFX_OANDA_URL must be ${OANDA_PRACTICE} (or a local test server)`);
  return u.origin;
}

export class OandaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const unixMs = (t: string) => Math.round(parseFloat(t) * 1000);

export class OandaClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(this.base + path, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'accept-datetime-format': 'UNIX',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        const msg = typeof data.errorMessage === 'string' ? data.errorMessage : `HTTP ${res.status}`;
        throw new OandaError(res.status === 401 ? `OANDA rejected the token (${msg})` : `OANDA: ${msg}`, res.status);
      }
      return data as T;
    } catch (e) {
      if (e instanceof OandaError) throw e;
      throw new OandaError(`Cannot reach OANDA: ${e instanceof Error ? e.message : String(e)}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async firstAccount(): Promise<string> {
    const r = await this.req<{ accounts?: { id: string }[] }>('GET', '/v3/accounts');
    const id = r.accounts?.[0]?.id;
    if (!id) throw new OandaError('This token has no OANDA accounts', 404);
    return id;
  }

  summary(account: string) {
    return this.req<{ account: { currency: string; balance: string; NAV: string; unrealizedPL: string; marginUsed: string; openTradeCount: number } }>(
      'GET',
      `/v3/accounts/${account}/summary`,
    );
  }

  pricing(account: string, instruments: string[]) {
    return this.req<{
      prices: { instrument: string; time: string; tradeable?: boolean; status?: string; bids: { price: string }[]; asks: { price: string }[] }[];
    }>('GET', `/v3/accounts/${account}/pricing?instruments=${instruments.join(',')}`);
  }

  async candles(instrument: string, granularity: 'M1' | 'H1', count: number): Promise<Candle[]> {
    const r = await this.req<{ candles: { complete: boolean; volume: number; time: string; bid?: { o: string; h: string; l: string; c: string } }[] }>(
      'GET',
      `/v3/instruments/${instrument}/candles?granularity=${granularity}&count=${count}&price=B`,
    );
    return (r.candles ?? [])
      .filter((c) => c.bid)
      .map((c) => ({ t: unixMs(c.time), o: +c.bid!.o, h: +c.bid!.h, l: +c.bid!.l, c: +c.bid!.c, v: c.volume ?? 0 }));
  }

  marketOrder(account: string, instrument: string, units: number, sl: string | null, tp: string | null) {
    const order: Record<string, unknown> = { type: 'MARKET', instrument, units: String(units), timeInForce: 'FOK', positionFill: 'DEFAULT' };
    if (sl) order.stopLossOnFill = { price: sl, timeInForce: 'GTC' };
    if (tp) order.takeProfitOnFill = { price: tp, timeInForce: 'GTC' };
    return this.req<{
      orderFillTransaction?: { price: string; tradeOpened?: { tradeID: string; units: string } };
      orderCancelTransaction?: { reason: string };
    }>('POST', `/v3/accounts/${account}/orders`, { order });
  }

  openTrades(account: string) {
    return this.req<{ trades: { id: string; instrument: string; currentUnits: string; price: string; unrealizedPL: string }[] }>(
      'GET',
      `/v3/accounts/${account}/openTrades`,
    );
  }

  closeTrade(account: string, tradeId: string, units: number | 'ALL') {
    return this.req<{ orderFillTransaction?: { price: string; pl: string } }>('PUT', `/v3/accounts/${account}/trades/${tradeId}/close`, {
      units: String(units),
    });
  }

  setTradeOrders(account: string, tradeId: string, sl: string | null, tp: string | null) {
    const body: Record<string, unknown> = {};
    if (sl) body.stopLoss = { price: sl, timeInForce: 'GTC' };
    if (tp) body.takeProfit = { price: tp, timeInForce: 'GTC' };
    return this.req<unknown>('PUT', `/v3/accounts/${account}/trades/${tradeId}/orders`, body);
  }
}

// ---------------------------------------------------------------------------
// Real-price market: OANDA quotes and candles behind the simulator's interface.
// ---------------------------------------------------------------------------

export class OandaMarket {
  readonly label = 'OANDA practice · real prices';
  readonly real = true;
  time = Date.now();
  error = '';
  readonly candles: Record<string, Record<Timeframe, Candle[]>> = {};
  private readonly quotes: Record<string, Quote> = {};
  private tradeable = false;
  private lastOk = 0;
  private fresh = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;

  private constructor(
    private readonly client: OandaClient,
    private readonly account: string,
    private readonly log: (m: string) => void,
  ) {}

  /** Loads ~5000 hourly and 1440 minute bars per pair, then the current prices. */
  static async create(client: OandaClient, account: string, log: (m: string) => void, h1 = 5000, m1 = 1440): Promise<OandaMarket> {
    const m = new OandaMarket(client, account, log);
    for (const inst of INSTRUMENTS) {
      const hours = await client.candles(toOanda(inst.symbol), 'H1', h1);
      const minutes = await client.candles(toOanda(inst.symbol), 'M1', m1);
      if (hours.length < 300) throw new OandaError(`OANDA returned only ${hours.length} hourly bars for ${inst.symbol}`, 0);
      m.candles[inst.symbol] = {
        M1: minutes,
        M5: aggregate(minutes, 'M5'),
        M15: aggregate(minutes, 'M15'),
        H1: hours,
        H4: aggregate(hours, 'H4'),
        D1: aggregate(hours, 'D1'),
      };
    }
    await m.poll();
    if (!Object.keys(m.quotes).length) throw new OandaError(m.error || 'No prices from OANDA', 0);
    return m;
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes[symbol];
  }

  readonly mid: MidLookup = (symbol) => this.quotes[symbol]?.mid;

  series(symbol: string, tf: Timeframe): Candle[] {
    return this.candles[symbol][tf];
  }

  /** Trading allowed only on fresh, tradeable prices during market hours. */
  isOpen(): boolean {
    return this.tradeable && Date.now() - this.lastOk < 15_000 && isFxOpen(Date.now());
  }

  start(intervalMs = 1000): void {
    this.timer ??= setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Calls onStep once when new prices arrived since the last call. */
  advanceTo(_now: number, onStep?: () => void): void {
    if (!this.fresh) return;
    this.fresh = false;
    onStep?.();
  }

  async poll(): Promise<void> {
    try {
      const r = await this.client.pricing(
        this.account,
        INSTRUMENTS.map((i) => toOanda(i.symbol)),
      );
      let tradeable = false;
      for (const p of r.prices ?? []) {
        const symbol = fromOanda(p.instrument);
        const inst = getInstrument(symbol);
        const bid = Number(p.bids?.[0]?.price);
        const ask = Number(p.asks?.[0]?.price);
        if (!(bid > 0) || !(ask >= bid)) continue;
        const t = unixMs(p.time);
        tradeable ||= p.tradeable ?? p.status === 'tradeable';
        const prev = this.quotes[symbol];
        this.quotes[symbol] = { symbol, bid, ask, mid: (bid + ask) / 2, spread: Math.round(((ask - bid) / inst.pip) * 10) / 10, t };
        if (!prev || prev.t !== t) {
          for (const tf of TIMEFRAMES) applyTick(this.candles[symbol][tf], t, bid, tf, prev && prev.bid !== bid ? 1 : 0);
        }
      }
      this.tradeable = tradeable;
      this.time = Date.now();
      this.lastOk = this.time;
      this.fresh = true;
      if (this.failures > 2) this.log('OANDA prices are flowing again');
      this.failures = 0;
      this.error = '';
    } catch (e) {
      this.failures++;
      this.error = e instanceof Error ? e.message : String(e);
      if (this.failures === 3) this.log(`OANDA price feed failing: ${this.error}. Trading pauses until prices return`);
    }
  }
}

// ---------------------------------------------------------------------------
// Order mirror: copy the bot's paper trades to the practice account.
// ---------------------------------------------------------------------------

export interface MirrorState {
  /** paper position id -> OANDA trade id */
  trades: Record<string, string>;
  /** last stop / target sent per paper position */
  sent: Record<string, { sl: number | null; tp: number | null }>;
}

export function freshMirrorState(): MirrorState {
  return { trades: {}, sent: {} };
}

export class OandaMirror {
  nav: number | null = null;
  navUsd: number | null = null;
  currency = '';
  openTrades = 0;
  error = '';

  constructor(
    private readonly client: OandaClient,
    private readonly account: string,
    readonly state: MirrorState,
    private readonly engine: TradingEngine,
    private readonly mid: MidLookup,
    private readonly maxUnits: number,
    private readonly log: (m: string, important?: boolean) => void,
    private readonly closeDelayMs = 3000,
  ) {}

  private price(symbol: string, v: number | null): string | null {
    return v === null ? null : v.toFixed(getInstrument(symbol).digits);
  }

  async refreshAccount(): Promise<void> {
    try {
      const s = await this.client.summary(this.account);
      this.nav = Number(s.account.NAV);
      this.currency = s.account.currency;
      this.openTrades = s.account.openTradeCount;
      this.navUsd = (CURRENCIES as readonly string[]).includes(this.currency)
        ? convert(this.nav, this.currency as Ccy, ACCOUNT_CCY, this.mid)
        : this.nav;
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Units for OANDA: the paper size scaled to the practice account's size, capped. */
  brokerUnits(p: Position): number {
    const paperEquity = this.engine.metrics().equity;
    const scale = this.navUsd && paperEquity > 0 ? this.navUsd / paperEquity : 1;
    return Math.max(1, Math.min(this.maxUnits, Math.round(p.units * scale)));
  }

  async onOpen(p: Position): Promise<void> {
    if (this.navUsd === null) await this.refreshAccount();
    const units = this.brokerUnits(p) * (p.side === 'buy' ? 1 : -1);
    try {
      const r = await this.client.marketOrder(this.account, toOanda(p.symbol), units, this.price(p.symbol, p.sl), this.price(p.symbol, p.tp));
      const id = r.orderFillTransaction?.tradeOpened?.tradeID;
      if (!id) {
        this.log(`OANDA did not fill #${p.id} ${p.symbol}: ${r.orderCancelTransaction?.reason ?? 'unknown reason'}`, true);
        return;
      }
      this.state.trades[String(p.id)] = id;
      this.state.sent[String(p.id)] = { sl: p.sl, tp: p.tp };
      this.log(`OANDA mirrored #${p.id} as trade ${id}: ${units > 0 ? 'BUY' : 'SELL'} ${Math.abs(units)} ${p.symbol} @ ${r.orderFillTransaction?.price}`);
    } catch (e) {
      this.log(`OANDA order for #${p.id} ${p.symbol} failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async onClose(t: ClosedTrade): Promise<void> {
    const key = String(t.positionId);
    const id = this.state.trades[key];
    if (!id) return;
    const stillOpen = this.engine.state.positions.find((p) => p.id === t.positionId);
    // Stops and targets live on OANDA too; give them a moment before closing ourselves.
    if (!stillOpen && (t.reason === 'sl' || t.reason === 'tp' || t.reason === 'trail')) await new Promise((r) => setTimeout(r, this.closeDelayMs));
    try {
      if (stillOpen) {
        const units = Math.max(1, Math.round(this.brokerUnits({ ...stillOpen, units: t.units })));
        await this.client.closeTrade(this.account, id, units);
        this.log(`OANDA partly closed trade ${id} (${units} units)`);
        return;
      }
      const open = await this.client.openTrades(this.account);
      if (open.trades.some((x) => x.id === id)) {
        const r = await this.client.closeTrade(this.account, id, 'ALL');
        this.log(`OANDA closed trade ${id} @ ${r.orderFillTransaction?.price ?? '?'} (P/L ${r.orderFillTransaction?.pl ?? '?'})`);
      } else this.log(`OANDA trade ${id} was already closed by its own stop/target`);
    } catch (e) {
      if (e instanceof OandaError && e.status === 404) this.log(`OANDA trade ${id} no longer exists`);
      else this.log(`OANDA close of trade ${id} failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (!stillOpen) {
      delete this.state.trades[key];
      delete this.state.sent[key];
    }
  }

  /** Sends changed stops / targets (trailing stops, break-even, edits) to OANDA. */
  async syncStops(): Promise<void> {
    for (const p of this.engine.state.positions) {
      const key = String(p.id);
      const id = this.state.trades[key];
      const sent = this.state.sent[key];
      if (!id || !sent || (sent.sl === p.sl && sent.tp === p.tp)) continue;
      try {
        await this.client.setTradeOrders(this.account, id, sent.sl === p.sl ? null : this.price(p.symbol, p.sl), sent.tp === p.tp ? null : this.price(p.symbol, p.tp));
        this.state.sent[key] = { sl: p.sl, tp: p.tp };
      } catch (e) {
        this.log(`OANDA stop update for trade ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
