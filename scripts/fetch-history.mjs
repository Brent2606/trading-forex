// Downloads ~2 years of real hourly FX candles (Yahoo Finance) for the 16 NEONFX pairs
// and writes them as time,open,high,low,close CSV files into <dir> (default data/history).
// Usage: node scripts/fetch-history.mjs [dir]
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP',
  'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF', 'EURAUD', 'GBPCHF', 'CADJPY', 'AUDNZD'];
const dir = process.argv[2] ?? join(process.cwd(), 'data', 'history');
mkdirSync(dir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
for (const p of PAIRS) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${p}=X?interval=1h&range=730d`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const r = j.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const rows = ['time,open,high,low,close'];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (![o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) continue;
      // Skip flat placeholder bars (market closed) and bars whose high/low are inconsistent.
      if (o === h && h === l && l === c) continue;
      const hi = Math.max(o, h, l, c), lo = Math.min(o, h, l, c);
      const t = Math.floor(ts[i] / 3600) * 3600; // align to the hour (UTC)
      rows.push(`${t},${o},${hi},${lo},${c}`);
    }
    if (rows.length < 1000) throw new Error(`only ${rows.length - 1} bars`);
    const file = join(dir, `${p}_H1_real.csv`);
    writeFileSync(file + '.tmp', rows.join('\n') + '\n');
    renameSync(file + '.tmp', file);
    console.log(`${p}: ${rows.length - 1} bars`);
  } catch (e) {
    failed++;
    console.error(`${p}: FAILED ${e instanceof Error ? e.message : e}`);
  }
  await sleep(1500);
}
process.exit(failed === PAIRS.length ? 1 : 0);
