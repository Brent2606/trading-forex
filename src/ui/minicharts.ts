/** Small canvas charts: balance / equity curves and the consensus gauge. */
import { tr } from '../core/i18n';

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = canvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}

const css = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

/** Line + area chart of a value series with a dashed baseline. */
export function drawCurve(canvas: HTMLCanvasElement, values: ArrayLike<number>, baseline: number, emptyText: string): void {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const faint = css('--faint', '#5d5788');
  ctx.font = `10.5px ${MONO}`;
  ctx.textBaseline = 'middle';
  if (values.length < 2) {
    ctx.fillStyle = faint;
    ctx.fillText(tr(emptyText), 12, h / 2);
    return;
  }
  let lo = baseline;
  let hi = baseline;
  for (let i = 0; i < values.length; i++) {
    lo = Math.min(lo, values[i]);
    hi = Math.max(hi, values[i]);
  }
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  hi += span * 0.1;
  lo -= span * 0.1;
  const padL = 64;
  const padR = 10;
  const padT = 10;
  const padB = 10;
  const x = (i: number) => padL + (i / (values.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
  const last = values[values.length - 1];
  const col = last >= baseline ? css('--up', '#00f0b5') : css('--down', '#ff2f7d');

  ctx.strokeStyle = 'rgba(58, 50, 112, 0.35)';
  ctx.fillStyle = faint;
  const decimals = span < 2 ? 2 : span < 20 ? 1 : 0;
  for (const v of [hi - span * 0.1, (hi + lo) / 2, lo + span * 0.1]) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), 6, yy);
  }
  const yb = Math.round(y(baseline)) + 0.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = faint;
  ctx.beginPath();
  ctx.moveTo(padL, yb);
  ctx.lineTo(w - padR, yb);
  ctx.stroke();
  ctx.setLineDash([]);

  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, col + '55');
  grad.addColorStop(1, col + '00');
  ctx.beginPath();
  ctx.moveTo(x(0), yb);
  for (let i = 0; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
  ctx.lineTo(x(values.length - 1), yb);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    if (i === 0) ctx.moveTo(x(i), y(values[i]));
    else ctx.lineTo(x(i), y(values[i]));
  }
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = col;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x(values.length - 1), y(last), 3, 0, Math.PI * 2);
  ctx.fill();
}

/** Semicircular gauge for a score in [-1, 1]. */
export function drawGauge(canvas: HTMLCanvasElement, score: number): void {
  const s = setup(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const up = css('--up', '#00f0b5');
  const down = css('--down', '#ff2f7d');
  const dim = css('--dim', '#8f88bf');
  const faint = css('--faint', '#5d5788');
  const text = css('--text', '#ece9ff');
  const cx = w / 2;
  const cy = h - 16;
  const r = Math.min(w / 2 - 40, h - 34);
  const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
  grad.addColorStop(0, down);
  grad.addColorStop(0.5, dim);
  grad.addColorStop(1, up);
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(58, 50, 112, 0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.strokeStyle = grad;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = faint;
  ctx.font = `600 9px "Chakra Petch", system-ui, sans-serif`;
  ctx.fillStyle = faint;
  ctx.textAlign = 'center';
  const labels = ['S.SELL', 'SELL', 'NEUTRAL', 'BUY', 'S.BUY'];
  for (let k = 0; k <= 4; k++) {
    const a = Math.PI + (k / 4) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 9), cy + Math.sin(a) * (r - 9));
    ctx.lineTo(cx + Math.cos(a) * (r - 15), cy + Math.sin(a) * (r - 15));
    ctx.stroke();
    ctx.fillText(tr(labels[k]), cx + Math.cos(a) * (r + 22), cy + Math.sin(a) * (r + 13) + 3);
  }
  const clamped = Math.max(-1, Math.min(1, score));
  const a = Math.PI + ((clamped + 1) / 2) * Math.PI;
  const col = clamped >= 0.1 ? up : clamped <= -0.1 ? down : text;
  ctx.strokeStyle = col;
  ctx.lineWidth = 3;
  ctx.shadowColor = col;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = dim;
  ctx.fillText(`score ${clamped >= 0 ? '+' : ''}${clamped.toFixed(2)}`, cx, cy + 14);
}
