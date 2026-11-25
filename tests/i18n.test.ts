import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLang, hasTranslation, setLang, tr, trLines } from '../src/core/i18n';
import { dateTime } from '../src/core/format';

/** Technical tokens that are the same in Dutch. */
const SAME = new Set([
  'ATR', 'BB', 'EMA20', 'EMA50', 'EMA200', 'MACD', 'RSI 14', 'Stoch', 'LIVE', 'H-Ashi', 'SND', 'FX', 'NEONFX', 'NEONFX>',
  'NEONFX Terminal', 'NEONFX&gt;', 'EN', 'EUR/USD', 'EUR/USD · H1', 'MKT', 'VOL', 'Limit', 'Stop', 'buy eurusd', 'Shorts', 'Longs', 'Lots',
]);

function htmlTexts(): string[] {
  const html = readFileSync('index.html', 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const out = new Set<string>();
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const t = m[1].replace(/\s+/g, ' ').trim().replace(/&amp;/g, '&');
    if (/[A-Za-z]{2}/.test(t)) out.add(t);
  }
  for (const m of html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g)) if (/[A-Za-z]{2}/.test(m[1])) out.add(m[1]);
  return [...out];
}

describe('Dutch translation', () => {
  afterEach(() => setLang('en'));

  it('covers every text in the page', () => {
    const missing = htmlTexts().filter((t) => !SAME.has(t) && !hasTranslation(t));
    expect(missing).toEqual([]);
  });

  it('is a no-op in English', () => {
    setLang('en');
    expect(tr('Order rejected')).toBe('Order rejected');
  });

  it('translates exact strings, patterns and strategy descriptions', () => {
    setLang('nl');
    expect(tr('Order rejected')).toBe('Order geweigerd');
    expect(tr('BUY LIMIT')).toBe('KOOP LIMIT');
    expect(tr('FX open · closes in 2h 05m')).toBe('FX open · sluit over 2u 05m');
    expect(tr('Risk guard: this trade risks 2.40% of equity (limit 2%). Reduce size or tighten the stop')).toBe(
      'Risk guard: deze trade riskeert 2.40% van de equity (limiet 2%). Verklein de positie of zet de stop krapper',
    );
    expect(tr('CLOSED #1002 GBP/USD -$1.40 (0.0 pips) · stop loss')).toBe('GESLOTEN #1002 GBP/USD -$1.40 (0.0 pips) · stop loss');
    expect(tr('EMA 20/50 cross · SL 2×ATR · no TP · exit on flip · London · skip high vol')).toBe(
      'EMA 20/50-kruising · SL 2×ATR · geen TP · uit bij omslag · Londen · geen hoge vol.',
    );
    expect(tr('AUTOPILOT benched RSI(8) 40/90 reversion · SL 3.7×ATR · no TP: 7 losses in a row')).toBe(
      'AUTOPILOT bankt RSI(8) 40/90-terugkeer · SL 3.7×ATR · geen TP: 7 verliezen op rij',
    );
    expect(tr('Avoid entries in the Asia session')).toBe('Vermijd instappen in de Azië-sessie');
    expect(tr('1.16002')).toBe('1.16002');
    expect(tr('Prices come from a simulator anchored to your last session. It is not a live market feed.')).toBe(
      'Koersen komen uit een simulator, verankerd aan je vorige sessie. Het is geen live marktfeed.',
    );
    expect(tr('something unknown')).toBe('something unknown');
  });

  it('translates multi-line bot messages, keeping indentation', () => {
    setLang('nl');
    expect(trLines('NEONFX daily report (paper trading)\nStrategies:\n  none deployed')).toBe('NEONFX dagrapport (papierhandel)\nStrategieën:\n  geen ingezet');
    expect(tr('NEONFX · deployed Donchian 20 breakout · SL 2×ATR · no TP on probation (0.25% risk)')).toBe(
      'NEONFX · AUTOPILOT zet in: Donchian 20-uitbraak · SL 2×ATR · geen TP op proef (0.25% risico)',
    );
  });

  it('localises month names and detects the browser language', () => {
    setLang('nl');
    expect(dateTime(new Date(2026, 9, 5, 14, 5).getTime())).toBe('5 okt 14:05');
    setLang('en');
    expect(dateTime(new Date(2026, 9, 5, 14, 5).getTime())).toBe('5 Oct 14:05');
    expect(detectLang('nl-NL')).toBe('nl');
    expect(detectLang('nl')).toBe('nl');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
});
