export type Ccy = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CHF' | 'AUD' | 'CAD' | 'NZD';

export const CURRENCIES: readonly Ccy[] = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

/** The account is always denominated in this currency. */
export const ACCOUNT_CCY: Ccy = 'USD';

/** 1 standard lot = 100,000 units of the base currency. */
export const LOT_UNITS = 100_000;
export const MIN_LOTS = 0.01;
export const LOT_STEP = 0.01;
export const MAX_LOTS = 50;
/** Smallest tradable size in units (0.01 lot). */
export const MIN_UNITS = Math.round(MIN_LOTS * LOT_UNITS);

export interface Instrument {
  /** e.g. "EURUSD" */
  symbol: string;
  base: Ccy;
  quote: Ccy;
  /** Size of one pip in price terms (0.0001, or 0.01 for JPY-quoted pairs). */
  pip: number;
  /** Quote precision (5, or 3 for JPY-quoted pairs) — i.e. fractional pips ("pipettes"). */
  digits: number;
  /** Typical raw spread in pips during liquid hours. */
  spread: number;
}

function inst(base: Ccy, quote: Ccy, spread: number): Instrument {
  const jpy = quote === 'JPY';
  return { symbol: base + quote, base, quote, pip: jpy ? 0.01 : 0.0001, digits: jpy ? 3 : 5, spread };
}

export const INSTRUMENTS: readonly Instrument[] = [
  inst('EUR', 'USD', 0.6),
  inst('GBP', 'USD', 0.9),
  inst('USD', 'JPY', 0.8),
  inst('USD', 'CHF', 1.1),
  inst('AUD', 'USD', 0.8),
  inst('USD', 'CAD', 1.2),
  inst('NZD', 'USD', 1.3),
  inst('EUR', 'GBP', 1.0),
  inst('EUR', 'JPY', 1.2),
  inst('GBP', 'JPY', 2.0),
  inst('AUD', 'JPY', 1.4),
  inst('EUR', 'CHF', 1.4),
  inst('EUR', 'AUD', 1.8),
  inst('GBP', 'CHF', 2.2),
  inst('CAD', 'JPY', 1.7),
  inst('AUD', 'NZD', 2.0),
];

const BY_SYMBOL = new Map<string, Instrument>(INSTRUMENTS.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): Instrument {
  const i = BY_SYMBOL.get(symbol);
  if (!i) throw new Error(`Unknown instrument ${symbol}`);
  return i;
}

export function findInstrument(symbol: string): Instrument | undefined {
  return BY_SYMBOL.get(symbol);
}

/** Accepts "eurusd", "EUR/USD", "eur-usd", "EUR_USD" and returns "EURUSD" when it is a known pair. */
export function normalizeSymbol(raw: string): string | undefined {
  const s = raw.toUpperCase().replace(/[^A-Z]/g, '');
  return BY_SYMBOL.has(s) ? s : undefined;
}

export function displaySymbol(symbol: string): string {
  return symbol.length === 6 ? `${symbol.slice(0, 3)}/${symbol.slice(3)}` : symbol;
}

/**
 * Built-in fallback reference rates (units of currency per 1 USD), used only when live
 * reference rates cannot be fetched. They are approximate and only anchor the simulator.
 */
export const FALLBACK_RATES: Record<Ccy, number> = {
  USD: 1,
  EUR: 0.862,
  GBP: 0.746,
  JPY: 150.2,
  CHF: 0.801,
  AUD: 1.515,
  CAD: 1.384,
  NZD: 1.695,
};

/** Converts lots to integer units, rounding to the 0.01 lot grid. */
export function lotsToUnits(lots: number): number {
  return Math.round(Math.round(lots / LOT_STEP) * LOT_STEP * LOT_UNITS);
}

export function unitsToLots(units: number): number {
  return Math.round((units / LOT_UNITS) * 100) / 100;
}

/** Rounds a price to the instrument's quote precision. */
export function roundPrice(price: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(price * f) / f;
}
