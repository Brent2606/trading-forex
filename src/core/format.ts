const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "$1,234.56" / "-$12.30" */
export function money(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = usd2.format(Math.abs(v));
  return (v < 0 && Math.abs(v) >= 0.005 ? '-$' : '$') + s;
}

/** "+$12.30" / "-$12.30" */
export function moneySigned(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 0.005) return '$0.00';
  return (v > 0 ? '+' : '') + money(v);
}

export function price(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

export function pct(v: number, digits = 2, signed = false): string {
  if (!Number.isFinite(v)) return '—';
  return (signed && v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

export function pips(v: number, signed = true): string {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return (signed && r > 0 ? '+' : '') + r.toFixed(1);
}

export function lots(v: number): string {
  return v.toFixed(2);
}

export function integer(v: number): string {
  return int.format(v);
}

export function ratio(v: number, digits = 2): string {
  if (Number.isNaN(v)) return '—';
  if (v === Infinity) return '∞';
  return v.toFixed(digits);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "HH:MM:SS". */
export function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local "25 Nov 14:05". */
export function dateTime(t: number): string {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortDate(t: number, utc = false): string {
  const d = new Date(t);
  return utc ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function monthYear(t: number, utc = false): string {
  const d = new Date(t);
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  return `${MONTHS[utc ? d.getUTCMonth() : d.getMonth()]} '${String(y).slice(2)}`;
}

export function hm(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2h 05m" / "45m" / "3d 4h" */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
