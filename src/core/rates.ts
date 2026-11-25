import { ACCOUNT_CCY, LOT_UNITS, type Ccy, type Instrument } from './instruments';

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  /** Current spread in pips. */
  spread: number;
  /** Quote time (UTC ms). */
  t: number;
}

/** Looks up the current mid price of a symbol such as "EURUSD". */
export type MidLookup = (symbol: string) => number | undefined;

/**
 * Converts an amount between currencies using mid prices: direct pair, inverse
 * pair, or a cross through USD. Throws when no route exists.
 */
export function convert(amount: number, from: Ccy, to: Ccy, mid: MidLookup): number {
  if (from === to || amount === 0) return amount;
  const direct = mid(from + to);
  if (direct !== undefined && direct > 0) return amount * direct;
  const inverse = mid(to + from);
  if (inverse !== undefined && inverse > 0) return amount / inverse;
  if (from !== 'USD' && to !== 'USD') {
    return convert(convert(amount, from, 'USD', mid), 'USD', to, mid);
  }
  throw new Error(`No conversion route ${from} -> ${to}`);
}

/** Value of a one-pip move on one standard lot, in the account currency. */
export function pipValuePerLot(inst: Instrument, mid: MidLookup): number {
  return convert(LOT_UNITS * inst.pip, inst.quote, ACCOUNT_CCY, mid);
}

/** Margin required (account currency) to hold `units` of the instrument at the given leverage. */
export function marginRequired(inst: Instrument, units: number, leverage: number, mid: MidLookup): number {
  return convert(units, inst.base, ACCOUNT_CCY, mid) / leverage;
}

/** Profit in the account currency of a move from `entry` to `exit` on a position. */
export function profitUsd(
  inst: Instrument,
  side: 'buy' | 'sell',
  units: number,
  entry: number,
  exit: number,
  mid: MidLookup,
): number {
  const dir = side === 'buy' ? 1 : -1;
  return convert((exit - entry) * units * dir, inst.quote, ACCOUNT_CCY, mid);
}

export function priceDiffToPips(inst: Instrument, diff: number): number {
  return diff / inst.pip;
}
