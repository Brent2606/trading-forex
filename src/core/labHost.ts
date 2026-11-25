import { lessonMatches, type Lesson } from './autopilot';
import type { Genome } from './genome';
import { DEFAULT_LAB, Lab, validateLessonOnHistory, type Dataset, type Evaluation, type LabStats } from './lab';

/** Messages into the lab host (a Web Worker in the browser, in-process in the 24/7 bot). */
export type LabIn =
  | { type: 'init'; seed: number; commission: number; hof: Evaluation[]; stats: Partial<LabStats>; blacklist: string[] }
  | { type: 'data'; datasets: Dataset[]; kind: 'sim' | 'real'; label: string }
  | { type: 'run'; on: boolean; duty?: number }
  | { type: 'ban'; ids: string[] }
  | { type: 'validate'; req: number; lesson: Lesson; genomes: Genome[] };

export type LabOut =
  | { type: 'progress'; stats: LabStats; hof: Evaluation[]; running: boolean; rate: number }
  | { type: 'validated'; req: number; ok: boolean; detail: string };

/**
 * Runs the lab in time slices: work for `slice` ms, then rest so the host stays responsive.
 * `duty` (0.1–1) is the share of time spent searching.
 */
export function createLabHost(post: (m: LabOut) => void, slice = 250): (m: LabIn) => void {
  let lab = new Lab(1);
  let commission = DEFAULT_LAB.commissionPerLot;
  let running = false;
  let duty = 0.6;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPost = 0;
  const recent: number[] = [];

  const progress = () => {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    post({ type: 'progress', stats: { ...lab.stats }, hof: lab.hof(), running, rate: recent.length });
    lastPost = now;
  };

  const loop = () => {
    timer = null;
    if (!running) return;
    const t0 = Date.now();
    while (Date.now() - t0 < slice) {
      const e = lab.step();
      if (!e) break;
      recent.push(Date.now());
    }
    if (Date.now() - lastPost > 1000) progress();
    const work = Math.max(1, Date.now() - t0);
    timer = setTimeout(loop, Math.round((work * (1 - duty)) / duty));
  };

  return (m: LabIn) => {
    switch (m.type) {
      case 'init':
        lab = new Lab(m.seed, { ...DEFAULT_LAB, commissionPerLot: m.commission });
        commission = m.commission;
        lab.restore(m.hof ?? [], m.stats);
        for (const id of m.blacklist ?? []) lab.ban(id);
        progress();
        break;
      case 'data':
        lab.setData(m.datasets, m.kind, m.label);
        progress();
        break;
      case 'run':
        running = m.on;
        if (m.duty) duty = Math.min(1, Math.max(0.1, m.duty));
        if (running && !timer) timer = setTimeout(loop, 0);
        progress();
        break;
      case 'ban':
        for (const id of m.ids) lab.ban(id);
        progress();
        break;
      case 'validate': {
        const r = validateLessonOnHistory(m.genomes, lab.data(), commission, (ctx) => lessonMatches(m.lesson.key, ctx));
        post({ type: 'validated', req: m.req, ...r });
        break;
      }
    }
  };
}
