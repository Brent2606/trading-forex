import type { TradingEngine } from '../core/account';
import { findInstrument, lotsToUnits, MAX_LOTS, MIN_LOTS } from '../core/instruments';
import type { MarketSim } from '../core/market';
import { pipValuePerLot } from '../core/rates';
import { lotsForRisk } from '../core/risk';
import type { OrderIntent } from './context';

export type Sized = { ok: true; units: number; lots: number } | { ok: false; error: string };

/** Turns lots or risk-% into units. Risk sizing uses the stop (or trailing) distance. */
export function sizeOrder(engine: TradingEngine, market: MarketSim, o: OrderIntent): Sized {
  const inst = findInstrument(o.symbol);
  if (!inst) return { ok: false, error: `Unknown pair ${o.symbol}` };
  if (o.lots !== undefined) {
    if (!(o.lots >= MIN_LOTS)) return { ok: false, error: 'Minimum size is 0.01 lots' };
    if (o.lots > MAX_LOTS) return { ok: false, error: `Maximum size is ${MAX_LOTS} lots` };
    const units = lotsToUnits(o.lots);
    return { ok: true, units, lots: units / 100_000 };
  }
  if (o.riskPct !== undefined) {
    const stop = o.slPips || o.trailPips || null;
    if (!stop) return { ok: false, error: 'Sizing by risk % needs a stop loss (or trailing stop) distance' };
    const lots = lotsForRisk({
      equity: engine.metrics().equity,
      riskPct: o.riskPct,
      slPips: stop,
      pipValuePerLot: pipValuePerLot(inst, market.mid),
      commissionPerLotRoundTrip: 2 * engine.state.settings.commissionPerLot,
    });
    if (lots <= 0) return { ok: false, error: `${o.riskPct}% risk is less than 0.01 lots with a ${stop}-pip stop` };
    const units = lotsToUnits(lots);
    return { ok: true, units, lots };
  }
  return { ok: false, error: 'Enter a size' };
}
