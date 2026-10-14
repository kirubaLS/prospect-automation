import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { icpGroups, typedToCsv } from '../lib/icp.js';
import { useToast, useConfirm, useStored, Pill, statusKind, statusText, busy } from '../components/ui.jsx';
import { useRun } from '../lib/useRun.js';
import { RunHeader } from './Run.jsx';
import { CardsView, SplitView, Legend } from './views.jsx';

const STEPS = ['Project', 'Companies', 'Running', 'Results'];

export default function Wizard({ presets, info, jobs, currentId, setCurrentId, refresh, onSwitchLayout, theme, setTheme }) {
  const toast = useToast(); const confirm = useConfirm();
  const job = jobs.find((j) => j.id === currentId) || null;
  const [step, setStep] = useState(job ? (busy(job) ? 2 : 3) : 0);
  const [slug, setSlug] = useStored('wiz.project', '');
  const preset = presets.find((p) => p.slug === slug) || null;
  const [count, setCount] = useState(''); const [pool, setPool] = useState('');
  const [typed, setTyped] = useState('');
  const [starting, setStarting] = useState(false);
  const typedInfo = useMemo(() => typedToCsv(typed), [typed]);
  const keep = parseInt(count, 10) || (preset ? preset.peoplePerCompany : 4), poolN = Math.max(keep, parseInt(pool, 10) || (preset ? preset.candidatePool : 7));
  const groups = useMemo(() => icpGroups(preset ? preset.icp : ''), [preset]);
  useEffect(() => { if (job && busy(job)) setStep(2); else if (job && step === 2) setStep(3); }, [job && job.status]); // eslint-disable-line

  async function start() {
    setStarting(true);
    try {
      const file = new File([typedInfo.csv], 'pasted-companies.csv', { type: 'text/csv' });
      const r = await api.start({ filename: file.name, preset: preset.slug, label: `${preset.name} - ${new Date().toLocaleDateString()}`, resolve: 'search', auto: '1', pool: String(poolN), ...(keep !== preset.peoplePerCompany ? { geography: preset.geography, icp: preset.icp, count: String(keep) } : {}) }, file);
      setCurrentId(r.job.id); setTyped(''); setStep(2); refresh();
      toast(r.job.ahead ? `Queued - ${r.job.ahead} ahead of you` : 'Run started', 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { setStarting(false); }
  }
  async function copy() { try { const t = await api.tsv(job.id); await navigator.clipboard.writeText(t); toast(`${t.split('\n').filter(Boolean).length - 1} rows copied - paste into a spreadsheet`, 'ok'); } catch (e) { toast('Copy failed: ' + e.message, 'err'); } }
  async function cancel() { if (!(await confirm({ title: 'Cancel this run?', body: 'Companies already processed stay available.', ok: 'Yes, cancel', danger: true }))) return; try { await api.stop(job.id); } catch (e) { toast(e.message, 'err'); } refresh(); }

  return (
    <div className="wizard">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="brand" style={{ color: 'var(--ink)', padding: 0 }}><i>⌕</i> Prospect Finder</div>
        <div className="row" style={{ margin: 0 }}>
          {jobs.length > 0 && <select className="input" style={{ width: 'auto', maxWidth: 300 }} value={currentId || ''} onChange={(e) => { setCurrentId(e.target.value || null); setStep(e.target.value ? 3 : 0); }}><option value="">Previous runs…</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label} · {j.status}</option>)}</select>}
          <button className="btn ghost sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>◐</button>
          <button className="btn ghost sm" onClick={onSwitchLayout}>Layout ▾</button>
        </div>
      </div>
      <div className="stepper">{STEPS.map((s, i) => <div key={s} className={'s' + (i === step ? ' on' : i < step ? ' done' : '')} onClick={() => { if (i < 2 || job) setStep(i); }} style={{ cursor: 'pointer' }}><b>{i < step ? '✓' : i + 1}</b>{s}</div>)}</div>

      {step === 0 && (
        <div className="wiz-card">
          <h2>Which client is this for?</h2><p className="lead">The project carries its designations, region and LinkedIn activity rules.</p>
          <div className="proj-grid">{presets.map((p) => <button key={p.slug} className={'proj' + (slug === p.slug ? ' on' : '')} onClick={() => setSlug(p.slug)}><b>{p.name}</b><small>{p.peoplePerCompany} per company · {p.geography || 'anywhere'}</small></button>)}</div>
          {preset && <div className="panel" style={{ marginTop: 18 }}>
            <div className="panel-h">Designations searched, in this order</div>
            {groups.map((g, i) => <div className="pgroup" key={i}><span className="pn">P{i + 1}</span>{g.slice(0, 10).map((t) => <span className="chip" key={t}>{t}</span>)}{g.length > 10 && <span className="hint" style={{ display: 'inline', margin: 0 }}>+{g.length - 10} more</span>}</div>)}
          </div>}
          {preset && <div className="grid2" style={{ marginTop: 14 }}>
            <div className="field"><label>People to keep per company</label><input className="input" type="number" min="1" max="25" value={count || preset.peoplePerCompany} onChange={(e) => setCount(e.target.value)} /><div className="hint">Final list: this many active people (HIGH + MEDIUM).</div></div>
            <div className="field"><label>People checked per round</label><input className="input" type="number" min="1" max="25" value={pool || preset.candidatePool || 7} onChange={(e) => setPool(e.target.value)} /><div className="hint">Found and checked before keeping the best.</div></div>
          </div>}
          <div className="wiz-nav"><span />{preset ? <button className="btn lg" onClick={() => setStep(1)}>Continue →</button> : <span className="hint">Pick a project to continue.</span>}</div>
        </div>
      )}

      {step === 1 && (
        <div className="wiz-card">
          <h2>Paste the companies</h2><p className="lead">One per line: a website, a LinkedIn company page, or just the name. {preset && <>Running <b>{preset.name}</b>: {poolN} people checked per company, {keep} kept.</>}</p>
          <textarea value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={'sharp.com\nhttps://www.linkedin.com/company/acme/\nAcme Pvt Ltd'} style={{ minHeight: 260, fontSize: 15 }} autoFocus />
          <div className="hint">{typedInfo.count ? `${typedInfo.count} compan${typedInfo.count === 1 ? 'y' : 'ies'} ready.` : 'A website per line works best; we find websites for names and LinkedIn pages for free.'}</div>
          <div className="wiz-nav"><button className="btn secondary" onClick={() => setStep(0)}>← Back</button><button className="btn lg" disabled={!typedInfo.count || !preset || starting} onClick={start}>{starting ? 'Starting…' : `▶ Find prospects for ${typedInfo.count || 0} compan${typedInfo.count === 1 ? 'y' : 'ies'}`}</button></div>
        </div>
      )}

      {step === 2 && job && <RunningScreen job={job} onCancel={cancel} onResults={() => setStep(3)} />}
      {step === 2 && !job && <div className="wiz-card"><h2>No run in progress</h2><div className="wiz-nav"><button className="btn secondary" onClick={() => setStep(0)}>Start a run</button></div></div>}

      {step === 3 && job && (
        <ResultsScreen job={job} refresh={refresh} onCopy={copy} onNew={() => { setStep(0); }} />
      )}
      {step === 3 && !job && <div className="wiz-card"><h2>No results yet</h2><div className="wiz-nav"><button className="btn secondary" onClick={() => setStep(0)}>Start a run</button></div></div>}
    </div>
  );
}

function RunningScreen({ job, onCancel, onResults }) {
  const run = useRun(job, () => {});
  const p = job.progress || {};
  const done = !busy(job);
  return (
    <div className="wiz-card">
      <div className="row" style={{ justifyContent: 'space-between' }}><div><h2>{done ? 'Finished' : job.status === 'queued' ? 'Waiting in the queue' : job.status === 'automating' ? 'Checking LinkedIn activity' : 'Finding people'}</h2><p className="lead" style={{ margin: 0 }}>{job.status === 'automating' ? ((job.auto && job.auto.stage) || '') : job.status === 'queued' ? `${job.ahead} run${job.ahead === 1 ? '' : 's'} ahead of you` : p.current ? `Working on ${p.current}` : ''}</p></div><Pill kind={statusKind(job.status)} live={!done}>{statusText(job)}</Pill></div>
      <div className="row" style={{ margin: '18px 0 6px', gap: 28 }}><div className="bignum">{p.done ?? 0}<small>of {p.total ?? 0} companies</small></div><div className="bignum">{run.people.length}<small>people found</small></div>{job.activity && <div className="bignum">{(job.activity.progress || {}).done ?? 0}<small>of {(job.activity.progress || {}).total ?? 0} checked</small></div>}</div>
      <div className="bar"><i style={{ width: p.total ? Math.round((p.done / p.total) * 100) + '%' : 0 }} /></div>
      <div className="liveco">{run.companies.map((c) => <div className="lc" key={c.key}><b>{c.name}</b><span>{c.status === 'Found' ? `${c.people.length} people · ${c.good} active` : c.status}{c.autoNote ? ` · ${c.autoNote}` : ''}</span></div>)}</div>
      <div className="wiz-nav">{!done ? <button className="btn danger" onClick={onCancel}>Cancel run</button> : <span />}<button className="btn lg" disabled={!done && !run.people.length} onClick={onResults}>{done ? 'See results →' : 'Peek at results so far →'}</button></div>
    </div>
  );
}

function ResultsScreen({ job, refresh, onCopy, onNew }) {
  const run = useRun(job, refresh);
  const [view, setView] = useStored('wiz.view', 'cards');
  return (
    <div className="card results">
      <RunHeader job={job} run={run} />
      <div className="toolbar">
        <div className="row" style={{ margin: '8px 0' }}>
          <button className="btn" onClick={onCopy}>⎘ Copy for spreadsheet</button>
          <a className="btn secondary sm" href={api.downloadUrl(job.id, 'xlsx')}>⬇ Excel</a>
          <a className="btn secondary sm" href={api.downloadUrl(job.id, 'csv')}>⬇ CSV</a>
          {job.auto && job.status === 'done' && job.auto.short > 0 && <button className="btn secondary sm" onClick={() => run.nextRound(null)}>▶ Next round for {job.auto.short} short</button>}
        </div>
        <div className="row" style={{ margin: '8px 0', gap: 6 }}><span className="seg">{[['cards', 'Cards'], ['split', 'Split']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</span><button className="btn ghost sm" onClick={onNew}>+ New run</button></div>
      </div>
      {run.loading ? <div style={{ padding: 18 }}><div className="skeleton" style={{ width: '60%' }} /></div> : view === 'split' ? <SplitView run={run} job={job} /> : <CardsView run={run} job={job} />}
    </div>
  );
}
