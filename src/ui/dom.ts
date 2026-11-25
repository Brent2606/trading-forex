import { tr } from '../core/i18n';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

export function setText(el: HTMLElement, text: string): void {
  const v = tr(text);
  if (el.textContent !== v) el.textContent = v;
}

/** Sets text and a sign class (pos / neg). */
export function setSigned(el: HTMLElement, text: string, value: number): void {
  setText(el, text);
  el.classList.toggle('pos', value > 0.004);
  el.classList.toggle('neg', value < -0.004);
}

/** Marks one button in a segmented control as pressed. */
export function pressSeg(seg: HTMLElement, value: string): void {
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button[data-v]')) {
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
  }
}

/** Formats a price with the big-figure / pips / pipette split used on dealing screens. */
export function priceHtml(price: number, digits: number): string {
  if (!Number.isFinite(price)) return '—';
  const s = price.toFixed(digits);
  const pipette = s.slice(-1);
  const pips = s.slice(-3, -1);
  const head = s.slice(0, -3);
  return `<span class="px"><span class="a">${head}</span><span class="b">${pips}</span><sup>${pipette}</sup></span>`;
}
