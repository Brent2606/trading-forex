import { correlationMatrix, currencyStrength } from '../core/analytics';
import { TIMEFRAMES, type Candle, type Timeframe } from '../core/candles';
import { duration, escapeHtml, hm } from '../core/format';
import { CURRENCIES, displaySymbol, INSTRUMENTS } from '../core/instruments';
import { technicalSummary, type Verdict } from '../core/signals';
import { isFxOpen, isSessionOpen, nextFxChange, nextSessionChange, SESSIONS, zonedParts } from '../core/time';
import { $, setText } from './dom';
import type { App } from './context';
import { drawGauge } from './minicharts';

const VCLASS: Record<Verdict, string> = {
  'STRONG BUY': 'v-sb',
  BUY: 'v-b',
  NEUTRAL: 'v-n',
  SELL: 'v-s',
  'STRONG SELL': 'v-ss',
};

/** Indicators only need recent history; trimming keeps the scanner fast. */
const tail = (c: readonly Candle[], n = 500) => (c.length > n ? c.slice(c.length - n) : c);

export function initAnalysis(app: App) {
  // ---------------------------------------------------------------- technical pulse
  function renderTech(): void {
    const candles = tail(app.chartCandles());
    const label = app.chartSource === 'csv' && app.csv ? app.csv.name : displaySymbol(app.prefs.symbol);
    setText($('tech-note'), `${label} · ${app.prefs.tf}`);
    if (candles.length < 2) return;
    const s = technicalSummary(candles);
    drawGauge($<HTMLCanvasElement>('gauge'), s.score);
    const v = $('tech-verdict');
    setText(v, s.verdict);
    v.className = 'verdict ' + (s.verdict.includes('BUY') ? 'buy' : s.verdict.includes('SELL') ? 'sell' : 'neutral');
    const count = (list: typeof s.oscillators) => ({
      b: list.filter((x) => x.action === 'BUY').length,
      s: list.filter((x) => x.action === 'SELL').length,
      n: list.filter((x) => x.action === 'NEUTRAL').length,
    });
    const ma = count(s.movingAverages);
    const os = count(s.oscillators);
    const box = (title: string, c: { b: number; s: number; n: number }) =>
      `<div class="tc"><div class="mini-h">${title}</div><span class="pos">${c.b} buy</span> · <span class="dim">${c.n} neutral</span> · <span class="neg">${c.s} sell</span></div>`;
    const html = box('Moving averages', ma) + box('Oscillators', os);
    const tc = $('tech-counts');
    if (tc.innerHTML !== html) tc.innerHTML = html;
    const fmt = (v: number) => (Number.isNaN(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(5));
    $('tech-table').innerHTML = [...s.movingAverages, ...s.oscillators]
      .map(
        (r) =>
          `<tr><td>${r.name}</td><td class="r">${fmt(r.value)}</td><td class="r ${r.action === 'BUY' ? 'pos' : r.action === 'SELL' ? 'neg' : 'dim'}">${r.action}</td></tr>`,
      )
      .join('');
  }

  // ---------------------------------------------------------------- sessions
  const sessEl = $('sessions');
  const nextChange = new Map<string, number>();
  let fxNext = 0;
  function renderSessions(): void {
    const now = Date.now();
    const open = isFxOpen(now);
    if (now >= fxNext) fxNext = nextFxChange(now);
    setText($('mkt-status'), open ? `FX open · closes in ${duration(fxNext - now)}` : `FX closed · opens in ${duration(fxNext - now)}`);
    const rows: string[] = [];
    const openNames: string[] = [];
    for (const s of SESSIONS) {
      let nc = nextChange.get(s.name) ?? 0;
      if (now >= nc) {
        nc = nextSessionChange(s, now);
        nextChange.set(s.name, nc);
      }
      const isOpen = isSessionOpen(s, now);
      if (isOpen) openNames.push(s.name);
      // progress through the session
      let prog = 0;
      if (isOpen) {
        const p = zonedParts(now, s.tz);
        const mins = (p.hour - s.open) * 60 + p.minute;
        prog = Math.min(100, Math.max(0, (mins / ((s.close - s.open) * 60)) * 100));
      }
      // local opening hours: find the local time of the session's open/close today
      const z = zonedParts(now, s.tz);
      const offsetMin = (z.hour * 60 + z.minute - (new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes()) + 1440 * 2) % 1440;
      const dayStartUtc = Math.floor(now / 86_400_000) * 86_400_000;
      const openLocal = dayStartUtc + (s.open * 60 - offsetMin) * 60_000;
      const closeLocal = dayStartUtc + (s.close * 60 - offsetMin) * 60_000;
      rows.push(
        `<div class="sess ${isOpen ? 'open' : ''}">
          <span class="nm">${s.name}</span>
          <span class="bar"><i style="width:${prog.toFixed(1)}%"></i></span>
          <span class="st">${isOpen ? `closes ${duration(nc - now)}` : `opens ${duration(nc - now)}`}</span>
          <span class="hrs">${hm(openLocal)}–${hm(closeLocal)} your time</span>
        </div>`,
      );
    }
    let overlap = '';
    if (openNames.includes('LONDON') && openNames.includes('NEW YORK')) overlap = 'London × New York overlap: peak liquidity';
    else if (openNames.includes('TOKYO') && openNames.includes('LONDON')) overlap = 'Tokyo × London overlap';
    else if (openNames.includes('SYDNEY') && openNames.includes('TOKYO')) overlap = 'Sydney × Tokyo overlap';
    else if (!open) overlap = 'Weekend: the live market is shut. The simulator keeps running for practice.';
    const html = rows.join('') + (overlap ? `<div class="overlap">${escapeHtml(overlap)}</div>` : '');
    if (sessEl.innerHTML !== html) sessEl.innerHTML = html;
  }

  // ---------------------------------------------------------------- currency strength
  const lbSel = $<HTMLSelectElement>('str-lb');
  lbSel.addEventListener('change', () => renderStrength());
  function renderStrength(): void {
    const lb = Number(lbSel.value) || 24;
    const s = currencyStrength(INSTRUMENTS, (sym) => app.market.series(sym, 'H1'), lb);
    const sorted = [...CURRENCIES].sort((a, b) => s[b] - s[a]);
    const max = Math.max(0.05, ...CURRENCIES.map((c) => Math.abs(s[c])));
    $('strength').innerHTML = sorted
      .map((c) => {
        const v = s[c];
        const w = (Math.abs(v) / max) * 50;
        return `<div class="str"><b>${c}</b><span class="track"><span class="fill ${v >= 0 ? 'up' : 'down'}" style="width:${w.toFixed(1)}%"></span></span><span class="val ${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span></div>`;
      })
      .join('');
  }

  // ---------------------------------------------------------------- scanner
  const SCAN_TF: Timeframe[] = ['M15', 'H1', 'H4', 'D1'];
  const scanTable = $('scan-table');
  function renderScanner(): void {
    const head = `<thead><tr><th>Pair</th>${SCAN_TF.map((t) => `<th>${t}</th>`).join('')}<th class="r">ATR H1</th><th class="r">Day range</th></tr></thead>`;
    const body = INSTRUMENTS.map((inst) => {
      const cells = SCAN_TF.map((tf) => {
        const s = technicalSummary(tail(app.market.series(inst.symbol, tf)));
        return `<td class="${VCLASS[s.verdict]}" data-s="${inst.symbol}" data-tf="${tf}" title="score ${s.score.toFixed(2)}">${s.verdict}</td>`;
      }).join('');
      const h1 = app.market.series(inst.symbol, 'H1');
      let atr = 0;
      const n = Math.min(14, h1.length - 1);
      for (let i = h1.length - n; i < h1.length; i++) {
        const b = h1[i];
        const pc = h1[i - 1].c;
        atr += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
      }
      atr = atr / n / inst.pip;
      const d1 = app.market.series(inst.symbol, 'D1');
      const day = d1[d1.length - 1];
      const range = day ? (day.h - day.l) / inst.pip : 0;
      return `<tr><td class="pairc" data-s="${inst.symbol}"><b>${displaySymbol(inst.symbol)}</b></td>${cells}<td class="r">${atr.toFixed(1)}p</td><td class="r">${range.toFixed(1)}p</td></tr>`;
    }).join('');
    scanTable.innerHTML = head + `<tbody>${body}</tbody>`;
  }
  scanTable.addEventListener('click', (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
    if (!td) return;
    app.select(td.dataset.s!, (td.dataset.tf as Timeframe | undefined) ?? app.prefs.tf);
  });

  // ---------------------------------------------------------------- correlation
  const corTf = $<HTMLSelectElement>('cor-tf');
  const corN = $<HTMLSelectElement>('cor-n');
  corTf.addEventListener('change', () => renderCorrelation());
  corN.addEventListener('change', () => renderCorrelation());
  function renderCorrelation(): void {
    const tf = (TIMEFRAMES as readonly string[]).includes(corTf.value) ? (corTf.value as Timeframe) : 'H4';
    const n = Number(corN.value) || 120;
    const syms = INSTRUMENTS.map((i) => i.symbol);
    const m = correlationMatrix(syms, (s) => app.market.series(s, tf), n);
    const head = `<thead><tr><th></th>${syms.map((s) => `<th>${displaySymbol(s)}</th>`).join('')}</tr></thead>`;
    const body = syms
      .map(
        (s, i) =>
          `<tr><th>${displaySymbol(s)}</th>${m[i]
            .map((r, j) => {
              if (Number.isNaN(r)) return '<td>—</td>';
              const a = Math.min(1, Math.abs(r));
              const bg = r >= 0 ? `rgba(0, 240, 181, ${(a * 0.75).toFixed(2)})` : `rgba(255, 47, 125, ${(a * 0.75).toFixed(2)})`;
              return `<td style="background:${bg}" title="${displaySymbol(s)} vs ${displaySymbol(syms[j])}: ${r.toFixed(3)}">${r.toFixed(2).replace('0.', '.').replace('-.', '−.')}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('');
    $('cor-table').innerHTML = head + `<tbody>${body}</tbody>`;
  }

  return { renderTech, renderSessions, renderStrength, renderScanner, renderCorrelation };
}
