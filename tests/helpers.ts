import type { MarketView } from '../src/core/account';
import type { Candle } from '../src/core/candles';
import { getInstrument } from '../src/core/instruments';
import type { Quote } from '../src/core/rates';

/** A hand-driven market: set bids explicitly; ask = bid + spread. */
export class FakeMarket implements MarketView {
  quotes: Record<string, Quote> = {};
  t = Date.UTC(2026, 10, 25, 12, 0, 0); // Wednesday 25 Nov 2026, 12:00 UTC

  constructor() {
    this.set('EURUSD', 1.1, 1);
    this.set('GBPUSD', 1.3, 1);
    this.set('USDJPY', 150, 1);
    this.set('USDCHF', 0.9, 1);
    this.set('AUDUSD', 0.65, 1);
    this.set('USDCAD', 1.35, 1);
    this.set('NZDUSD', 0.6, 1);
    this.set('EURGBP', 0.84615, 1);
    this.set('EURJPY', 165, 1);
  }

  set(symbol: string, bid: number, spreadPips = 1): void {
    const inst = getInstrument(symbol);
    const f = 10 ** inst.digits;
    const bidInt = Math.round(bid * f);
    const askInt = bidInt + Math.round(spreadPips * 10);
    this.quotes[symbol] = {
      symbol,
      bid: bidInt / f,
      ask: askInt / f,
      mid: (bidInt + askInt) / 2 / f,
      spread: spreadPips,
      t: this.t,
    };
  }

  quote = (s: string): Quote | undefined => this.quotes[s];
  mid = (s: string): number | undefined => this.quotes[s]?.mid;
  now = (): number => this.t;
}

export function bar(t: number, o: number, h: number, l: number, c: number, v = 1): Candle {
  return { t, o, h, l, c, v };
}

/** Candles from a list of closes (o = previous close, h/l = max/min of o, c). */
export function fromCloses(closes: number[], start = Date.UTC(2026, 0, 5), step = 3_600_000): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return bar(start + i * step, o, Math.max(o, c), Math.min(o, c), c);
  });
}
