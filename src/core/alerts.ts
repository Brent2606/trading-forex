import type { Quote } from './rates';

export interface PriceAlert {
  id: number;
  symbol: string;
  cond: 'above' | 'below';
  price: number;
  createdAt: number;
  triggeredAt: number | null;
}

/** Picks the direction from where the price is now, when the user did not specify one. */
export function inferCondition(price: number, bid: number): 'above' | 'below' {
  return price > bid ? 'above' : 'below';
}

/** Returns an error if the alert would fire immediately. */
export function validateAlert(cond: 'above' | 'below', price: number, bid: number): string | null {
  if (!(price > 0)) return 'Alert price must be positive';
  if (cond === 'above' && price <= bid) return `Price is already above ${price} (bid ${bid})`;
  if (cond === 'below' && price >= bid) return `Price is already below ${price} (bid ${bid})`;
  return null;
}

/** Marks and returns alerts whose condition is met by the latest bid. */
export function checkAlerts(alerts: PriceAlert[], quote: (s: string) => Quote | undefined, now: number): PriceAlert[] {
  const fired: PriceAlert[] = [];
  for (const a of alerts) {
    if (a.triggeredAt !== null) continue;
    const q = quote(a.symbol);
    if (!q) continue;
    if ((a.cond === 'above' && q.bid >= a.price) || (a.cond === 'below' && q.bid <= a.price)) {
      a.triggeredAt = now;
      fired.push(a);
    }
  }
  return fired;
}
