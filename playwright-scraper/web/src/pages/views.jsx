import { useState } from 'react';
import { Label, Empty } from '../components/ui.jsx';
import { prTag, isGood, LEGENDS } from '../lib/icp.js';

// Where the designation came from: LinkedIn (verified) or Apollo only.
export function TitleTag({ r }) {
  if (r.icpMismatch) return <span className="tag bad" title={r.icpMismatch}>NOT ICP</span>;
  if (!r.titleSource || /^apollo/i.test(r.titleSource)) return r.profileUrl ? <span className="tag muted" title={r.titleSource || 'Apollo designation, not verified on LinkedIn'}>Apollo</span> : null;
  return <span className="tag ok" title={r.titleSource + (r.apolloTitle && r.apolloTitle !== r.title ? ` (Apollo listed "${r.apolloTitle}")` : '')}>LinkedIn</span>;
}


export const Link = ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener">{children} ↗</a> : <span className="hint" style={{ margin: 0 }}>—</span>;
export function PersonActions({ r, run }) {
  if (!run.canEdit) return null;
  return <span className="acts"><input type="checkbox" className="pick" checked={run.isPicked(r)} onChange={() => run.toggle(r)} /><button className="ibtn rep" disabled={run.working} onClick={() => run.removeOne(r, true)}>Replace</button><button className="ibtn del" disabled={run.working} onClick={() => run.removeOne(r, false)}>Delete</button></span>;
}
export function BulkBar({ run }) {
  if (!run.picked.size) return null;
  return <div className="bulk">{run.picked.size} selected <button className="ibtn rep" onClick={() => run.bulk(true)}>Replace selected</button><button className="ibtn del" onClick={() => run.bulk(false)}>Delete selected</button><button className="ibtn" onClick={run.clearPicks}>Clear</button></div>;
}
export function Legend({ scheme }) { const l = LEGENDS[scheme] || LEGENDS.standard; return <div className="legend">{l.map(([k, n, d]) => <span key={k}><Label value={n} /> {d}</span>)}</div>; }
const statusClass = (s) => s === 'Found' ? 'found' : s === 'No people found' ? 'np' : 'nf';
const tallyText = (c) => `${c.people.length} ${c.people.length === 1 ? 'person' : 'people'}${Object.keys(c.tally).length ? ' · ' + Object.entries(c.tally).sort().map(([a, b]) => `${a} ×${b}`).join(', ') : ''}`;

// ---------- Cards: one card per company, people inside ----------
export function CardsView({ run, job }) {
  const [filter, setFilter] = useState('all');
  const target = job.params?.finalTarget || job.params?.peoplePerCompany || 4;
  const cos = run.companies.filter((c) => filter === 'all' ? true : filter === 'short' ? (c.status !== 'Found' || c.good < target) : c.people.some((p) => String(p.activity || '').toLowerCase() === filter));
  const counts = { all: run.companies.length, high: run.companies.filter((c) => c.people.some((p) => /high/i.test(p.activity))).length, medium: run.companies.filter((c) => c.people.some((p) => /medium/i.test(p.activity))).length, short: run.companies.filter((c) => c.status !== 'Found' || c.good < target).length };
  return (
    <div className="cards-wrap">
      <div className="filters">{[['all', 'All companies'], ['high', 'Has HIGH'], ['medium', 'Has MEDIUM'], ['short', 'Short / not filled']].map(([k, l]) => <button key={k} className={'fchip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>{l} <span>{counts[k]}</span></button>)}<BulkBar run={run} /></div>
      {!cos.length ? <Empty title="Nothing here">No company matches this filter.</Empty> : (
        <div className="cards">
          {cos.map((c) => (
            <div className={'ccard ' + statusClass(c.status)} key={c.key}>
              <div className="ccard-h">
                <div><div className="cname">{c.name}</div><div className="hint" style={{ margin: 0 }}>{c.status === 'Found' ? tallyText(c) : c.status}{c.industry ? ` · ${c.industry}` : ''}</div></div>
                <div className="cgood">{c.status === 'Found' && <><b>{c.good}</b><small>/{target} active</small></>}</div>
              </div>
              {(c.note || c.autoNote) && <div className="cnote">{[c.note, c.autoNote].filter(Boolean).join(' · ')}</div>}
              {c.people.length > 0 && <ul className="plist">{c.people.map((p) => (
                <li key={p.name + p.title}>
                  <div className="pmain"><div className="pname">{p.name}{prTag(p) && <span className="tag">{prTag(p)}</span>}</div><div className="ptitle">{p.title}<TitleTag r={p} />{p.location ? ` · ${p.location}` : ''}</div>{p.activityReason && <div className="pwhy">{p.activityReason}</div>}</div>
                  <div className="pside"><Label value={p.activity} />{!p.activity && p.activityPending && <span className="hint" style={{ margin: 0 }}>checking…</span>}<div className="plinks"><Link href={p.profileUrl}>LinkedIn</Link>{p.activityProof && <> · <Link href={p.activityProof}>proof</Link></>}</div><PersonActions r={p} run={run} /></div>
                </li>))}</ul>}
              {run.canEdit && c.needsRound > 0 && <button className="btn secondary sm" style={{ margin: '10px 14px 14px' }} onClick={() => run.nextRound(c.key, c.needsRound)}>▶ Next round ({c.needsRound}) for this company</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Split: companies left, selected company's people right ----------
export function SplitView({ run, job }) {
  const [sel, setSel] = useState(null);
  const target = job.params?.finalTarget || job.params?.peoplePerCompany || 4;
  const cur = run.companies.find((c) => c.key === sel) || run.companies[0];
  return (
    <div className="split">
      <aside className="split-list">
        {run.companies.map((c) => (
          <button key={c.key} className={'srow' + (cur && cur.key === c.key ? ' on' : '')} onClick={() => setSel(c.key)}>
            <div className="sname">{c.name}</div>
            <div className="smeta"><span className={'st ' + statusClass(c.status)}>{c.status}</span>{c.status === 'Found' && <span>{c.good}/{target} active · {c.people.length} found</span>}</div>
            <div className="sdots">{c.people.map((p, i) => <i key={i} className={'dot ' + String(p.activity || 'none').toLowerCase()} title={p.name + (p.activity ? ' · ' + p.activity : '')} />)}</div>
          </button>
        ))}
      </aside>
      <section className="split-detail">
        {!cur ? <Empty title="No companies yet" /> : (
          <>
            <div className="sd-head">
              <div><h3>{cur.name}</h3><div className="hint" style={{ margin: 0 }}>{cur.status === 'Found' ? tallyText(cur) : cur.status}{cur.industry ? ` · ${cur.industry}` : ''}{cur.employees ? ` · ${cur.employees} employees` : ''}</div>{(cur.note || cur.autoNote) && <div className="cnote" style={{ marginTop: 6 }}>{[cur.note, cur.autoNote].filter(Boolean).join(' · ')}</div>}</div>
              <div className="row" style={{ margin: 0 }}><BulkBar run={run} />{run.canEdit && cur.needsRound > 0 && <button className="btn sm" onClick={() => run.nextRound(cur.key, cur.needsRound)}>▶ Next round ({cur.needsRound})</button>}</div>
            </div>
            {!cur.people.length ? <Empty title="No people kept for this company">{cur.note || cur.autoNote || 'Nothing matched the designations and region.'}</Empty> : cur.people.map((p) => (
              <div className="pcard" key={p.name + p.title}>
                <div className="pc-main">
                  <div className="pc-top"><span className="pname">{p.name}</span>{prTag(p) && <span className="tag">{prTag(p)}</span>}<Label value={p.activity} />{!p.activity && p.activityPending && <span className="hint" style={{ margin: 0 }}>checking…</span>}</div>
                  <div className="ptitle">{p.title}<TitleTag r={p} />{p.location ? ` · ${p.location}` : ''}</div>
                  {p.activityReason && <div className="pwhy">{p.activityReason}</div>}
                  <div className="pc-facts">{p.connections != null && p.connections !== '' && <span><b>{p.connections}</b> connections</span>}{p.followers != null && p.followers !== '' && <span><b>{p.followers}</b> followers</span>}{p.activityDate && <span>last activity <b>{p.activityDate}</b></span>}</div>
                  <div className="plinks"><Link href={p.profileUrl}>LinkedIn profile</Link>{p.activityProof && <> · <Link href={p.activityProof}>activity proof</Link></>}</div>
                </div>
                <div className="pc-side"><PersonActions r={p} run={run} /></div>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
