import { afterEach, describe, expect, it } from 'vitest';
import { explainEntry } from '../src/core/explain';
import { ALL_SESSIONS, normalize, SEARCH, strategyById, type Genome } from '../src/core/genome';
import { setLang } from '../src/core/i18n';
import { conditions, signalSteps, strategyIdea, strategyName } from '../src/ui/tradesPanel';
import { fromCloses } from './helpers';

afterEach(() => setLang('en'));

/** A lively hourly series in which every strategy family fires at least once. */
const candles = fromCloses(
  Array.from({ length: 900 }, (_, i) => 1.1 + Math.sin(i / 31) * 0.012 + Math.sin(i / 5.3) * 0.003 + Math.sin(i / 1.9) * 0.0012 + (i > 600 ? (i - 600) * 0.00004 : 0)),
  Date.UTC(2026, 9, 5, 0),
);

const DEFAULTS: Record<string, Record<string, number>> = {
  'ema-cross': { fast: 10, slow: 40 },
  'rsi-revert': { period: 14, lower: 30, upper: 70 },
  'bb-breakout': { period: 20, mult: 2 },
  'macd-cross': { fast: 12, slow: 26, signal: 9 },
  donchian: { period: 20 },
  'bb-revert': { period: 20, mult: 2 },
  momentum: { period: 12, thr: 2 },
  'session-breakout': { open: 7, hours: 6 },
};

describe('trade explanation texts', () => {
  it('covers every strategy family the lab can find, in Dutch and English, for buys and sells', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(Object.keys(SEARCH).sort());
    for (const [id, params] of Object.entries(DEFAULTS)) {
      const g: Genome = normalize({ strategy: id, params, slAtr: 2, tpAtr: 3, trend: 200, exitOnOpposite: true, sessions: ALL_SESSIONS & ~1, vol: 2 });
      const sig = strategyById(id)!.signals(candles, g.params);
      for (const side of ['buy', 'sell'] as const) {
        const i = sig.findIndex((v, k) => k > 300 && v === (side === 'buy' ? 1 : -1));
        expect(i, `${id} ${side} signal`).toBeGreaterThan(300);
        const why = explainEntry(g, candles, i, side, 'H1');
        expect(why.signal.k, id).toBe(id);
        for (const lang of ['nl', 'en'] as const) {
          setLang(lang);
          const texts = [...signalSteps(why, 5), ...conditions(why, 5), strategyName(id), strategyIdea(id)];
          expect(signalSteps(why, 5).length, id).toBeGreaterThanOrEqual(2);
          for (const t of texts) {
            expect(t.length, `${id} ${side} ${lang}`).toBeGreaterThan(15);
            expect(t, `${id} ${side} ${lang}`).not.toMatch(/undefined|NaN|\[object|—×/);
          }
          // The generic fallback is only for unknown strategies.
          expect(strategyName(id)).not.toMatch(/from the lab|uit het lab/);
        }
      }
    }
  });

  it('names a manual trade and an unknown strategy sensibly', () => {
    setLang('nl');
    expect(strategyName(null)).toMatch(/Handmatig/);
    expect(strategyName('something-new')).toMatch(/uit het lab/);
  });
});
