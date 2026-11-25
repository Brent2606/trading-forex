import type { TradingEngine } from '../core/account';
import type { PriceAlert } from '../core/alerts';
import type { Candle, Timeframe } from '../core/candles';
import type { CsvImport } from '../core/csv';
import type { MarketSim } from '../core/market';
import { findInstrument } from '../core/instruments';
import { load } from '../core/storage';
import { TIMEFRAMES } from '../core/candles';
import type { CandleChart, ChartMarker, ChartType, LowerPane, Overlays } from './chart';

export type OrderKind = 'market' | 'limit' | 'stop';
export type ToastKind = 'ok' | 'err' | 'warn' | 'info';
export type SoundKind = 'fill' | 'win' | 'loss' | 'alert' | 'error' | 'click';

export interface TicketPrefs {
  type: OrderKind;
  mode: 'risk' | 'lots';
  risk: number;
  lots: number;
  sl: number;
  tp: number;
  trailOn: boolean;
  trail: number;
  confirm: boolean;
}

export interface UiPrefs {
  symbol: string;
  tf: Timeframe;
  chartType: ChartType;
  overlays: Overlays;
  lower: LowerPane;
  ticket: TicketPrefs;
  fx: boolean;
  sound: boolean;
  tab: string;
  /** Keep the simulator running while the real FX market is closed. */
  weekendPractice: boolean;
  /** Give the desk (tabs) more height on large screens. */
  deskMax: boolean;
}

export const DEFAULT_PREFS: UiPrefs = {
  symbol: 'EURUSD',
  tf: 'M15',
  chartType: 'candles',
  overlays: { ema20: true, ema50: true, ema200: false, bb: false, volume: true },
  lower: 'rsi',
  ticket: { type: 'market', mode: 'risk', risk: 1, lots: 0.1, sl: 20, tp: 40, trailOn: false, trail: 15, confirm: true },
  fx: true,
  sound: true,
  tab: 'positions',
  weekendPractice: false,
  deskMax: false,
};

export function loadPrefs(): UiPrefs {
  const raw = load<Partial<UiPrefs>>('ui');
  const p: UiPrefs = {
    ...DEFAULT_PREFS,
    ...(raw ?? {}),
    overlays: { ...DEFAULT_PREFS.overlays, ...(raw?.overlays ?? {}) },
    ticket: { ...DEFAULT_PREFS.ticket, ...(raw?.ticket ?? {}) },
  };
  if (!findInstrument(p.symbol)) p.symbol = DEFAULT_PREFS.symbol;
  if (!TIMEFRAMES.includes(p.tf)) p.tf = DEFAULT_PREFS.tf;
  if (!['candles', 'heikin', 'line'].includes(p.chartType)) p.chartType = 'candles';
  if (!['rsi', 'macd', 'stoch', 'none'].includes(p.lower)) p.lower = 'rsi';
  const t = p.ticket;
  if (!['market', 'limit', 'stop'].includes(t.type)) t.type = 'market';
  if (t.mode !== 'risk' && t.mode !== 'lots') t.mode = 'risk';
  for (const k of ['risk', 'lots', 'sl', 'tp', 'trail'] as const) {
    if (typeof t[k] !== 'number' || !Number.isFinite(t[k]) || t[k] < 0) t[k] = DEFAULT_PREFS.ticket[k];
  }
  return p;
}

export interface ImportedData extends CsvImport {
  name: string;
}

export interface BacktestMarks {
  key: string;
  markers: ChartMarker[];
}

export interface OrderIntent {
  side: 'buy' | 'sell';
  type: OrderKind;
  symbol: string;
  lots?: number;
  riskPct?: number;
  price?: number;
  slPips?: number | null;
  tpPips?: number | null;
  trailPips?: number | null;
}

export interface App {
  market: MarketSim;
  engine: TradingEngine;
  prefs: UiPrefs;
  alerts: PriceAlert[];
  chart: CandleChart;
  /** Chart shows the imported CSV instead of a live pair. */
  chartSource: 'live' | 'csv';
  csv: ImportedData | null;
  marks: BacktestMarks | null;
  /** Ghost lines previewing the ticket's planned trade while hovering BUY / SELL. */
  ghost: 'buy' | 'sell' | null;
  select(symbol: string, tf?: Timeframe): void;
  showCsvOnChart(): void;
  chartKey(): string;
  chartCandles(): readonly Candle[];
  toast(title: string, body: string, kind: ToastKind): void;
  log(text: string, kind?: ToastKind): void;
  sound(kind: SoundKind): void;
  savePrefs(): void;
  saveAccount(): void;
  saveAlerts(): void;
  /** Re-renders tables after positions / orders / history changed. */
  deskChanged(): void;
  /** Validates, sizes and sends an order. Returns true when accepted. */
  placeOrder(o: OrderIntent): boolean;
  nextAlertId(): number;
  setTab(tab: string): void;
  /** Short tag for positions opened by automation (e.g. "AUTO"), or null. */
  positionTag(id: number): string | null;
}
