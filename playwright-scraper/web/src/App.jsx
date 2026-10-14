import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import Composer from './pages/Composer.jsx';
import Run from './pages/Run.jsx';
import { Pill, useToast, useConfirm, useInterval, useStored, statusKind, statusText, busy } from './components/ui.jsx';

const STEPS = [['Choose the client project', 'Its designations, region and rules are saved.'], ['Paste the companies', 'One per line: website, LinkedIn page or name.'], ['Find prospects', 'We find people, check LinkedIn activity, keep the active ones.'], ['Copy to your sheet', 'Copy for spreadsheet or download Excel.']];

export default function App() {
  const toast = useToast(); const confirm = useConfirm();
  const [info, setInfo] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [busyInfo, setBusyInfo] = useState(null);
  const [currentId, setCurrentId] = useStored('currentJob', null);
  const [composer, setComposer] = useState(true);
  const [theme, setTheme] = useStored('theme', document.documentElement.dataset.theme || '');
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }, [theme]);
  // Three looks share one app: "workspace" (dark sidebar), "clean" (all light), "focus" (top nav, one column).
  const [skin, setSkin] = useStored('skin', (new URLSearchParams(location.search).get('skin')) || 'workspace');
  useEffect(() => { document.documentElement.dataset.skin = skin; }, [skin]);
  const SkinPick = ({ cls }) => <div className={'skinpick ' + (cls || '')}>{['workspace', 'clean', 'focus'].map((k) => <button key={k} className={skin === k ? 'on' : ''} onClick={() => setSkin(k)} title={'Look: ' + k}>{k}</button>)}</div>;

  const refresh = useCallback(async () => { try { const j = await api.jobs(); setJobs(j.jobs); setBusyInfo(j.busy); } catch {} }, []);
  useEffect(() => { api.presets().then(setInfo).catch((e) => toast('Could not load projects: ' + e.message, 'err')); refresh(); }, []); // eslint-disable-line
  const job = jobs.find((j) => j.id === currentId) || null;
  useInterval(refresh, busy(job) || jobs.some(busy) ? 2500 : 15000);
  useEffect(() => { if (job) setComposer(false); }, [!!job]); // eslint-disable-line

  async function startJob(params, file) { const r = await api.start(params, file); return r; }
  function onStarted(j) { setCurrentId(j.id); setComposer(false); refresh(); }
  async function cancel(j) {
    const ok = await confirm({ title: j.status === 'queued' ? 'Remove from the queue?' : 'Cancel the running job?', body: j.status === 'queued' ? 'The run has not started yet.' : 'Companies already processed stay available.', ok: 'Yes, cancel', danger: true });
    if (!ok) return;
    try { const d = await api.stop(j.id); toast(d.status === 'stopping' ? 'Cancelling after the current company…' : 'Removed from the queue.', 'ok'); } catch (e) { toast(e.message, 'err'); }
    refresh();
  }
  async function copy(j) {
    try { const text = await api.tsv(j.id); await navigator.clipboard.writeText(text); const n = text.split('\n').filter(Boolean).length - 1; toast(`${n} rows copied - paste into a spreadsheet (Ctrl+V)`, 'ok'); }
    catch (e) { toast('Copy failed: ' + e.message, 'err'); }
  }
  async function nextAll(j) {
    const ok = await confirm({ title: `Run the next round for ${j.auto.short} short compan${j.auto.short === 1 ? 'y' : 'ies'}?`, body: 'Searches the further priority groups, checks LinkedIn activity, keeps the active people.', ok: 'Run round' });
    if (!ok) return;
    try { const d = await api.nextRound(j.id); toast(d.message || `Round ${d.round} started`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    refresh();
  }

  const presets = (info && info.presets) || [];
  const summary = job && job.params ? `${job.params.peoplePerCompany}/company · ${job.params.locations?.length ? job.params.locations.length === 1 ? job.params.locations[0] : job.params.locations.length + ' regions' : 'anywhere'} · ${job.params.priorities ? job.params.priorities.length + ' priority groups' : (job.params.icpKeywords || []).length + ' designations'}${job.params.auto ? ` · automatic ${job.params.candidatePool} → ${job.params.finalTarget}` : ''}` : '';

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><i>⌕</i> Prospect Finder</div>
        <button className="btn full" onClick={() => { setComposer(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>+ New run</button>
        <div className="side-h">Projects</div>
        <nav className="nav">{presets.length ? presets.map((p) => <button key={p.slug} className="navitem" onClick={() => { try { localStorage.setItem('form.presetSlug', p.slug); } catch {} setComposer(true); window.dispatchEvent(new CustomEvent('pick-project', { detail: p.slug })); }}><span>{p.name}</span><small>{p.peoplePerCompany}/co{p.activityCheck ? ' · activity' : ''}</small></button>) : <div className="hint">{info ? 'No projects on the server.' : 'Loading…'}</div>}</nav>
        <div className="side-h">Runs <small>this browser</small></div>
        <div className="runlist">{jobs.length ? jobs.map((j) => <button key={j.id} className={'runitem' + (j.id === currentId ? ' active' : '')} onClick={() => { setCurrentId(j.id); setComposer(false); }}><div><div className="t">{j.label}</div><div className="s">{j.project ? j.project.name + ' · ' : ''}{j.progress.prospects} people · {new Date(j.startedAt || j.queuedAt).toLocaleDateString()}</div></div><Pill kind={statusKind(j.status)} live={busy(j)}>{j.status === 'queued' ? `queued ${j.ahead}` : j.status === 'running' ? 'finding' : j.status === 'automating' ? 'checking' : j.status}</Pill></button>) : <div className="hint" style={{ padding: '6px 9px' }}>No runs yet.</div>}</div>
        <div className="side-foot">
          {info && !info.apolloKeySet && <Pill kind="bad">Apollo key missing on server</Pill>}
          {busyInfo && busyInfo.running && !busyInfo.mine && <span>Another user's run is in progress{busyInfo.queued ? ` · ${busyInfo.queued} waiting` : ''}. Yours will queue.</span>}
          <button className="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>◐ {theme === 'dark' ? 'Light' : 'Dark'} theme</button>
          <SkinPick />
        </div>
      </aside>

      <div className="main">
        <div className="topnav">
          <div className="brand"><i>⌕</i> Prospect Finder</div>
          <div className="ptabs">{presets.map((p) => <button key={p.slug} className={'ptab' + (job && job.project && job.project.slug === p.slug ? ' active' : '')} onClick={() => { try { localStorage.setItem('form.presetSlug', p.slug); } catch {} setComposer(true); window.dispatchEvent(new CustomEvent('pick-project', { detail: p.slug })); }}>{p.name}</button>)}</div>
          <div className="spacer" />
          <button className="btn sm" onClick={() => { setComposer(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>+ New run</button>
          {jobs.length > 0 && <select className="input" value={currentId || ''} onChange={(e) => { setCurrentId(e.target.value || null); setComposer(!e.target.value); }}><option value="">Runs…</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label} · {j.status}</option>)}</select>}
          <button className="btn ghost sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>◐</button>
          <SkinPick />
        </div>
        <div className="topbar">
          <div className="title">
            <Pill kind={job ? statusKind(job.status) : ''} live={busy(job)}>{statusText(job)}</Pill>
            {job && <div><h1>{job.project && !String(job.label).startsWith(job.project.name) ? job.project.name + ' · ' : ''}{job.label}{job.project && job.project.edited ? ' · edited' : ''}</h1><div className="sub">{summary}</div></div>}
            {!job && <h1>New run</h1>}
          </div>
          <div className="actions">
            {job && <button className="btn secondary sm" onClick={() => setComposer((c) => !c)}>{composer ? '▲ Hide setup' : '⚙ Setup'}</button>}
            {job && job.auto && job.status === 'done' && job.auto.short > 0 && <button className="btn sm" onClick={() => nextAll(job)}>▶ Next round for {job.auto.short} short compan{job.auto.short === 1 ? 'y' : 'ies'}</button>}
            {job && busy(job) && job.status !== 'done' && <button className="btn danger sm" onClick={() => cancel(job)}>✕ Cancel</button>}
            {job && <button className="btn sm" onClick={() => copy(job)}>⎘ Copy for spreadsheet</button>}
            {job && <a className="btn secondary sm" href={api.downloadUrl(job.id, 'xlsx')}>⬇ Excel</a>}
            {job && <a className="btn secondary sm" href={api.downloadUrl(job.id, 'csv')}>⬇ CSV</a>}
          </div>
        </div>
        <div className="content">
          {(composer || !job) && <>
            <div className="steps">{STEPS.map(([t, d], i) => <div className="step" key={i}><b>{i + 1}</b><span>{t}</span><small>{d}</small></div>)}</div>
            <ComposerBridge presets={presets} info={info} onStarted={onStarted} startJob={startJob} running={!!(busyInfo && busyInfo.mine)} />
          </>}
          {job && <Run job={job} refresh={refresh} />}
        </div>
      </div>
    </div>
  );
}

// Lets the sidebar project list drive the Composer's project select.
function ComposerBridge(props) {
  const [k, setK] = useState(0);
  useEffect(() => { const h = () => setK((x) => x + 1); window.addEventListener('pick-project', h); return () => window.removeEventListener('pick-project', h); }, []);
  return <Composer key={k} {...props} serverInfo={props.info} />;
}
