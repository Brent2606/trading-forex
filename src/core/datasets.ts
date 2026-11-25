import type { Candle, Timeframe } from './candles';
import type { CsvImport } from './csv';
import { ACCOUNT_CCY, findInstrument, getInstrument, type Instrument } from './instruments';
import type { Dataset, QuoteConv } from './lab';
import { convert, type MidLookup } from './rates';

export function quoteConv(inst: Instrument, mid: MidLookup): QuoteConv {
  if (inst.quote === ACCOUNT_CCY) return { kind: 'one' };
  if (inst.base === ACCOUNT_CCY) return { kind: 'inverse' };
  return { kind: 'const', k: convert(1, inst.quote, ACCOUNT_CCY, mid) };
}

/** Closed bars of every pair in the universe (the forming bar is excluded). */
export function marketDatasets(
  series: (symbol: string, tf: Timeframe) => readonly Candle[],
  tf: Timeframe,
  universe: readonly string[],
  mid: MidLookup,
): Dataset[] {
  return universe.map((symbol) => {
    const inst = getInstrument(symbol);
    return { symbol, candles: series(symbol, tf).slice(0, -1), pip: inst.pip, spreadPips: inst.spread, conv: quoteConv(inst, mid) };
  });
}

/** A dataset from an imported CSV file. Unknown pairs are treated as USD-quoted. */
export function csvDataset(csv: CsvImport, mid: MidLookup): Dataset {
  const inst = csv.symbol ? findInstrument(csv.symbol) : undefined;
  return {
    symbol: csv.symbol ?? 'CSV',
    candles: csv.candles,
    pip: csv.pip,
    spreadPips: inst ? inst.spread : 1,
    conv: inst ? quoteConv(inst, mid) : { kind: 'one' },
  };
}
