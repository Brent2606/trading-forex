import { heikinAshi, type Candle, type Timeframe } from '../core/candles';
import { dateTime, monthYear, shortDate } from '../core/format';
import { bollinger, ema, macd, rsi, stochastic, type BandsResult, type MacdResult, type StochResult } from '../core/indicators';
import { tradingDayDate } from '../core/time';

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
}

const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
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

  private indicators(): IndicatorCache {
    if (this.ind) return this.ind;
    const closes = new Float64Array(this.raw.length);
    for (let i = 0; i < this.raw.length; i++) closes[i] = this.raw[i].c;
    this.ind = {
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      bb: bollinger(closes, 20, 2),
      rsi: rsi(closes, 14),
      macd: macd(closes),
      stoch: stochastic(this.raw),
    };
    return this.ind;
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
      ctx.fillText('No data', 12, 20);
      return;
    }
    if (this.follow) this.right = n - 1 + MARGIN_BARS;

    const plotW = w - AXIS_W;
    const lowerH = this.lower !== 'none' ? Math.max(56, Math.round((h - AXIS_H - TOP) * 0.24)) : 0;
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
      if (this.overlays.bb && !Number.isNaN(ind.bb.upper[i])) {
        hi = Math.max(hi, ind.bb.upper[i]);
        lo = Math.min(lo, ind.bb.lower[i]);
      }
    }
    if (this.bid !== null && this.follow) {
      hi = Math.max(hi, this.bid);
      lo = Math.min(lo, this.bid);
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
    if (this.overlays.volume) {
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
    if (this.overlays.bb) {
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
    if (this.overlays.ema200) this.polyline(ind.ema200, from, to, x, y, th.accent, 1.4);
    if (this.overlays.ema50) this.polyline(ind.ema50, from, to, x, y, th.warn, 1.2);
    if (this.overlays.ema20) this.polyline(ind.ema20, from, to, x, y, th.cyan, 1.2);

    // ---- markers (backtest trades)
    for (const m of this.markers) {
      const i = this.indexOf(m.t);
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
        const short = ln.label.split(' ').slice(0, 2).join(' ');
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
      const tw = ctx.measureText(ln.label).width + 12;
      // Keep labels clear of the OHLC legend in the top-left corner.
      this.tag(yr < TOP + 44 ? plotW - tw - 8 : 6, yr, ln.label, withAlpha(ln.color, 0.18), ln.color, tw);
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
    if (this.overlays.ema20) put2(`EMA20 ${val(ind.ema20)}`, th.cyan);
    if (this.overlays.ema50) put2(`EMA50 ${val(ind.ema50)}`, th.warn);
    if (this.overlays.ema200) put2(`EMA200 ${val(ind.ema200)}`, th.accent);
    if (this.overlays.bb) put2(`BB ${val(ind.bb.upper)} / ${val(ind.bb.lower)}`, th.accent);
    if (this.type === 'heikin') put2('Heikin-Ashi bodies · OHLC shows real prices', th.faint);
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
    if (this.lower === 'macd') {
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
      ctx.fillText(this.lower === 'macd' ? v.toFixed(this.digits) : String(v), plotW + 8, yy);
    };
    if (this.lower === 'rsi') {
      const y70 = y(70);
      ctx.fillStyle = withAlpha(th.accent, 0.08);
      ctx.fillRect(0, y70, plotW, y(30) - y70);
      hline(70, withAlpha(th.down, 0.5));
      hline(30, withAlpha(th.up, 0.5));
      hline(50, th.grid);
      this.polyline(ind.rsi, from, to, x, y, th.accent, 1.4);
      title = `RSI 14  ${Number.isNaN(ind.rsi[idx]) ? '—' : ind.rsi[idx].toFixed(1)}`;
    } else if (this.lower === 'stoch') {
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
      title = `MACD 12,26,9  ${Number.isNaN(mv) ? '—' : mv.toFixed(this.digits)}  SIG ${Number.isNaN(sv) ? '—' : sv.toFixed(this.digits)}`;
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

  /** Index of the bar with open time t (binary search), or -1. */
  private indexOf(t: number): number {
    let lo = 0;
    let hi = this.bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.bars[mid].t;
      if (v === t) return mid;
      if (v < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}
