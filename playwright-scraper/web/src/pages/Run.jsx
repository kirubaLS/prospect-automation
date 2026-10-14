import { useEffect, useMemo, useState } from 'react';
import { api, companyKey } from '../lib/api.js';
import { LEGENDS, prTag, isGood } from '../lib/icp.js';
import { Label, Stat, Empty, Pill, useToast, useConfirm, useInterval, busy } from '../components/ui.jsx';

function Grid({ cols, children }) {
  return <div className="grid-wrap"><table className="grid"><thead><tr>{cols.map((c, i) => <th key={i} className={c.num ? 'num' : ''}>{c.label ?? c}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
function Link({ href, children }) { return href ? <a href={href} target="_blank" rel="noopener">{children} ↗</a> : <span className="hint" style={{ margin: 0 }}>—</span>; }
function CompanyRow({ r, span, tally, onNext, canEdit }) {
  const cls = r.companyStatus === 'Found' ? 'found' : r.companyStatus === 'No people found' ? 'np' : 'nf';
  return (
    <tr className="co"><td colSpan={span}>
      <span className={'st ' + cls}>{r.companyStatus}</span>{r.company}
      {tally && <span className="tally">{tally}</span>}
      {r.industry && <span className="note"> · {r.industry}{r.employees ? ` · ${r.employees} emp.` : ''}</span>}
      {r.note && <span className="note"> · {r.note}</span>}
      {r.autoNote && <span className="note"> · {r.autoNote}</span>}
      {canEdit && r.needsRound > 0 && <button className="ibtn rep" style={{ marginLeft: 8 }} onClick={() => onNext(companyKey(r), r.needsRound)}>Next round ({r.needsRound})</button>}
    </td></tr>
  );
}

export default function Run({ job, refresh }) {
  const toast = useToast(); const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('people');
  const [picked, setPicked] = useState(() => new Set());
  const [working, setWorking] = useState(false);
  const live = busy(job);
  const canEdit = !live && job.status !== 'queued';

  async function load() { try { setRows(await api.rows(job.id)); } catch {} finally { setLoading(false); } }
  useEffect(() => { setLoading(true); setPicked(new Set()); load(); }, [job.id]); // eslint-disable-line
  useInterval(load, 3000, live);
  // one more fetch whenever the server-side state moves (done, labels in, rows trimmed)
  useEffect(() => { load(); }, [job.status, job.activity && job.activity.status, job.auto && job.auto.stage, job.auto && job.auto.round, job.progress && job.progress.prospects]); // eslint-disable-line

  const people = rows.filter((r) => r.companyStatus === 'Found' && r.name);
  const withUrl = people.filter((r) => r.profileUrl);
  const unlabelled = withUrl.filter((r) => !r.activity && !r.activityPending);
  const tally = useMemo(() => { const by = {}; for (const x of people) { const k = companyKey(x); (by[k] = by[k] || { n: 0, p: {} }).n++; const t = prTag(x); if (t) by[k].p[t] = (by[k].p[t] || 0) + 1; } const out = {}; for (const [k, t] of Object.entries(by)) out[k] = `${t.n} ${t.n === 1 ? 'person' : 'people'}${Object.keys(t.p).length ? ' · ' + Object.entries(t.p).sort().map(([a, b]) => `${a} ×${b}`).join(', ') : ''}`; return out; }, [rows]);
  const p = job.progress || {}, a = job.activity, ap = (a && a.progress) || {};
  const scheme = (job.params && job.params.activityScheme) || 'standard';
  const legend = LEGENDS[scheme] || LEGENDS.standard;

  async function act(fn, okMsg) { setWorking(true); try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); } catch (e) { toast(e.message, 'err'); } finally { setWorking(false); await load(); refresh(); } }
  async function removeOne(r, replace) {
    const ok = await confirm({ title: replace ? `Replace ${r.name}?` : `Delete ${r.name}?`, body: replace ? 'Removes this person and fetches the next matching person for the company (0 Apollo credits).' : 'Removes this person for good. No replacement is searched.', ok: replace ? 'Replace' : 'Delete', danger: !replace });
    if (!ok) return;
    const idx = rows.indexOf(r);
    await act(() => api.removeRow(job.id, idx, r.name, replace), (d) => d.message);
  }
  async function bulk(replace) {
    const sel = [...picked].map((i) => rows[i]).filter(Boolean);
    const ok = await confirm({ title: `${replace ? 'Replace' : 'Delete'} ${sel.length} selected?`, body: replace ? 'Each is removed and the next match for their company is fetched.' : 'They are removed for good.', ok: replace ? 'Replace all' : 'Delete all', danger: !replace });
    if (!ok) return;
    setWorking(true);
    const order = [...picked].sort((x, y) => y - x);
    let done = 0, added = 0;
    for (const i of order) { const r = rows[i]; if (!r) continue; try { const d = await api.removeRow(job.id, i, r.name, replace); done++; if (d.replacement) added++; } catch {} }
    setPicked(new Set()); setWorking(false);
    toast(`${done} ${replace ? 'replaced' : 'deleted'}${replace ? `, ${added} new people added` : ''}`, 'ok');
    await load(); refresh();
  }
  async function nextRound(k, round) {
    const ok = await confirm({ title: k ? `Run round ${round} for this company?` : 'Run the next round for every short company?', body: 'Searches the further priority groups, checks LinkedIn activity, and keeps the active people.', ok: 'Run round' });
    if (!ok) return;
    await act(() => api.nextRound(job.id, k), (d) => d.message || `Round ${d.round} started`);
  }
  async function checkActivity(all) {
    if (all && !(await confirm({ title: 'Recheck everyone?', body: 'Existing labels are discarded and everyone is checked again.', ok: 'Recheck all', danger: true }))) return;
    await act(() => api.startActivity(job.id, all), (d) => d.message || `Checking ${d.total} ${d.incremental ? 'new ' : ''}people…`);
  }

  const toggle = (i) => setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const Acts = ({ r }) => { const i = rows.indexOf(r); return canEdit ? <span className="acts"><input type="checkbox" className="pick" checked={picked.has(i)} onChange={() => toggle(i)} /><button className="ibtn rep" disabled={working} onClick={() => removeOne(r, true)}>Replace</button><button className="ibtn del" disabled={working} onClick={() => removeOne(r, false)}>Delete</button></span> : null; };

  const autoLine = job.status === 'automating' ? `Automation · ${(job.auto && job.auto.stage) || ''}${ap.current ? ' · ' + ap.current : ''}` : job.status === 'queued' ? `Queued — ${job.ahead} ahead of you` : job.status === 'running' ? (p.current ? 'Working on: ' + p.current : 'Starting…') : job.error ? 'Failed: ' + job.error : `Finished ${job.finishedAt ? new Date(job.finishedAt).toLocaleString() : ''}`;
  const credits = p.apollo ? ` · Apollo credits ≈ ${p.apollo.estimatedCredits} · web searches ${p.apollo.webSearches || 0}` : '';

  return (
    <section className="card results">
      <div className="res-head">
        <div className="bar"><i style={{ width: p.total ? Math.round((p.done / p.total) * 100) + '%' : 0 }} /></div>
        <div className="stats">
          <Stat n={p.total} label="Companies" /><Stat n={p.found} label="Found" /><Stat n={p.notFound} label="Not found" /><Stat n={p.noPeople} label="No people" /><Stat n={p.prospects} label="People" />
          {a && <><Stat n={ap.high} label={legend[0][1]} /><Stat n={ap.medium} label={legend[1][1]} /><Stat n={ap.low} label={legend[2][1]} /></>}
        </div>
        <div className="hint">{autoLine}{credits}</div>
        {a && job.auto && job.auto.stage === 'done' && <div className="hint">Automation: {job.auto.filled} compan{job.auto.filled === 1 ? 'y' : 'ies'} filled, {job.auto.short} short{job.auto.short ? ' - press Next round on a company, or the button in the top bar for all' : ''}.</div>}
        <div className="legend">{legend.map(([k, l, d]) => <span key={k}><Label value={l} /> {d}</span>)}</div>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button className={'tab' + (tab === 'people' ? ' active' : '')} onClick={() => setTab('people')}>Found people<span className="n">{people.length}</span></button>
          <button className={'tab' + (tab === 'activity' ? ' active' : '')} onClick={() => setTab('activity')}>LinkedIn activity{a && <span className="n">{ap.done}/{ap.total}</span>}</button>
          <button className={'tab' + (tab === 'final' ? ' active' : '')} onClick={() => setTab('final')}>Final list<span className="n">{people.filter(isGood).length || people.length}</span></button>
        </div>
        {picked.size > 0 && <div className="bulk">{picked.size} selected <button className="ibtn rep" onClick={() => bulk(true)}>Replace selected</button><button className="ibtn del" onClick={() => bulk(false)}>Delete selected</button><button className="ibtn" onClick={() => setPicked(new Set())}>Clear</button></div>}
        {tab === 'activity' && <div className="row" style={{ margin: '6px 0' }}>
          <button className="btn sm" disabled={live || working || !unlabelled.length} onClick={() => checkActivity(false)}>{withUrl.length && !unlabelled.length ? 'All labelled' : unlabelled.length < withUrl.length ? `Check ${unlabelled.length} new` : 'Check activity'}</button>
          {withUrl.length > unlabelled.length && <button className="btn secondary sm" disabled={live || working} onClick={() => checkActivity(true)}>Recheck all</button>}
          {a && ['running', 'filling'].includes(a.status) && <button className="btn danger sm" onClick={() => act(() => api.stopActivity(job.id), 'Stopping…')}>Stop</button>}
        </div>}
      </div>

      {loading ? <div className="body"><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '80%', marginTop: 8 }} /><div className="skeleton" style={{ width: '40%', marginTop: 8 }} /></div>
      : !rows.length ? <Empty title={live ? 'Working…' : 'No results'}>{live ? 'People appear here as each company is processed.' : 'This run produced no rows.'}</Empty>
      : tab === 'people' ? (
        <Grid cols={['Company', 'Name', 'Designation', 'Location', 'LinkedIn', '']}>
          {rows.map((r, i) => r.companyStatus !== 'Found' || !r.name
            ? <CompanyRow key={i} r={r} span={6} tally={tally[companyKey(r)]} onNext={nextRound} canEdit={canEdit} />
            : [ (i === 0 || companyKey(rows[i - 1]) !== companyKey(r)) && <CompanyRow key={'h' + i} r={r} span={6} tally={tally[companyKey(r)]} onNext={nextRound} canEdit={canEdit} />,
                <tr key={i}><td /><td>{r.name}{r.replaced && <div className="hint" style={{ margin: 0 }}>replaces {r.replaced}</div>}</td><td>{r.title}{prTag(r) && <span className="tag">{prTag(r)}</span>}</td><td>{r.location}</td><td>{r.profileUrl ? <Link href={r.profileUrl}>open</Link> : <span className="hint" style={{ margin: 0 }}>{r.note || 'not resolved'}</span>}</td><td><Acts r={r} /></td></tr> ])}
        </Grid>
      ) : tab === 'activity' ? (
        <Grid cols={['Company', 'Name', 'Activity', 'Why', 'Last', { label: 'Connections', num: true }, { label: 'Followers', num: true }, 'Proof', '']}>
          {withUrl.length ? withUrl.map((r) => <tr key={rows.indexOf(r)}><td>{r.company}</td><td>{r.name}<div className="hint" style={{ margin: 0 }}>{r.title}</div></td><td>{r.activity ? <Label value={r.activity} /> : r.activityPending ? <span className="hint" style={{ margin: 0 }}>checking…</span> : '—'}</td><td className="why">{r.activityReason}</td><td>{r.activityDate}</td><td className="num"><b>{r.connections ?? ''}</b></td><td className="num">{r.followers ?? ''}</td><td>{r.activityProof ? <Link href={r.activityProof}>open</Link> : null}</td><td><Acts r={r} /></td></tr>)
          : <tr><td colSpan={9}><Empty title="No LinkedIn links yet">Activity can be checked once people have LinkedIn links.</Empty></td></tr>}
        </Grid>
      ) : (
        <Grid cols={['Company', 'Name', 'Designation', 'Location', 'LinkedIn', 'Activity', 'Why', 'Proof', 'Last', { label: 'Conn.', num: true }, '']}>
          {rows.map((r, i) => r.companyStatus !== 'Found' || !r.name
            ? <CompanyRow key={i} r={r} span={11} onNext={nextRound} canEdit={canEdit} />
            : <tr key={i}><td>{r.company}</td><td>{r.name}</td><td>{r.title}{prTag(r) && <span className="tag">{prTag(r)}</span>}</td><td>{r.location}</td><td className="nw">{r.profileUrl ? <Link href={r.profileUrl}>open</Link> : null}</td><td className="nw">{r.activity ? <Label value={r.activity} /> : r.activityPending ? <span className="hint" style={{ margin: 0 }}>checking…</span> : null}</td><td className="why">{r.activityReason}</td><td className="nw">{r.activityProof ? <Link href={r.activityProof}>proof</Link> : null}</td><td className="nw">{r.activityDate}</td><td className="num">{r.connections ?? ''}</td><td><Acts r={r} /></td></tr>)}
        </Grid>
      )}
    </section>
  );
}
