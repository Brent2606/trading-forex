import type { Candle } from './candles';
import { normalizeSymbol } from './instruments';

export interface CsvImport {
  candles: Candle[];
  /** Rows that could not be parsed or failed OHLC sanity checks. */
  skipped: number;
  /** Detected pair (from the file name), if any. */
  symbol: string | null;
  /** Pip size guessed from the symbol or the price level. */
  pip: number;
  digits: number;
  /** Median bar spacing in ms. */
  barMs: number;
}

/**
 * Parses a date/time into UTC ms. Supports YYYY.MM.DD / YYYY-MM-DD / YYYY/MM/DD,
 * DD.MM.YYYY, YYYYMMDD, optional time HH:MM[:SS[.mmm]] or HHMMSS, ISO strings with
 * zone, and Unix epoch seconds or milliseconds. Times without a zone are taken as UTC.
 */
export function parseDateTime(dateRaw: string, timeRaw = ''): number | null {
  const d = dateRaw.trim().replace(/^"|"$/g, '');
  let t = timeRaw.trim().replace(/^"|"$/g, '');
  if (!d) return null;

  if (/^\d{9,13}(\.\d+)?$/.test(d) && !t) {
    const n = Number(d);
    return d.split('.')[0].length >= 12 ? Math.round(n) : Math.round(n * 1000);
  }

  let rest = d;
  let y: number;
  let mo: number;
  let da: number;
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(.*)$/))) {
    y = +m[1];
    mo = +m[2];
    da = +m[3];
    rest = m[4];
  } else if ((m = rest.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(.*)$/))) {
    da = +m[1];
    mo = +m[2];
    y = +m[3];
    rest = m[4];
    // US style MM/DD/YYYY when the "month" cannot be a month.
    if (mo > 12 && da <= 12) [da, mo] = [mo, da];
  } else if ((m = rest.match(/^(\d{4})(\d{2})(\d{2})(.*)$/))) {
    y = +m[1];
    mo = +m[2];
    da = +m[3];
    rest = m[4];
  } else return null;

  rest = rest.trim().replace(/^T/, '');
  let zoneMs = 0;
  const z = rest.match(/\s*(?:GMT|UTC)?\s*(Z|[+-]\d{2}:?\d{2})$/i);
  if (z && /\d/.test(rest.slice(0, rest.length - z[0].length))) {
    if (z[1].toUpperCase() !== 'Z') {
      const sign = z[1][0] === '-' ? -1 : 1;
      const digits = z[1].slice(1).replace(':', '');
      zoneMs = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000;
    }
    rest = rest.slice(0, rest.length - z[0].length).trim();
  } else rest = rest.replace(/\s*(GMT|UTC)$/i, '');
  if (!t) t = rest;
  else if (rest) return null;

  let hh = 0;
  let mm = 0;
  let ss = 0;
  let ms = 0;
  if (t) {
    let tm: RegExpMatchArray | null;
    if ((tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/))) {
      hh = +tm[1];
      mm = +tm[2];
      ss = tm[3] ? +tm[3] : 0;
      ms = tm[4] ? +tm[4].padEnd(3, '0') : 0;
    } else if ((tm = t.match(/^(\d{2})(\d{2})(\d{2})?$/))) {
      hh = +tm[1];
      mm = +tm[2];
      ss = tm[3] ? +tm[3] : 0;
    } else return null;
  }
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mm > 59 || ss > 60) return null;
  const v = Date.UTC(y, mo - 1, da, hh, mm, ss, ms);
  const check = new Date(v);
  if (check.getUTCDate() !== da) return null; // e.g. 31 February
  return v - zoneMs;
}

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 10).join('\n');
  const counts: [string, number][] = [
    ['\t', (sample.match(/\t/g) ?? []).length],
    [';', (sample.match(/;/g) ?? []).length],
    [',', (sample.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

const clean = (s: string) => s.trim().replace(/^"|"$/g, '').replace(/[<>]/g, '').toLowerCase();

interface ColumnMap {
  date: number;
  time: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function mapHeader(cols: string[]): ColumnMap | null {
  const find = (...names: string[]) => cols.findIndex((c) => names.includes(c));
  const date = find('date', 'datetime', 'time', 'timestamp', 'gmt time', 'local time', 'date_time', 'dt', 'open time');
  if (date < 0) return null;
  let time = find('time');
  if (time === date) time = -1;
  const o = find('open', 'o', 'bid open', 'openbid');
  const h = find('high', 'h', 'bid high', 'highbid');
  const l = find('low', 'l', 'bid low', 'lowbid');
  const c = find('close', 'c', 'bid close', 'closebid', 'price');
  const v = find('volume', 'vol', 'tickvol', 'tick volume', 'v');
  if (o < 0 || h < 0 || l < 0 || c < 0) return null;
  return { date, time, o, h, l, c, v };
}

/** Guesses the column layout of a headerless row. */
function mapPositional(cells: string[]): ColumnMap | null {
  const isNum = (s: string) => s !== '' && Number.isFinite(Number(s));
  // "2024.01.02,00:00,o,h,l,c[,v]" (MetaTrader) — date and time in separate columns.
  if (cells.length >= 6 && !isNum(cells[1]) && parseDateTime(cells[0], cells[1]) !== null) {
    return { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: cells.length > 6 ? 6 : -1 };
  }
  // "20240102 000000;o;h;l;c;v" (HistData) or "2024-01-02 00:00,o,h,l,c" or epoch.
  if (cells.length >= 5 && parseDateTime(cells[0]) !== null) {
    return { date: 0, time: -1, o: 1, h: 2, l: 3, c: 4, v: cells.length > 5 ? 5 : -1 };
  }
  return null;
}

export function guessPip(symbol: string | null, price: number): { pip: number; digits: number } {
  if (symbol) {
    return symbol.endsWith('JPY') ? { pip: 0.01, digits: 3 } : { pip: 0.0001, digits: 5 };
  }
  return price >= 20 ? { pip: 0.01, digits: 3 } : { pip: 0.0001, digits: 5 };
}

export function symbolFromFilename(name: string): string | null {
  const letters = name.toUpperCase().replace(/\.[A-Z0-9]+$/, '').replace(/[^A-Z]/g, '');
  for (let i = 0; i + 6 <= letters.length; i++) {
    const s = normalizeSymbol(letters.slice(i, i + 6));
    if (s) return s;
  }
  return null;
}

/**
 * Parses OHLC CSV exports from MetaTrader 4/5, Dukascopy, HistData, TradingView and
 * generic "time,open,high,low,close[,volume]" files.
 */
export function parseCsv(text: string, filename = ''): CsvImport {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('The file is empty');
  const delim = detectDelimiter(lines);
  const first = lines[0].split(delim).map(clean);
  let map = mapHeader(first);
  let start = 1;
  if (!map) {
    map = mapPositional(lines[0].split(delim).map((s) => s.trim().replace(/^"|"$/g, '')));
    start = 0;
  }
  if (!map) {
    throw new Error('Could not find date, open, high, low and close columns. Expected e.g. "Date,Time,Open,High,Low,Close,Volume"');
  }

  const out: Candle[] = [];
  let skipped = 0;
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
    const t = parseDateTime(cells[map.date] ?? '', map.time >= 0 ? (cells[map.time] ?? '') : '');
    const o = Number(cells[map.o]);
    const h = Number(cells[map.h]);
    const l = Number(cells[map.l]);
    const c = Number(cells[map.c]);
    const v = map.v >= 0 ? Number(cells[map.v]) : 0;
    const ok =
      t !== null &&
      [o, h, l, c].every((x) => Number.isFinite(x) && x > 0) &&
      h >= Math.max(o, c, l) &&
      l <= Math.min(o, c, h);
    if (!ok) {
      skipped++;
      continue;
    }
    out.push({ t: t!, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
  }
  if (out.length < 2) throw new Error(`Found ${out.length} valid rows. Need at least 2 OHLC bars`);
  out.sort((a, b) => a.t - b.t);
  const dedup: Candle[] = [];
  for (const b of out) {
    if (dedup.length && dedup[dedup.length - 1].t === b.t) {
      dedup[dedup.length - 1] = b;
      skipped++;
    } else dedup.push(b);
  }
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(dedup.length, 500); i++) gaps.push(dedup[i].t - dedup[i - 1].t);
  gaps.sort((a, b) => a - b);
  const barMs = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const symbol = symbolFromFilename(filename);
  const { pip, digits } = guessPip(symbol, dedup[dedup.length - 1].c);
  return { candles: dedup, skipped, symbol, pip, digits, barMs };
}
