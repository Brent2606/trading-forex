import { LOT_UNITS, MAX_LOTS, MIN_LOTS, type Instrument } from './instruments';
import { marginRequired, pipValuePerLot, type MidLookup } from './rates';

/**
 * Position size (lots, rounded DOWN to 0.01) that loses `riskPct` of `equity` if the
 * stop is hit `slPips` away, including round-trip commission. Returns 0 when even the
 * minimum size would exceed the risk budget.
 */
export function lotsForRisk(opts: {
  equity: number;
  riskPct: number;
  slPips: number;
  pipValuePerLot: number;
  commissionPerLotRoundTrip: number;
}): number {
  const { equity, riskPct, slPips, pipValuePerLot: pv, commissionPerLotRoundTrip: comm } = opts;
  if (!(equity > 0) || !(riskPct > 0) || !(slPips > 0) || !(pv > 0)) return 0;
  const riskUsd = (equity * riskPct) / 100;
  const perLot = slPips * pv + Math.max(0, comm);
  const lots = Math.floor((riskUsd / perLot) * 100 + 1e-9) / 100;
  if (lots < MIN_LOTS) return 0;
  return Math.min(lots, MAX_LOTS);
}

/** Money lost (account currency) if a position of `units` is stopped out `slPips` away, incl. commission. */
export function riskUsdFor(units: number, slPips: number, pipValuePerLotUsd: number, commissionPerLotSide: number): number {
  const lots = units / LOT_UNITS;
  return lots * (slPips * pipValuePerLotUsd + 2 * commissionPerLotSide);
}

export interface TradePreview {
  units: number;
  lots: number;
  entry: number;
  slPrice: number | null;
  tpPrice: number | null;
  pipValue: number;
  margin: number;
  riskUsd: number | null;
  riskPct: number | null;
  rewardUsd: number | null;
  rr: number | null;
  commission: number;
}

/** Everything a trader should see before clicking BUY or SELL. */
export function previewTrade(opts: {
  inst: Instrument;
  side: 'buy' | 'sell';
  units: number;
  entry: number;
  slPips: number | null;
  tpPips: number | null;
  equity: number;
  leverage: number;
  commissionPerLotSide: number;
  mid: MidLookup;
}): TradePreview {
  const { inst, side, units, entry, slPips, tpPips, equity, leverage, commissionPerLotSide, mid } = opts;
  const lots = units / LOT_UNITS;
  const pv = pipValuePerLot(inst, mid);
  const dir = side === 'buy' ? 1 : -1;
  const commission = 2 * commissionPerLotSide * lots;
  const slPrice = slPips && slPips > 0 ? entry - dir * slPips * inst.pip : null;
  const tpPrice = tpPips && tpPips > 0 ? entry + dir * tpPips * inst.pip : null;
  const riskUsd = slPips && slPips > 0 ? lots * slPips * pv + commission : null;
  const rewardUsd = tpPips && tpPips > 0 ? lots * tpPips * pv - commission : null;
  return {
    units,
    lots,
    entry,
    slPrice,
    tpPrice,
    pipValue: pv * lots,
    margin: marginRequired(inst, units, leverage, mid),
    riskUsd,
    riskPct: riskUsd !== null && equity > 0 ? (riskUsd / equity) * 100 : null,
    rewardUsd,
    rr: riskUsd !== null && rewardUsd !== null && riskUsd > 0 ? rewardUsd / riskUsd : null,
    commission,
  };
}
