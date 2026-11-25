import type { Lesson } from '../core/autopilot';
import type { Genome } from '../core/genome';
import type { Dataset, Evaluation, LabStats } from '../core/lab';
import { createLabHost, type LabIn, type LabOut } from '../core/labHost';
import LabWorker from './labWorker?worker&inline';

/** Browser side of the strategy lab: a Web Worker, or an in-page fallback. */
export class LabClient {
  hof: Evaluation[] = [];
  stats: LabStats | null = null;
  running = false;
  rate = 0;
  readonly inWorker: boolean;
  onProgress: (() => void) | null = null;
  private send: (m: LabIn) => void;
  private req = 0;
  private pending = new Map<number, (r: { ok: boolean; detail: string }) => void>();

  constructor(init: Extract<LabIn, { type: 'init' }>) {
    const receive = (m: LabOut) => {
      if (m.type === 'progress') {
        this.hof = m.hof;
        this.stats = m.stats;
        this.running = m.running;
        this.rate = m.rate;
        this.onProgress?.();
      } else {
        this.pending.get(m.req)?.({ ok: m.ok, detail: m.detail });
        this.pending.delete(m.req);
      }
    };
    let worker: Worker | null = null;
    try {
      worker = new LabWorker();
      worker.onmessage = (e: MessageEvent<LabOut>) => receive(e.data);
    } catch {
      worker = null;
    }
    this.inWorker = worker !== null;
    if (worker) {
      const w = worker;
      this.send = (m) => w.postMessage(m);
    } else {
      // No workers available: search on the main thread in short slices.
      const host = createLabHost(receive, 40);
      this.send = (m) => host(m);
    }
    this.send(init);
  }

  setData(datasets: Dataset[], kind: 'sim' | 'real', label: string): void {
    this.send({ type: 'data', datasets, kind, label });
  }

  run(on: boolean, duty: number): void {
    this.send({ type: 'run', on, duty });
  }

  ban(ids: string[]): void {
    this.send({ type: 'ban', ids });
  }

  validate(lesson: Lesson, genomes: Genome[]): Promise<{ ok: boolean; detail: string }> {
    const req = ++this.req;
    return new Promise((resolve) => {
      this.pending.set(req, resolve);
      this.send({ type: 'validate', req, lesson, genomes });
      setTimeout(() => {
        if (this.pending.delete(req)) resolve({ ok: false, detail: 'History check timed out' });
      }, 60_000);
    });
  }
}
