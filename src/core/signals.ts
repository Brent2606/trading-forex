import { closes, type Candle } from './candles';
import { adx, cci, ema, lastValue, macd, momentum, rsi, sma, stochastic, williamsR } from './indicators';

export type Action = 'BUY' | 'SELL' | 'NEUTRAL';
export type Verdict = 'STRONG SELL' | 'SELL' | 'NEUTRAL' | 'BUY' | 'STRONG BUY';

export interface IndicatorReading {
  name: string;
  value: number;
  action: Action;
}

export interface TechSummary {
  movingAverages: IndicatorReading[];
  oscillators: IndicatorReading[];
  buy: number;
  sell: number;
  neutral: number;
  /** (buy − sell) / total, in [−1, 1]. */
  score: number;
  verdict: Verdict;
}

export function verdictFor(score: number): Verdict {
  if (score >= 0.5) return 'STRONG BUY';
  if (score >= 0.1) return 'BUY';
  if (score > -0.1) return 'NEUTRAL';
  if (score > -0.5) return 'SELL';
  return 'STRONG SELL';
}

/**
 * Indicator consensus in the style of common "technical summary" widgets:
 * price vs. 10 moving averages plus 7 oscillators. It describes the current
 * state of the chart; it is not a forecast.
 */
export function technicalSummary(c: readonly Candle[]): TechSummary {
  const cl = closes(c);
  const price = cl[cl.length - 1];
  const movingAverages: IndicatorReading[] = [];
  for (const n of [10, 20, 50, 100, 200]) {
    for (const [kind, fn] of [
      ['SMA', sma],
      ['EMA', ema],
    ] as const) {
      const v = lastValue(fn(cl, n));
      const valid = c.length >= n && !Number.isNaN(v);
      movingAverages.push({
        name: `${kind} ${n}`,
        value: v,
        action: !valid ? 'NEUTRAL' : price > v ? 'BUY' : price < v ? 'SELL' : 'NEUTRAL',
      });
    }
  }

  const oscillators: IndicatorReading[] = [];
  const r = lastValue(rsi(cl, 14));
  oscillators.push({ name: 'RSI (14)', value: r, action: r < 30 ? 'BUY' : r > 70 ? 'SELL' : 'NEUTRAL' });
  const st = stochastic(c, 14, 3, 3);
  const k = lastValue(st.k);
  const d = lastValue(st.d);
  oscillators.push({
    name: 'Stoch %K (14,3,3)',
    value: k,
    action: k < 20 && k > d ? 'BUY' : k > 80 && k < d ? 'SELL' : 'NEUTRAL',
  });
  const m = macd(cl);
  const h = lastValue(m.hist);
  oscillators.push({ name: 'MACD (12,26)', value: lastValue(m.macd), action: h > 0 ? 'BUY' : h < 0 ? 'SELL' : 'NEUTRAL' });
  const cc = lastValue(cci(c, 20));
  oscillators.push({ name: 'CCI (20)', value: cc, action: cc < -100 ? 'BUY' : cc > 100 ? 'SELL' : 'NEUTRAL' });
  const ad = adx(c, 14);
  const av = lastValue(ad.adx);
  const pdi = lastValue(ad.plusDI);
  const mdi = lastValue(ad.minusDI);
  oscillators.push({
    name: 'ADX (14)',
    value: av,
    action: av > 25 ? (pdi > mdi ? 'BUY' : 'SELL') : 'NEUTRAL',
  });
  const w = lastValue(williamsR(c, 14));
  oscillators.push({ name: 'Williams %R', value: w, action: w < -80 ? 'BUY' : w > -20 ? 'SELL' : 'NEUTRAL' });
  const mo = lastValue(momentum(cl, 10));
  oscillators.push({ name: 'Momentum (10)', value: mo, action: mo > 0 ? 'BUY' : mo < 0 ? 'SELL' : 'NEUTRAL' });

  for (const o of oscillators) if (Number.isNaN(o.value)) o.action = 'NEUTRAL';

  const all = [...movingAverages, ...oscillators];
  const buy = all.filter((x) => x.action === 'BUY').length;
  const sell = all.filter((x) => x.action === 'SELL').length;
  const neutral = all.length - buy - sell;
  const score = (buy - sell) / all.length;
  return { movingAverages, oscillators, buy, sell, neutral, score, verdict: verdictFor(score) };
}
