import { liveMean, MIN_TESTED_BEFORE_DEPLOY, type Autopilot, type AutopilotConfig, type Deployment } from '../core/autopilot';
import { bucketStart, TF_MS, type Timeframe } from '../core/candles';
import { csvDataset, marketDatasets } from '../core/datasets';
import { duration, escapeHtml, integer, moneySigned } from '../core/format';
import { SESSION_NAMES } from '../core/genome';
import type { Evaluation, SegmentStats } from '../core/lab';
import { save } from '../core/storage';
import { $, setText } from './dom';
import type { App } from './context';
import type { LabClient } from './labClient';

const R = (v: number | null | undefined, signed = true) =>
  typeof v === 'number' && Number.isFinite(v) ? `${signed && v > 0 ? '+' : ''}${v.toFixed(2)}R` : '—';
const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const seg = (s: SegmentStats) => `<span class="${cls(s.meanR)}">${R(s.meanR)}</span> <span class="dim">· ${s.n}</span>`;

export interface AutopilotPanel {
  render(): void;
  tick(): void;
  setEnabled(on: boolean): void;
  setLab(on: boolean): void;
  csvAvailable(): void;
  /** Hall-of-fame entries evaluated on the current data (safe to deploy). */
  currentHof(): Evaluation[];
}

export function initAutopilotPanel(app: App, ap: Autopilot, lab: LabClient): AutopilotPanel {
  const cfg = (): AutopilotConfig => ap.state.config;
  const enabled = $<HTMLInputElement>('ap-enabled');
  const labOn = $<HTMLInputElement>('ap-lab');
  const mode = $<HTMLSelectElement>('ap-mode');
  const risk = $<HTMLInputElement>('ap-risk');
  const prisk = $<HTMLInputElement>('ap-prisk');
  const maxOpen = $<HTMLInputElement>('ap-maxopen');
  const tfSel = $<HTMLSelectElement>('ap-tf');
  const dataSel = $<HTMLSelectElement>('ap-data');
  const dutySel = $<HTMLSelectElement>('ap-duty');
  let duty = 0.6;
  let lastDataRefresh = 0;
  let bannedSent = 0;

  function syncControls(): void {
    const c = cfg();
    enabled.checked = c.enabled;
    labOn.checked = c.lab;
    mode.value = c.mode;
    risk.value = String(c.riskPct);
    prisk.value = String(c.probationRiskPct);
    maxOpen.value = String(c.maxOpen);
    tfSel.value = c.tf;
    dataSel.value = c.labData === 'csv' && app.csv ? 'csv' : 'sim';
    dutySel.value = String(duty);
  }

  function refreshData(): void {
    const c = cfg();
    if (c.labData === 'csv' && app.csv) {
      lab.setData([csvDataset(app.csv, app.market.mid)], 'real', `${app.csv.name} (real data)`);
    } else {
      const ds = marketDatasets((s, tf) => app.market.series(s, tf), c.tf, c.universe, app.market.mid);
      lab.setData(ds, 'sim', `simulated ${c.tf}, ${ds.length} pairs`);
    }
    lastDataRefresh = Date.now();
  }

  function persist(): void {
    app.saveAccount();
    save('autopilot', ap.state);
  }

  function setEnabled(on: boolean): void {
    cfg().enabled = on;
    if (on) {
      ap.sync(currentHof(), lab.stats?.tested ?? 0);
      app.log(
        ap.liveDeployments().length
          ? `AUTOPILOT ON: trading ${ap.liveDeployments().length} strateg${ap.liveDeployments().length === 1 ? 'y' : 'ies'} on ${cfg().tf}`
          : 'AUTOPILOT ON: waiting for the lab to find candidates worth testing',
        'ok',
      );
    } else app.log('AUTOPILOT OFF: no new trades. Open positions keep their stops and targets', 'warn');
    syncControls();
    persist();
    render();
  }

  function setLab(on: boolean): void {
    cfg().lab = on;
    lab.run(on, duty);
    app.log(on ? 'LAB ON: searching for better strategies' : 'LAB paused', on ? 'ok' : 'info');
    syncControls();
    persist();
    render();
  }

  enabled.addEventListener('change', () => setEnabled(enabled.checked));
  labOn.addEventListener('change', () => setLab(labOn.checked));
  $('ap-form').addEventListener('submit', (e) => e.preventDefault());
  $('ap-form').addEventListener('change', (e) => {
    const c = cfg();
    const t = e.target;
    const num = (el: HTMLInputElement, min: number, max: number, fb: number) => {
      const v = Number(el.value);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
    };
    if (t === mode) c.mode = mode.value === 'strict' ? 'strict' : 'explore';
    if (t === risk) c.riskPct = num(risk, 0.05, 2, c.riskPct);
    if (t === prisk) c.probationRiskPct = num(prisk, 0.05, 2, c.probationRiskPct);
    if (t === maxOpen) c.maxOpen = Math.round(num(maxOpen, 1, 20, c.maxOpen));
    if (t === dutySel) {
      duty = Number(dutySel.value) || 0.6;
      if (c.lab) lab.run(true, duty);
    }
    if (t === tfSel || t === dataSel) {
      const tf = (tfSel.value === 'H4' ? 'H4' : 'H1') as Timeframe;
      if (tf !== c.tf) {
        c.tf = tf;
        for (const d of ap.state.deployments) {
          if (d.status !== 'benched') {
            d.status = 'benched';
            d.note = 'Stopped: timeframe changed';
          }
        }
        ap.state.lastBar = {};
        app.log(`AUTOPILOT timeframe ${tf}: previous strategies stopped, the lab re-tests on ${tf} data`, 'info');
      }
      c.labData = dataSel.value === 'csv' && app.csv ? 'csv' : 'sim';
      refreshData();
    }
    syncControls();
    persist();
    render();
  });

  $('ap-deps').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-bench]');
    if (!btn) return;
    const d = ap.state.deployments.find((x) => x.id === btn.dataset.bench);
    if (!d || d.status === 'benched') return;
    d.status = 'benched';
    d.note = 'Benched by you';
    if (!ap.state.blacklist.includes(d.id)) ap.state.blacklist.push(d.id);
    app.log(`AUTOPILOT ${d.desc} benched by you`, 'warn');
    persist();
    render();
  });

  function currentHof(): Evaluation[] {
    const v = lab.stats?.dataVersion;
    return lab.hof.filter((e) => e.dataVersion === v);
  }

  // ------------------------------------------------------------ rendering
  function note(): string {
    const s = lab.stats;
    const parts: string[] = [];
    if (!s || s.dataKind === 'sim') {
      parts.push(
        '<b>Simulated prices are random by design.</b> Anything the lab finds here is luck, and the live record will expose it: that is the learning loop working. For research that means something, import real broker history (Backtest tab → Import OHLC CSV) and set Lab data to it.',
      );
    } else {
      parts.push(`<b>Researching real data:</b> ${escapeHtml(s.dataLabel)}. Trades still run on the simulated feed (paper money).`);
    }
    parts.push('New strategies trade on probation at small risk and earn full risk only after 15+ profitable live trades. Losers get benched for good.');
    parts.push('This tab must stay open for the autopilot to run; for true 24/7 run the headless bot (see README).');
    return parts.join(' ');
  }

  function renderLab(): void {
    const s = lab.stats;
    $('ap-pulse').className = `ap-pulse ${lab.running ? 'on' : ''}`;
    const tile = (k: string, v: string, sub = '') =>
      `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    $('ap-labstats').innerHTML = s
      ? [
          tile('Status', lab.running ? 'Searching' : 'Paused', lab.inWorker ? 'background worker' : 'in page'),
          tile('Generation', integer(s.generation)),
          tile('Tested', integer(s.tested), `${lab.rate}/min`),
          tile('Best score', Number.isFinite(s.bestScore) && s.bestScore !== null ? s.bestScore.toFixed(2) : '—', 'min(train, valid) SQN'),
          tile('Improved', s.lastImprovement ? `${duration(Date.now() - s.lastImprovement)} ago` : '—'),
          tile('Data', s.dataKind === 'real' ? 'REAL' : 'SIM', `${integer(s.bars)} bars`),
        ].join('')
      : tile('Status', 'Starting');
    const deployed = new Set(ap.state.deployments.map((d) => d.id));
    const banned = new Set(ap.state.blacklist);
    const v = s?.dataVersion;
    const rows = lab.hof
      .map((e, i) => {
        const badge = banned.has(e.id)
          ? '<span class="badge benched">benched</span>'
          : deployed.has(e.id)
            ? '<span class="badge active">deployed</span>'
            : e.robust
              ? '<span class="badge robust">robust</span>'
              : e.validated
                ? '<span class="badge validated">validated</span>'
                : '<span class="badge">candidate</span>';
        const stale = e.dataVersion !== v ? ' <span class="dim" title="Being re-tested on the latest data">↻</span>' : '';
        const pairs =
          typeof e.breadth === 'number' && Number.isFinite(e.breadth) && e.breadthN
            ? `<span class="${e.breadthN >= 3 && e.breadth < 0.6 ? 'neg' : ''}">${Math.round(e.breadth * e.breadthN)}/${e.breadthN}</span>`
            : '—';
        return `<tr><td class="dim">${i + 1}</td><td class="desc">${escapeHtml(e.desc)}${stale}</td><td class="r">${seg(e.train)}</td><td class="r">${seg(e.val)}</td><td class="r">${seg(e.hold)}</td><td class="r">${pairs}</td><td class="r">${typeof e.score === 'number' ? e.score.toFixed(2) : '—'}</td><td>${badge}</td></tr>`;
      })
      .join('');
    $('ap-hof').innerHTML =
      `<thead><tr><th>#</th><th>Strategy</th><th class="r" title="First 60% of history: what evolution optimises">Train</th><th class="r" title="Next 20%: ranks the leaderboard">Valid</th><th class="r" title="Last 20%: never used for ranking">Holdout</th><th class="r" title="Pairs profitable out-of-sample (robust needs 60%)">Pairs +</th><th class="r">Score</th><th></th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="8" class="dim">No strategy has passed the first filters yet. The lab keeps searching.</td></tr>'}</tbody>`;
  }

  function depRow(d: Deployment): string {
    const l = d.live;
    const open = Object.values(ap.state.owned).filter((o) => o.dep === d.id).length;
    const bench = d.status === 'benched' ? '' : `<button type="button" data-bench="${d.id}" title="Stop this strategy for good">Bench</button>`;
    return `<tr>
      <td class="desc">${escapeHtml(d.desc)}<span class="dim" style="display:block">${escapeHtml(d.note)}</span></td>
      <td><span class="badge ${d.status}">${d.status}</span></td>
      <td class="r">${l.n}${open ? ` <span class="dim">+${open} open</span>` : ''}</td>
      <td class="r ${cls(liveMean(l))}">${l.n ? R(liveMean(l)) : '—'}</td>
      <td class="r ${cls(l.net)}">${l.n ? moneySigned(l.net) : '—'}</td>
      <td class="r">${d.status === 'benched' ? '—' : ap.riskFor(d) + '%'}</td>
      <td class="r dim" title="Validation average in history">${R(d.expected.valMeanR)}</td>
      <td><span class="act">${bench}</span></td></tr>`;
  }

  function renderDeployments(): void {
    const list = [...ap.state.deployments, ...ap.state.retired.slice(0, 5)];
    $('ap-deps').innerHTML =
      `<thead><tr><th>Strategy</th><th>Status</th><th class="r">Live trades</th><th class="r">Avg R</th><th class="r">Net</th><th class="r">Risk</th><th class="r">History</th><th></th></tr></thead>` +
      `<tbody>${list.map(depRow).join('') || `<tr><td colspan="8" class="dim">${cfg().enabled ? `Waiting for the lab: it deploys only validated strategies, after testing at least ${MIN_TESTED_BEFORE_DEPLOY}.` : 'Switch on Auto-trading to deploy the lab’s best strategies.'}</td></tr>`}</tbody>`;
    const next = bucketStart(Date.now(), cfg().tf) + TF_MS[cfg().tf];
    setText($('ap-next'), cfg().enabled ? `signals checked at every ${cfg().tf} close · next in ${duration(next - Date.now())}` : '');
    const lessons = ap.state.lessons;
    $('ap-lessons').innerHTML = lessons.length
      ? lessons
          .slice(0, 8)
          .map(
            (l) =>
              `<li><span class="badge ${l.status}">${l.status}</span> ${escapeHtml(l.label)}<span class="dim">${escapeHtml(l.detail)} · ${new Date(l.createdAt).toLocaleDateString()}</span></li>`,
          )
          .join('')
      : '<li class="dim">No lessons yet. After 25+ autopilot trades the learner looks for conditions where losses cluster, then checks history before adopting a rule.</li>';
    const j = ap.state.journal;
    $('ap-sessions').innerHTML =
      `<thead><tr><th>Session (UTC)</th><th class="r">Trades</th><th class="r">Avg R</th><th class="r">Win %</th></tr></thead><tbody>` +
      SESSION_NAMES.map((name, i) => {
        const rs = j.filter((e) => e.ctx.session === i).map((e) => e.r);
        const m = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
        const w = rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : NaN;
        return `<tr><td>${name}</td><td class="r">${rs.length}</td><td class="r ${Number.isNaN(m) ? '' : cls(m)}">${rs.length ? R(m) : '—'}</td><td class="r">${rs.length ? w.toFixed(0) + '%' : '—'}</td></tr>`;
      }).join('') +
      '</tbody>';
  }

  function renderChip(): void {
    const c = cfg();
    const n = ap.liveDeployments().length;
    const chip = $('auto-chip');
    setText(chip, c.enabled ? `AUTO ON · ${n}` : 'AUTO OFF');
    chip.className = `chip chip-btn ${c.enabled ? 'auto-on' : ''}`;
    setText($('cnt-ap'), c.enabled ? `ON ${n}` : 'OFF');
  }

  function render(): void {
    renderChip();
    if (app.prefs.tab !== 'autopilot') return;
    const n = note();
    const ne = $('ap-note');
    if (ne.innerHTML !== n) ne.innerHTML = n;
    renderLab();
    renderDeployments();
  }

  $('auto-chip').addEventListener('click', () => app.setTab('autopilot'));

  lab.onProgress = () => {
    if (cfg().enabled) ap.sync(currentHof(), lab.stats?.tested ?? 0);
    if (ap.state.blacklist.length > bannedSent) {
      lab.ban(ap.state.blacklist.slice(bannedSent));
      bannedSent = ap.state.blacklist.length;
    }
    if (app.prefs.tab === 'autopilot') renderLab();
    renderChip();
  };

  syncControls();
  refreshData();
  if (ap.state.blacklist.length) {
    lab.ban(ap.state.blacklist);
    bannedSent = ap.state.blacklist.length;
  }
  lab.run(cfg().lab, duty);
  render();

  return {
    render,
    tick: () => {
      // New bars arrive over time: give the lab fresh history every 30 minutes.
      if (cfg().labData === 'sim' && Date.now() - lastDataRefresh > 30 * 60_000) refreshData();
      if (app.prefs.tab === 'autopilot') renderDeployments();
      renderChip();
    },
    setEnabled,
    setLab,
    csvAvailable: () => {
      const opt = dataSel.querySelector<HTMLOptionElement>('option[value="csv"]')!;
      opt.disabled = !app.csv;
      if (app.csv) opt.textContent = `Imported: ${app.csv.name}`;
      if (cfg().labData === 'csv') refreshData();
      syncControls();
    },
    currentHof,
  };
}
