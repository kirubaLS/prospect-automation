import { useState } from 'react';
import { companyKey } from '../lib/api.js';
import { prTag, isGood, LEGENDS } from '../lib/icp.js';
import { Label, Stat, Empty, useStored } from '../components/ui.jsx';
import { useRun } from '../lib/useRun.js';
import { CardsView, SplitView, Link, PersonActions, BulkBar, Legend, TitleTag } from './views.jsx';

function Grid({ cols, children }) {
  return <div className="grid-wrap"><table className="grid"><thead><tr>{cols.map((c, i) => <th key={i} className={c.num ? 'num' : ''}>{c.label ?? c}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
function CompanyRow({ c, span, run }) {
  const r = c.header; const cls = c.status === 'Found' ? 'found' : c.status === 'No people found' ? 'np' : 'nf';
  const tally = c.status === 'Found' ? `${c.people.length} ${c.people.length === 1 ? 'person' : 'people'}${Object.keys(c.tally).length ? ' · ' + Object.entries(c.tally).sort().map(([a, b]) => `${a} ×${b}`).join(', ') : ''}` : '';
  return <tr className="co"><td colSpan={span}><span className={'st ' + cls}>{c.status}</span>{c.name}{tally && <span className="tally">{tally}</span>}{c.industry && <span className="note"> · {c.industry}{c.employees ? ` · ${c.employees} emp.` : ''}</span>}{c.note && <span className="note"> · {c.note}</span>}{c.autoNote && <span className="note"> · {c.autoNote}</span>}{run.canEdit && c.needsRound > 0 && <button className="ibtn rep" style={{ marginLeft: 8 }} onClick={() => run.nextRound(c.key, c.needsRound)}>Next round ({c.needsRound})</button>}</td></tr>;
}

export function RunHeader({ job, run }) {
  const p = job.progress || {}, a = job.activity, ap = (a && a.progress) || {};
  const scheme = (job.params && job.params.activityScheme) || 'standard'; const legend = LEGENDS[scheme] || LEGENDS.standard;
  const line = job.status === 'automating' ? `Automation · ${(job.auto && job.auto.stage) || ''}${ap.current ? ' · ' + ap.current : ''}` : job.status === 'queued' ? `Queued — ${job.ahead} ahead of you` : job.status === 'running' ? (p.current ? 'Working on: ' + p.current : 'Starting…') : job.error ? 'Failed: ' + job.error : `Finished ${job.finishedAt ? new Date(job.finishedAt).toLocaleString() : ''}`;
  const credits = p.apollo ? ` · Apollo credits ≈ ${p.apollo.estimatedCredits} · web searches ${p.apollo.webSearches || 0}` : '';
  return (
    <div className="res-head">
      <div className="bar"><i style={{ width: p.total ? Math.round((p.done / p.total) * 100) + '%' : 0 }} /></div>
      <div className="stats"><Stat n={p.total} label="Companies" /><Stat n={p.found} label="Found" /><Stat n={p.notFound} label="Not found" /><Stat n={p.noPeople} label="No people" /><Stat n={run ? run.people.length : p.prospects} label="People kept" />{a && <><Stat n={ap.high} label={legend[0][1]} /><Stat n={ap.medium} label={legend[1][1]} /><Stat n={ap.low} label={legend[2][1]} /></>}</div>
      <div className="hint">{line}{credits}</div>
      {a && job.auto && job.auto.stage === 'done' && <div className="hint">Automation: {job.auto.filled} compan{job.auto.filled === 1 ? 'y' : 'ies'} filled, {job.auto.short} short{job.auto.short ? ' - press Next round on a company, or the button in the top bar for all' : ''}{job.auto.reserve ? ` · ${job.auto.reserve} people still in reserve` : ''}{job.expansions ? ` · designations widened for ${job.expansions} compan${job.expansions === 1 ? 'y' : 'ies'}` : ''}.</div>}
      <Legend scheme={scheme} />
    </div>
  );
}

export default function Run({ job, refresh }) {
  const run = useRun(job, refresh);
  const [tab, setTab] = useState('people');
  const [view, setView] = useStored('resultsView', 'split');
  const { rows, loading, people, withUrl, unlabelled, companies, live, canEdit, working } = run;
  const a = job.activity;

  const grid = tab === 'people' ? (
    <Grid cols={['Company', 'Name', 'Designation', 'Location', 'LinkedIn', '']}>
      {companies.map((c) => [<CompanyRow key={c.key} c={c} span={6} run={run} />, ...c.people.map((r) => <tr key={c.key + r.name + r.title}><td /><td>{r.name}{r.replaced && <div className="hint" style={{ margin: 0 }}>replaces {r.replaced}</div>}</td><td>{r.title}<TitleTag r={r} />{prTag(r) && <span className="tag">{prTag(r)}</span>}</td><td>{r.location}</td><td className="nw">{r.profileUrl ? <Link href={r.profileUrl}>open</Link> : <span className="hint" style={{ margin: 0 }}>{r.note || 'not resolved'}</span>}</td><td><PersonActions r={r} run={run} /></td></tr>)])}
    </Grid>
  ) : tab === 'activity' ? (
    <Grid cols={['Company', 'Name', 'Activity', 'Why', 'Last', { label: 'Connections', num: true }, { label: 'Followers', num: true }, 'Proof', '']}>
      {withUrl.length ? withUrl.map((r) => <tr key={rows.indexOf(r)}><td>{r.company}</td><td>{r.name}<div className="hint" style={{ margin: 0 }}>{r.title}<TitleTag r={r} /></div></td><td className="nw">{r.activity ? <Label value={r.activity} /> : r.activityPending ? <span className="hint" style={{ margin: 0 }}>checking…</span> : '—'}</td><td className="why">{r.activityReason}</td><td className="nw">{r.activityDate}</td><td className="num"><b>{r.connections ?? ''}</b></td><td className="num">{r.followers ?? ''}</td><td className="nw">{r.activityProof ? <Link href={r.activityProof}>open</Link> : null}</td><td><PersonActions r={r} run={run} /></td></tr>)
      : <tr><td colSpan={9}><Empty title="No LinkedIn links yet">Activity can be checked once people have LinkedIn links.</Empty></td></tr>}
    </Grid>
  ) : (
    <Grid cols={['Company', 'Name', 'Designation', 'Location', 'LinkedIn', 'Activity', 'Why', 'Proof', 'Last', { label: 'Conn.', num: true }, '']}>
      {companies.map((c) => c.people.length ? c.people.map((r) => <tr key={c.key + r.name}><td>{r.company}</td><td>{r.name}</td><td>{r.title}<TitleTag r={r} />{prTag(r) && <span className="tag">{prTag(r)}</span>}</td><td>{r.location}</td><td className="nw">{r.profileUrl ? <Link href={r.profileUrl}>open</Link> : null}</td><td className="nw">{r.activity ? <Label value={r.activity} /> : r.activityPending ? <span className="hint" style={{ margin: 0 }}>checking…</span> : null}</td><td className="why">{r.activityReason}</td><td className="nw">{r.activityProof ? <Link href={r.activityProof}>proof</Link> : null}</td><td className="nw">{r.activityDate}</td><td className="num">{r.connections ?? ''}</td><td><PersonActions r={r} run={run} /></td></tr>) : <CompanyRow key={c.key} c={c} span={11} run={run} />)}
    </Grid>
  );

  return (
    <section className="card results">
      <RunHeader job={job} run={run} />
      <div className="toolbar">
        <div className="tabs">
          {view === 'grid' && <><button className={'tab' + (tab === 'people' ? ' active' : '')} onClick={() => setTab('people')}>Found people<span className="n">{people.length}</span></button>
          <button className={'tab' + (tab === 'activity' ? ' active' : '')} onClick={() => setTab('activity')}>LinkedIn activity{a && <span className="n">{(a.progress || {}).done}/{(a.progress || {}).total}</span>}</button>
          <button className={'tab' + (tab === 'final' ? ' active' : '')} onClick={() => setTab('final')}>Final list<span className="n">{people.filter(isGood).length || people.length}</span></button></>}
          {view !== 'grid' && <span className="tab active">{view === 'cards' ? 'Companies' : 'Companies & people'}<span className="n">{companies.length}</span></span>}
        </div>
        <div className="row" style={{ margin: '6px 0', gap: 6 }}>
          {view === 'grid' && <BulkBar run={run} />}
          {(view !== 'grid' || tab === 'activity') && withUrl.length > 0 && <>
            <button className="btn sm" disabled={live || working || !unlabelled.length} onClick={() => run.checkActivity(false)}>{withUrl.length && !unlabelled.length ? 'All labelled' : unlabelled.length < withUrl.length ? `Check ${unlabelled.length} new` : 'Check activity'}</button>
            {withUrl.length > unlabelled.length && <button className="btn secondary sm" disabled={live || working} onClick={() => run.checkActivity(true)}>Recheck all</button>}
            {a && ['running', 'filling'].includes(a.status) && <button className="btn danger sm" onClick={run.stopActivity}>Stop</button>}</>}
          <span className="seg">{[['grid', 'Table'], ['cards', 'Cards'], ['split', 'Split']].map(([k, l]) => <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</span>
        </div>
      </div>
      {loading ? <div className="body" style={{ padding: 18 }}><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '80%', marginTop: 8 }} /><div className="skeleton" style={{ width: '40%', marginTop: 8 }} /></div>
      : !rows.length ? <Empty title={live ? 'Working…' : 'No results'}>{live ? 'People appear here as each company is processed.' : 'This run produced no rows.'}</Empty>
      : view === 'cards' ? <CardsView run={run} job={job} /> : view === 'split' ? <SplitView run={run} job={job} /> : grid}
    </section>
  );
}
