import { heikinAshi, type Candle, type Timeframe } from '../core/candles';
import { dateTime, monthYear, shortDate } from '../core/format';
import { bollinger, ema, highest, lowest, macd, rsi, stochastic, type BandsResult, type MacdResult, type StochResult } from '../core/indicators';
import { tradingDayDate } from '../core/time';
import { tr } from '../core/i18n';

export type ChartType = 'candles' | 'heikin' | 'line';
export type LowerPane = 'rsi' | 'macd' | 'stoch' | 'none';
export interface Overlays {
  ema20: boolean;
  ema50: boolean;
  ema200: boolean;
  bb: boolean;
  volume: boolean;
}

export interface PriceLine {
  price: number;
  color: string;
  /** Text drawn on the line at the left. */
  label: string;
  dash?: number[];
}

export interface ChartMarker {
  t: number;
  price: number;
  dir: 'up' | 'down';
  color: string;
  /** Short text drawn next to the marker (e.g. "IN", "OUT +$12"). */
  label?: string;
}

/** Shows a strategy's own indicators instead of the default ones (used to explain a trade). */
export interface ChartStudy {
  rsi?: { period: number; lower: number; upper: number };
  macd?: { fast: number; slow: number; signal: number };
  /** Fast and slow EMA of a crossover strategy (replace EMA20 / EMA50). */
  emas?: [number, number];
  bb?: { period: number; mult: number };
  /** Donchian channel: the highest high / lowest low of the prior N bars. */
  channel?: number;
  /** Trend-filter EMA (replaces EMA200). */
  trend?: number;
}

/** One trade drawn as a box: green from entry to target, red from entry to stop. */
export interface TradeZone {
  t0: number;
  /** Exit time; null while the trade is still open. */
  t1: number | null;
  entry: number;
  exit: number | null;
  sl: number | null;
  tp: number | null;
  /** Open time of the bar whose close gave the signal. */
  signalT: number | null;
  /** Names drawn next to the levels (already translated); null when price lines already name them. */
  labels: { entry: string; sl: string; tp: string } | null;
}

interface Theme {
  text: string;
  dim: string;
  faint: string;
  grid: string;
  line: string;
  up: string;
  down: string;
  accent: string;
  warn: string;
  cyan: string;
  void: string;
  panel: string;
}

interface IndicatorCache {
  ema20: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  bb: BandsResult;
  rsi: Float64Array;
  macd: MacdResult;
  stoch: StochResult;
  chHi: Float64Array | null;
  chLo: Float64Array | null;
}

const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
/** A one-element view of a[i - 1] at index i (the channel a bar had to break). */
const shiftAt = (a: Float64Array, i: number): Float64Array => {
  const o = new Float64Array(i + 1).fill(NaN);
  o[i] = a[i - 1];
  return o;
};
const AXIS_W = 76;
const AXIS_H = 22;
const TOP = 6;
const MARGIN_BARS = 4;

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

const NICE_COUNTS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 1024];

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  return {
    text: v('--text', '#ece9ff'),
    dim: v('--dim', '#8f88bf'),
    faint: v('--faint', '#5d5788'),
    grid: 'rgba(58, 50, 112, 0.35)',
    line: v('--line-2', '#3a3270'),
    up: v('--up', '#00f0b5'),
    down: v('--down', '#ff2f7d'),
    accent: v('--accent', '#8a6bff'),
    warn: v('--warn', '#ffc23d'),
    cyan: v('--cyan', '#2de2ff'),
    void: v('--void', '#07060d'),
    panel: v('--panel-2', '#15122a'),
  };
}

function withAlpha(hex: string, a: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class CandleChart {
  type: ChartType = 'candles';
  overlays: Overlays = { ema20: true, ema50: true, ema200: false, bb: false, volume: true };
  lower: LowerPane = 'rsi';
  lines: PriceLine[] = [];
  markers: ChartMarker[] = [];
  zone: TradeZone | null = null;
  title = '';
  glow = true;
  /** Called when the user pans away from / back to the live edge. */
  onFollowChange: ((follow: boolean) => void) | null = null;

  private raw: readonly Candle[] = [];
  private bars: readonly Candle[] = [];
  private digits = 5;
  private tf: Timeframe = 'H1';
  private bid: number | null = null;
  private ask: number | null = null;
  private barW = 8;
  private right = 0;
  private follow = true;
  private hover: { x: number; y: number } | null = null;
  private drag: { x: number; right: number; id: number } | null = null;
  private ind: IndicatorCache | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private theme: Theme;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    wrap: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.theme = readTheme();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.offsetX, right: this.right, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      if (this.drag) {
        this.setRight(this.drag.right - (e.offsetX - this.drag.x) / this.barW);
      }
      this.request();
    });
    const end = (e: PointerEvent) => {
      if (this.drag && this.drag.id === e.pointerId) this.drag = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', (e) => {
      end(e);
      this.hover = null;
      this.request();
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hover = null;
        this.request();
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.zoom(f, e.offsetX);
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', () => this.goLive());
    document.fonts?.ready.then(() => this.request());
  }

  /** Replaces the series. `reset` re-centres the view on the latest bars. */
  setData(raw: readonly Candle[], digits: number, tf: Timeframe, reset: boolean): void {
    this.raw = raw;
    this.digits = digits;
    this.tf = tf;
    if (reset) {
      this.barW = tf === 'D1' ? 9 : 8;
      this.follow = true;
    }
    this.refresh();
  }

  /** Call after the underlying candles changed in place (new tick / new bar). */
  refresh(): void {
    this.bars = this.type === 'heikin' ? heikinAshi(this.raw) : this.raw;
    this.ind = null;
    if (this.follow) this.right = this.raw.length - 1 + MARGIN_BARS;
    this.request();
  }

  setQuote(bid: number | null, ask: number | null): void {
    this.bid = bid;
    this.ask = ask;
  }

  setTheme(): void {
    this.theme = readTheme();
    this.request();
  }

  zoom(factor: number, anchorX?: number): void {
    const plotW = this.w - AXIS_W;
    const ax = anchorX ?? plotW;
    const idx = this.right - (plotW - ax) / this.barW;
    this.barW = Math.min(64, Math.max(1.5, this.barW * factor));
    this.setRight(idx + (plotW - ax) / this.barW);
    this.request();
  }

  goLive(): void {
    this.follow = true;
    this.right = this.raw.length - 1 + MARGIN_BARS;
    this.onFollowChange?.(true);
    this.request();
  }

  isLive(): boolean {
    return this.follow;
  }

  private setRight(r: number): void {
    const n = this.raw.length;
    const visible = (this.w - AXIS_W) / this.barW;
    const min = Math.min(n - 1, 5);
    const max = n - 1 + Math.max(MARGIN_BARS, visible * 0.7);
    this.right = Math.min(max, Math.max(min, r));
    const follow = this.right >= n - 1 + MARGIN_BARS - 0.01;
    if (follow !== this.follow) {
      this.follow = follow;
      this.onFollowChange?.(follow);
    }
    if (follow) this.right = n - 1 + MARGIN_BARS;
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.request();
  }

  request(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private study: ChartStudy | null = null;

  /** Switches the indicators to a strategy's own settings (null = back to the defaults). */
  setStudy(s: ChartStudy | null): void {
    if (JSON.stringify(s) === JSON.stringify(this.study)) return;
    this.study = s;
    this.ind = null;
    this.request();
  }

  /** Overlays to draw: the user's choice, plus whatever the study needs. */
  private get ov(): Overlays {
    const s = this.study;
    if (!s) return this.overlays;
    return {
      ...this.overlays,
      ema20: s.emas ? true : this.overlays.ema20,
      ema50: s.emas ? true : this.overlays.ema50,
      ema200: s.trend ? true : this.overlays.ema200,
      bb: s.bb ? true : this.overlays.bb,
    };
  }

  private get low(): LowerPane {
    return this.study?.rsi ? 'rsi' : this.study?.macd ? 'macd' : this.lower;
  }

  /** Periods of the three moving averages on screen. */
  private get maN(): [number, number, number] {
    const s = this.study;
    return [s?.emas?.[0] ?? 20, s?.emas?.[1] ?? 50, s?.trend ?? 200];
  }

  private indicators(): IndicatorCache {
    if (this.ind) return this.ind;
    const closes = new Float64Array(this.raw.length);
    for (let i = 0; i < this.raw.length; i++) closes[i] = this.raw[i].c;
    const s = this.study;
    const [m1, m2, m3] = this.maN;
    const ch = s?.channel ? Math.round(s.channel) : 0;
    this.ind = {
      ema20: ema(closes, m1),
      ema50: ema(closes, m2),
      ema200: ema(closes, m3),
      bb: bollinger(closes, s?.bb?.period ?? 20, s?.bb?.mult ?? 2),
      rsi: rsi(closes, s?.rsi?.period ?? 14),
      macd: s?.macd ? macd(closes, s.macd.fast, s.macd.slow, s.macd.signal) : macd(closes),
      stoch: stochastic(this.raw),
      chHi: ch
        ? highest(
            this.raw.map((b) => b.h),
            ch,
          )
        : null,
      chLo: ch
        ? lowest(
            this.raw.map((b) => b.l),
            ch,
          )
        : null,
    };
    return this.ind;
  }

  /** Index of the bar that contains time t (the last bar starting at or before t), or -1. */
  private floorIndex(t: number): number {
    let lo = 0;
    let hi = this.bars.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid].t <= t) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at;
  }

  /** Scrolls and zooms so the period t0..t1 is in view with some bars around it. */
  focus(t0: number, t1: number): void {
    const i0 = this.floorIndex(t0);
    if (i0 < 0) return;
    const i1 = Math.max(i0, this.floorIndex(t1));
    const plotW = Math.max(120, this.w - AXIS_W);
    const want = i1 - i0 + 1 + 40;
    this.barW = Math.min(18, Math.max(3, plotW / want));
    const visible = plotW / this.barW;
    this.follow = false;
    this.setRight(i1 + Math.max(6, Math.min(18, visible * 0.25)));
    this.onFollowChange?.(this.follow);
    this.request();
  }

  private fmt(p: number): string {
    return p.toFixed(this.digits);
  }

  private timeLabel(t: number, prev: number | null): string {
    if (this.tf === 'D1') {
      const d = tradingDayDate(t);
      const monthChanged = prev !== null && new Date(tradingDayDate(prev)).getUTCMonth() !== new Date(d).getUTCMonth();
      return monthChanged ? monthYear(d, true) : shortDate(d, true);
    }
    const dt = new Date(t);
    const dayChanged = prev !== null && new Date(prev).toDateString() !== dt.toDateString();
    if (dayChanged || (prev === null && this.tf === 'H4')) return shortDate(t);
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------

  private draw(): void {
    const { ctx, theme: th } = this;
    const w = this.w;
    const h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';

    const n = this.bars.length;
    if (n === 0) {
      ctx.fillStyle = th.dim;
      ctx.fillText(tr('No data'), 12, 20);
      return;
    }
    if (this.follow) this.right = n - 1 + MARGIN_BARS;

    const plotW = w - AXIS_W;
    const lowerH = this.low !== 'none' ? Math.max(56, Math.round((h - AXIS_H - TOP) * 0.24)) : 0;
    const gap = lowerH ? 10 : 0;
    const pTop = TOP;
    const pBot = h - AXIS_H - lowerH - gap;
    const lTop = pBot + gap;
    const lBot = h - AXIS_H;
    const bw = this.barW;
    const count = plotW / bw;
    const from = Math.max(0, Math.floor(this.right - count) - 1);
    const to = Math.min(n - 1, Math.ceil(this.right));
    const x = (i: number) => plotW - (this.right - i + 0.5) * bw;
    const ind = this.indicators();

    // ---- price range
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = from; i <= to; i++) {
      const b = this.bars[i];
      if (this.type === 'line') {
        hi = Math.max(hi, b.c);
        lo = Math.min(lo, b.c);
      } else {
        hi = Math.max(hi, b.h);
        lo = Math.min(lo, b.l);
      }
      if (this.ov.bb && !Number.isNaN(ind.bb.upper[i])) {
        hi = Math.max(hi, ind.bb.upper[i]);
        lo = Math.min(lo, ind.bb.lower[i]);
      }
    }
    if (this.bid !== null && this.follow) {
      hi = Math.max(hi, this.bid);
      lo = Math.min(lo, this.bid);
    }
    const zone = this.zone;
    const z0 = zone ? this.floorIndex(zone.t0) : -1;
    const z1 = zone ? Math.max(z0, zone.t1 === null ? n - 1 : this.floorIndex(zone.t1)) : -1;
    const zoneVisible = !!zone && z0 >= 0 && z1 >= from && z0 <= to;
    if (zone && zoneVisible) {
      for (const v of [zone.entry, zone.exit, zone.sl, zone.tp]) {
        if (v === null) continue;
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return;
    const span = hi - lo || hi * 0.001 || 1;
    hi += span * 0.08;
    lo -= span * 0.08;
    const y = (p: number) => pTop + ((hi - p) / (hi - lo)) * (pBot - pTop);

    // ---- grid + price axis
    ctx.lineWidth = 1;
    const step = niceStep(hi - lo, (pBot - pTop) / 46);
    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.faint;
    ctx.textAlign = 'left';
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(this.fmt(p), plotW + 8, yy);
    }

    // ---- time axis + vertical grid
    const k = NICE_COUNTS.find((c) => c * bw >= 96) ?? 1024;
    let prevT: number | null = null;
    ctx.textAlign = 'center';
    for (let i = from; i <= to; i++) {
      if (i % k !== 0) continue;
      const xx = Math.round(x(i)) + 0.5;
      if (xx < 0 || xx > plotW) {
        prevT = this.bars[i].t;
        continue;
      }
      ctx.strokeStyle = th.grid;
      ctx.beginPath();
      ctx.moveTo(xx, pTop);
      ctx.lineTo(xx, lBot);
      ctx.stroke();
      ctx.fillStyle = th.faint;
      ctx.fillText(this.timeLabel(this.bars[i].t, prevT), xx, h - AXIS_H / 2);
      prevT = this.bars[i].t;
    }

    // ---- axis separators
    ctx.strokeStyle = th.line;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, h);
    ctx.moveTo(0, lBot + 0.5);
    ctx.lineTo(w, lBot + 0.5);
    if (lowerH) {
      ctx.moveTo(0, pBot + gap / 2 + 0.5);
      ctx.lineTo(plotW, pBot + gap / 2 + 0.5);
    }
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, pTop, plotW, pBot - pTop);
    ctx.clip();

    // ---- volume
    if (this.ov.volume) {
      let vmax = 0;
      for (let i = from; i <= to; i++) vmax = Math.max(vmax, this.raw[i].v);
      if (vmax > 0) {
        const vh = (pBot - pTop) * 0.16;
        for (let i = from; i <= to; i++) {
          const b = this.raw[i];
          const hh = (b.v / vmax) * vh;
          ctx.fillStyle = withAlpha(b.c >= b.o ? th.up : th.down, 0.18);
          ctx.fillRect(x(i) - bw * 0.36, pBot - hh, Math.max(1, bw * 0.72), hh);
        }
      }
    }

    // ---- Bollinger
    if (this.ov.bb) {
      ctx.beginPath();
      let started = false;
      for (let i = from; i <= to; i++) {
        const v = ind.bb.upper[i];
        if (Number.isNaN(v)) continue;
        if (!started) {
          ctx.moveTo(x(i), y(v));
          started = true;
        } else ctx.lineTo(x(i), y(v));
      }
      for (let i = to; i >= from; i--) {
        const v = ind.bb.lower[i];
        if (Number.isNaN(v)) continue;
        ctx.lineTo(x(i), y(v));
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(th.accent, 0.07);
      ctx.fill();
      this.polyline(ind.bb.upper, from, to, x, y, withAlpha(th.accent, 0.6), 1);
      this.polyline(ind.bb.lower, from, to, x, y, withAlpha(th.accent, 0.6), 1);
      this.polyline(ind.bb.mid, from, to, x, y, withAlpha(th.accent, 0.35), 1, [3, 3]);
    }

    // ---- Donchian channel of the strategy being explained
    if (ind.chHi && ind.chLo) {
      const shift = (a: Float64Array) => {
        const o = new Float64Array(a.length).fill(NaN);
        for (let i = 1; i < a.length; i++) o[i] = a[i - 1];
        return o;
      };
      this.polyline(shift(ind.chHi), from, to, x, y, withAlpha(th.cyan, 0.8), 1.2, [5, 3]);
      this.polyline(shift(ind.chLo), from, to, x, y, withAlpha(th.cyan, 0.8), 1.2, [5, 3]);
    }

    // ---- the selected trade: signal bar, target zone (green) and stop zone (red)
    if (zone && zoneVisible) {
      const x0 = x(z0) - bw / 2;
      const x1 = Math.max(x(z1) + bw / 2, x0 + Math.max(3 * bw, 26));
      const ye = y(zone.entry);
      if (zone.signalT !== null) {
        const si = this.floorIndex(zone.signalT);
        if (si >= 0) {
          ctx.fillStyle = withAlpha(th.warn, 0.13);
          ctx.fillRect(x(si) - bw / 2, pTop, bw, pBot - pTop);
        }
      }
      if (zone.tp !== null) {
        ctx.fillStyle = withAlpha(th.up, 0.14);
        ctx.fillRect(x0, Math.min(ye, y(zone.tp)), x1 - x0, Math.abs(y(zone.tp) - ye));
      }
      if (zone.sl !== null) {
        ctx.fillStyle = withAlpha(th.down, 0.14);
        ctx.fillRect(x0, Math.min(ye, y(zone.sl)), x1 - x0, Math.abs(y(zone.sl) - ye));
      }
      ctx.strokeStyle = withAlpha(th.text, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(Math.min(ye, y(zone.tp ?? zone.entry), y(zone.sl ?? zone.entry))) + 0.5, Math.round(x1 - x0), Math.round(Math.abs(y(zone.tp ?? zone.entry) - y(zone.sl ?? zone.entry))));
      // Level names at the right edge of the box.
      ctx.font = `700 10px ${MONO}`;
      ctx.textAlign = 'left';
      const tag = (text: string, price: number, col: string) => {
        const tw = ctx.measureText(text).width;
        const lx = Math.min(plotW - tw - 8, x1 + 5);
        const ly = Math.min(pBot - 9, Math.max(pTop + 9, y(price)));
        ctx.fillStyle = withAlpha(th.void, 0.85);
        ctx.fillRect(lx - 3, ly - 7, tw + 6, 14);
        ctx.fillStyle = col;
        ctx.fillText(text, lx, ly);
      };
      if (zone.labels) {
        if (zone.tp !== null) tag(`${zone.labels.tp} ${this.fmt(zone.tp)}`, zone.tp, th.up);
        if (zone.sl !== null) tag(`${zone.labels.sl} ${this.fmt(zone.sl)}`, zone.sl, th.down);
        tag(`${zone.labels.entry} ${this.fmt(zone.entry)}`, zone.entry, th.text);
      }
      ctx.font = `11px ${MONO}`;
    }

    // ---- price
    if (this.type === 'line') {
      const grad = ctx.createLinearGradient(0, pTop, 0, pBot);
      grad.addColorStop(0, withAlpha(th.cyan, 0.28));
      grad.addColorStop(1, withAlpha(th.cyan, 0));
      ctx.beginPath();
      ctx.moveTo(x(from), pBot);
      for (let i = from; i <= to; i++) ctx.lineTo(x(i), y(this.bars[i].c));
      ctx.lineTo(x(to), pBot);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      const closes = this.bars.map((b) => b.c);
      if (this.glow) {
        ctx.shadowColor = th.cyan;
        ctx.shadowBlur = 10;
      }
      this.polyline(closes, from, to, x, y, th.cyan, 1.6);
      ctx.shadowBlur = 0;
    } else {
      for (let i = from; i <= to; i++) {
        const b = this.bars[i];
        const up = b.c >= b.o;
        const col = up ? th.up : th.down;
        const cx = Math.round(x(i)) + 0.5;
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = 1;
        if (bw < 3) {
          ctx.beginPath();
          ctx.moveTo(cx, y(b.h));
          ctx.lineTo(cx, y(b.l));
          ctx.stroke();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(cx, Math.round(y(b.h)));
        ctx.lineTo(cx, Math.round(y(b.l)));
        ctx.stroke();
        const bodyW = Math.max(1, Math.round(bw * 0.7));
        const yo = y(b.o);
        const yc = y(b.c);
        const top = Math.round(Math.min(yo, yc));
        const hgt = Math.max(1, Math.round(Math.abs(yc - yo)));
        const left = Math.round(cx - bodyW / 2);
        if (up) {
          ctx.fillStyle = withAlpha(th.up, 0.22);
          ctx.fillRect(left, top, bodyW, hgt);
          ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, bodyW - 1), Math.max(0, hgt - 1));
        } else {
          ctx.fillRect(left, top, bodyW, hgt);
        }
      }
      // glow on the forming bar
      if (this.glow && to === n - 1) {
        const b = this.bars[to];
        const cx = Math.round(x(to)) + 0.5;
        ctx.shadowColor = b.c >= b.o ? th.up : th.down;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = ctx.shadowColor;
        ctx.beginPath();
        ctx.moveTo(cx, y(b.h));
        ctx.lineTo(cx, y(b.l));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // ---- moving averages
    if (this.ov.ema200) this.polyline(ind.ema200, from, to, x, y, th.accent, 1.4);
    if (this.ov.ema50) this.polyline(ind.ema50, from, to, x, y, th.warn, 1.2);
    if (this.ov.ema20) this.polyline(ind.ema20, from, to, x, y, th.cyan, 1.2);

    // ---- markers (backtest trades)
    if (zone && zoneVisible && zone.exit !== null) {
      ctx.strokeStyle = withAlpha(th.text, 0.85);
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x(z0), y(zone.entry));
      ctx.lineTo(x(z1), y(zone.exit));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const m of this.markers) {
      const i = this.floorIndex(m.t);
      if (i < from || i > to || i < 0) continue;
      const cx = x(i);
      const cy = y(m.price);
      const s = Math.max(4, Math.min(7, bw * 0.6));
      ctx.fillStyle = m.color;
      ctx.beginPath();
      if (m.dir === 'up') {
        ctx.moveTo(cx, cy + 3);
        ctx.lineTo(cx - s, cy + 3 + s * 1.4);
        ctx.lineTo(cx + s, cy + 3 + s * 1.4);
      } else {
        ctx.moveTo(cx, cy - 3);
        ctx.lineTo(cx - s, cy - 3 - s * 1.4);
        ctx.lineTo(cx + s, cy - 3 - s * 1.4);
      }
      ctx.closePath();
      ctx.fill();
      if (m.label) {
        ctx.font = `700 10.5px ${MONO}`;
        const tw = ctx.measureText(m.label).width;
        const ly = m.dir === 'up' ? cy + 3 + s * 1.4 + 10 : cy - 3 - s * 1.4 - 10;
        const lx = Math.min(plotW - tw / 2 - 6, Math.max(tw / 2 + 6, cx));
        ctx.fillStyle = withAlpha(th.void, 0.88);
        ctx.fillRect(lx - tw / 2 - 4, ly - 8, tw + 8, 16);
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx - tw / 2 - 4 + 0.5, ly - 8 + 0.5, tw + 7, 15);
        ctx.fillStyle = m.color;
        ctx.textAlign = 'center';
        ctx.fillText(m.label, lx, ly);
        ctx.font = `11px ${MONO}`;
      }
    }
    ctx.restore();

    // ---- price lines (positions, orders, alerts)
    ctx.textAlign = 'left';
    let above = 0;
    let below = 0;
    for (const ln of this.lines) {
      const yy = y(ln.price);
      if (yy < pTop || yy > pBot) {
        // Off-screen: stack small arrow tags on the price axis.
        const ey = yy < pTop ? pTop + 9 + 19 * above++ : pBot - 9 - 19 * below++;
        const short = tr(ln.label).split(' ').slice(0, 2).join(' ');
        this.tag(plotW + 2, ey, (yy < pTop ? '▲' : '▼') + short, withAlpha(ln.color, 0.25), ln.color, AXIS_W - 4);
        continue;
      }
      const yr = Math.round(yy) + 0.5;
      ctx.strokeStyle = ln.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(ln.dash ?? [6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yr);
      ctx.lineTo(plotW, yr);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = tr(ln.label);
      const tw = ctx.measureText(label).width + 12;
      // Keep labels clear of the OHLC legend in the top-left corner.
      this.tag(yr < TOP + 44 ? plotW - tw - 8 : 6, yr, label, withAlpha(ln.color, 0.18), ln.color, tw);
      this.tag(plotW + 2, yr, this.fmt(ln.price), ln.color, th.void, AXIS_W - 4);
    }

    // ---- live bid / ask
    if (this.bid !== null) {
      const last = this.raw[n - 1];
      const col = last && last.c >= last.o ? th.up : th.down;
      const yb = Math.round(y(this.bid)) + 0.5;
      if (yb >= pTop && yb <= pBot) {
        ctx.strokeStyle = col;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, yb);
        ctx.lineTo(plotW, yb);
        ctx.stroke();
        ctx.setLineDash([]);
        if (this.glow) {
          ctx.shadowColor = col;
          ctx.shadowBlur = 12;
        }
        this.tag(plotW + 2, yb, this.fmt(this.bid), col, th.void, AXIS_W - 4, true);
        ctx.shadowBlur = 0;
      }
      if (this.ask !== null) {
        const ya = Math.round(y(this.ask)) + 0.5;
        if (ya >= pTop && ya <= pBot && Math.abs(ya - yb) > 1.5) {
          ctx.strokeStyle = withAlpha(th.text, 0.25);
          ctx.setLineDash([1, 4]);
          ctx.beginPath();
          ctx.moveTo(0, ya);
          ctx.lineTo(plotW, ya);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // ---- lower pane
    if (lowerH) this.drawLower(ind, from, to, x, plotW, lTop, lBot);

    // ---- crosshair + legend
    const hv = this.hover;
    let hi2 = n - 1;
    if (hv && hv.x < plotW && hv.y < lBot) {
      hi2 = Math.min(n - 1, Math.max(0, Math.round(this.right + 0.5 - (plotW - hv.x) / bw)));
      const cx = Math.round(x(hi2)) + 0.5;
      ctx.strokeStyle = withAlpha(th.text, 0.35);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, pTop);
      ctx.lineTo(cx, lBot);
      if (hv.y >= pTop && hv.y <= pBot) {
        ctx.moveTo(0, Math.round(hv.y) + 0.5);
        ctx.lineTo(plotW, Math.round(hv.y) + 0.5);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (hv.y >= pTop && hv.y <= pBot) {
        const p = hi - ((hv.y - pTop) / (pBot - pTop)) * (hi - lo);
        this.tag(plotW + 2, hv.y, this.fmt(p), th.panel, th.text, AXIS_W - 4);
      }
      const t = this.bars[hi2].t;
      const label = this.tf === 'D1' ? shortDate(tradingDayDate(t), true) + ' ' + new Date(tradingDayDate(t)).getUTCFullYear() : dateTime(t);
      ctx.font = `11px ${MONO}`;
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = th.panel;
      ctx.fillRect(Math.min(plotW - tw, Math.max(0, cx - tw / 2)), lBot + 1, tw, AXIS_H - 2);
      ctx.fillStyle = th.text;
      ctx.textAlign = 'center';
      ctx.fillText(label, Math.min(plotW - tw / 2, Math.max(tw / 2, cx)), lBot + AXIS_H / 2);
      ctx.textAlign = 'left';
    }
    this.legend(hi2, ind);
  }

  private legend(i: number, ind: IndicatorCache): void {
    const { ctx, theme: th } = this;
    const b = this.raw[i];
    if (!b) return;
    const prev = this.raw[i - 1];
    const chg = prev ? ((b.c - prev.c) / prev.c) * 100 : 0;
    ctx.textAlign = 'left';
    let xx = 10;
    const yy = TOP + 10;
    const put = (s: string, col: string, bold = false) => {
      ctx.font = `${bold ? '700 ' : ''}11px ${MONO}`;
      ctx.fillStyle = col;
      ctx.fillText(s, xx, yy);
      xx += ctx.measureText(s).width + 8;
    };
    ctx.fillStyle = withAlpha(th.void, 0.72);
    ctx.fillRect(4, TOP + 1, Math.min(this.w - AXIS_W - 8, 640), 34);
    put(`${this.title} · ${this.tf}`, th.text, true);
    put(`O ${this.fmt(b.o)}`, th.dim);
    put(`H ${this.fmt(b.h)}`, th.dim);
    put(`L ${this.fmt(b.l)}`, th.dim);
    put(`C ${this.fmt(b.c)}`, b.c >= b.o ? th.up : th.down, true);
    put(`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, chg >= 0 ? th.up : th.down);
    xx = 10;
    const y2 = yy + 15;
    const put2 = (s: string, col: string) => {
      ctx.font = `10.5px ${MONO}`;
      ctx.fillStyle = col;
      ctx.fillText(s, xx, y2);
      xx += ctx.measureText(s).width + 10;
    };
    const val = (a: Float64Array) => (Number.isNaN(a[i]) ? '—' : this.fmt(a[i]));
    const [m1, m2, m3] = this.maN;
    if (this.ov.ema20) put2(`EMA${m1} ${val(ind.ema20)}`, th.cyan);
    if (this.ov.ema50) put2(`EMA${m2} ${val(ind.ema50)}`, th.warn);
    if (this.ov.ema200) put2(`EMA${m3} ${val(ind.ema200)}`, th.accent);
    if (this.ov.bb) put2(`BB ${val(ind.bb.upper)} / ${val(ind.bb.lower)}`, th.accent);
    if (ind.chHi && ind.chLo && i > 0) put2(`${tr('Channel')} ${val(shiftAt(ind.chHi, i))} / ${val(shiftAt(ind.chLo, i))}`, th.cyan);
    if (this.type === 'heikin') put2(tr('Heikin-Ashi bodies · OHLC shows real prices'), th.faint);
  }

  private drawLower(
    ind: IndicatorCache,
    from: number,
    to: number,
    x: (i: number) => number,
    plotW: number,
    top: number,
    bot: number,
  ): void {
    const { ctx, theme: th } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.w, bot - top);
    ctx.clip();
    let lo = 0;
    let hi = 100;
    const hv = this.hover;
    const idx = hv
      ? Math.min(this.raw.length - 1, Math.max(0, Math.round(this.right + 0.5 - (plotW - hv.x) / this.barW)))
      : this.raw.length - 1;
    let title = '';
    if (this.low === 'macd') {
      lo = Infinity;
      hi = -Infinity;
      for (let i = from; i <= to; i++) {
        for (const v of [ind.macd.macd[i], ind.macd.signal[i], ind.macd.hist[i]]) {
          if (!Number.isNaN(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      if (!Number.isFinite(lo)) {
        lo = -1;
        hi = 1;
      }
      const m = Math.max(Math.abs(lo), Math.abs(hi)) * 1.1 || 1;
      lo = -m;
      hi = m;
    }
    const y = (v: number) => top + ((hi - v) / (hi - lo)) * (bot - top);
    const hline = (v: number, col: string) => {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = col;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = th.faint;
      ctx.textAlign = 'left';
      ctx.font = `10px ${MONO}`;
      ctx.fillText(this.low === 'macd' ? v.toFixed(this.digits) : String(v), plotW + 8, yy);
    };
    if (this.low === 'rsi') {
      const rs = this.study?.rsi;
      const upper = rs?.upper ?? 70;
      const lower = rs?.lower ?? 30;
      const yUp = y(upper);
      ctx.fillStyle = withAlpha(th.accent, 0.08);
      ctx.fillRect(0, yUp, plotW, y(lower) - yUp);
      hline(upper, withAlpha(th.down, rs ? 0.9 : 0.5));
      hline(lower, withAlpha(th.up, rs ? 0.9 : 0.5));
      hline(50, th.grid);
      this.polyline(ind.rsi, from, to, x, y, th.accent, 1.4);
      title = `RSI ${rs?.period ?? 14}  ${Number.isNaN(ind.rsi[idx]) ? '—' : ind.rsi[idx].toFixed(1)}`;
    } else if (this.low === 'stoch') {
      hline(80, withAlpha(th.down, 0.5));
      hline(20, withAlpha(th.up, 0.5));
      this.polyline(ind.stoch.k, from, to, x, y, th.cyan, 1.3);
      this.polyline(ind.stoch.d, from, to, x, y, th.warn, 1.1);
      const k = ind.stoch.k[idx];
      const d = ind.stoch.d[idx];
      title = `STOCH 14,3,3  %K ${Number.isNaN(k) ? '—' : k.toFixed(1)}  %D ${Number.isNaN(d) ? '—' : d.toFixed(1)}`;
    } else {
      hline(0, th.grid);
      const bw = this.barW;
      for (let i = from; i <= to; i++) {
        const v = ind.macd.hist[i];
        if (Number.isNaN(v)) continue;
        const y0 = y(0);
        const yv = y(v);
        ctx.fillStyle = withAlpha(v >= 0 ? th.up : th.down, 0.55);
        ctx.fillRect(x(i) - bw * 0.35, Math.min(y0, yv), Math.max(1, bw * 0.7), Math.abs(yv - y0));
      }
      this.polyline(ind.macd.macd, from, to, x, y, th.cyan, 1.2);
      this.polyline(ind.macd.signal, from, to, x, y, th.warn, 1.1);
      const mv = ind.macd.macd[idx];
      const sv = ind.macd.signal[idx];
      const ms = this.study?.macd;
      title = `MACD ${ms ? `${ms.fast},${ms.slow},${ms.signal}` : '12,26,9'}  ${Number.isNaN(mv) ? '—' : mv.toFixed(this.digits)}  SIG ${Number.isNaN(sv) ? '—' : sv.toFixed(this.digits)}`;
    }
    ctx.restore();
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = th.dim;
    ctx.textAlign = 'left';
    ctx.fillText(title, 10, top + 9);
  }

  private polyline(
    v: ArrayLike<number>,
    from: number,
    to: number,
    x: (i: number) => number,
    y: (p: number) => number,
    color: string,
    width: number,
    dash?: number[],
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let pen = false;
    for (let i = from; i <= to; i++) {
      const val = v[i];
      if (Number.isNaN(val) || val === undefined) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(x(i), y(val));
        pen = true;
      } else ctx.lineTo(x(i), y(val));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  private tag(xx: number, yy: number, text: string, bg: string, fg: string, width: number, bold = false): void {
    const ctx = this.ctx;
    ctx.font = `${bold ? '700 ' : ''}11px ${MONO}`;
    ctx.fillStyle = bg;
    ctx.fillRect(xx, Math.round(yy - 9), width, 18);
    ctx.shadowBlur = 0;
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.fillText(text, xx + 6, yy + 0.5);
  }

}
