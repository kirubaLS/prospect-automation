import { useEffect, useMemo, useRef, useState } from 'react';
import { icpGroups, typedToCsv } from '../lib/icp.js';
import { useToast } from '../components/ui.jsx';

const GEO = ['South India', 'North India', 'India', 'US', 'UK', 'UAE', 'GCC', 'APAC', 'Europe'];

function DesignationPanel({ icp }) {
  const groups = useMemo(() => icpGroups(icp), [icp]);
  const [open, setOpen] = useState({});
  const n = groups.reduce((a, g) => a + g.length, 0);
  return (
    <div className="panel">
      <div className="panel-h">Designations searched, in this order <span className="hint" style={{ margin: 0 }}>{n ? (groups.length > 1 ? `${groups.length} priority groups · ${n} designations` : `${n} designations`) : ''}</span></div>
      {!n ? <div className="hint">Choose a project to see its designations, or type them under Advanced.</div> : groups.map((g, i) => {
        const shown = open[i] ? g : g.slice(0, 8);
        return (
          <div className="pgroup" key={i}>
            <span className="pn">{groups.length > 1 ? 'P' + (i + 1) : 'All'}</span>
            {shown.map((t) => <span className="chip" key={t}>{t}</span>)}
            {g.length > 8 && !open[i] && <button className="link" onClick={() => setOpen({ ...open, [i]: true })}>+{g.length - 8} more</button>}
          </div>
        );
      })}
      {n > 0 && <div className="hint" style={{ marginTop: 8 }}>{groups.length > 1 ? 'Priority 1 designations are searched first; the next group is used only when a company still needs people.' : 'Only these designations are accepted; nothing else is used as a filler.'}</div>}
    </div>
  );
}

// Per-project form memory lives in localStorage under form.<slug>.<field>.
const FIELDS = ['geography', 'icp', 'count', 'pool', 'label'];
const key = (slug, f) => `form.${slug}.${f}`;
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const del = (k) => { try { localStorage.removeItem(k); } catch {} };

export default function Composer({ presets, serverInfo, onStarted, startJob, running }) {
  const toast = useToast();
  const [slug, setSlug] = useState(() => read('form.presetSlug') || '');
  const preset = presets.find((p) => p.slug === slug) || null;
  const [form, setForm] = useState({ geography: '', icp: '', count: '4', pool: '7', label: '', resolve: 'search' });
  const [typed, setTyped] = useState('');
  const [file, setFile] = useState(null);
  const [auto, setAuto] = useState(true);
  const [preview, setPreview] = useState(null);
  const [starting, setStarting] = useState(false);
  const fileRef = useRef();

  // load a project: saved edits for that project, else its server defaults
  function load(p, fresh = false) {
    if (!p) return;
    const d = { geography: p.geography || '', icp: p.icp || '', count: String(p.peoplePerCompany || 4), pool: String(p.candidatePool || 7), label: p.name };
    const next = {};
    for (const f of FIELDS) { const s = fresh ? null : read(key(p.slug, f)); next[f] = s != null ? s : d[f]; }
    setForm((o) => ({ ...o, ...next }));
  }
  useEffect(() => { if (preset) { const snap = JSON.stringify([preset.geography, preset.icp, preset.peoplePerCompany]); const old = read('form.presetSnapshot'); const changed = old && old !== snap; if (changed) { for (const f of FIELDS) del(key(preset.slug, f)); toast(`${preset.name} was updated on the server - settings refreshed.`); } write('form.presetSnapshot', snap); load(preset, !!changed); } }, [slug, presets.length]); // eslint-disable-line
  function pick(s) { setSlug(s); write('form.presetSlug', s); }
  function set(f, v) { setForm((o) => ({ ...o, [f]: v })); if (preset && FIELDS.includes(f)) write(key(preset.slug, f), v); }
  const edited = preset && (form.geography !== (preset.geography || '') || form.icp !== (preset.icp || '') || String(form.count) !== String(preset.peoplePerCompany || 4));

  const keep = Math.max(1, parseInt(form.count, 10) || 4), pool = Math.max(keep, parseInt(form.pool, 10) || 7);
  const typedInfo = useMemo(() => typedToCsv(typed), [typed]);
  const canRun = !running && !starting && (typedInfo.count > 0 || file) && (preset || form.icp.trim());

  async function onFile(f) {
    setFile(f);
    if (/\.csv$/i.test(f.name)) { const t = await f.text(); const lines = t.split(/\r?\n/).filter(Boolean); setPreview({ name: f.name, rows: lines.length - 1, head: lines[0] }); }
    else setPreview({ name: f.name, rows: '?', head: 'Excel: first sheet is used' });
  }
  async function run() {
    setStarting(true);
    try {
      const upload = typedInfo.count ? new File([typedInfo.csv], 'pasted-companies.csv', { type: 'text/csv' }) : file;
      const base = { filename: upload.name, label: form.label || (preset ? `${preset.name} - ${upload.name}` : upload.name), resolve: form.resolve, auto: auto ? '1' : '0', pool: String(pool) };
      const params = preset
        ? { ...base, preset: preset.slug, ...(edited ? { geography: form.geography, icp: form.icp, count: String(keep) } : {}) }
        : { ...base, geography: form.geography, icp: form.icp, count: String(keep), activity: '1', scheme: 'standard' };
      const r = await startJob(params, upload);
      toast(r.job.ahead ? `Queued - ${r.job.ahead} ahead of you` : 'Run started', 'ok');
      setTyped(''); setFile(null); setPreview(null);
      onStarted(r.job);
    } catch (e) { toast(e.message, 'err'); }
    finally { setStarting(false); }
  }

  return (
    <section className="composer">
      <div className="card">
        <div className="head"><h2>Client project</h2>{preset && <button className="btn ghost sm" onClick={() => { for (const f of FIELDS) del(key(preset.slug, f)); load(preset, true); }}>Reset to defaults</button>}</div>
        <div className="body">
          <div className="field" style={{ marginTop: 0 }}>
            <label>Project</label>
            <select className="input" value={slug} onChange={(e) => pick(e.target.value)}>
              <option value="">— choose a client —</option>
              {presets.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
            <div className="hint">{preset ? (edited ? `${preset.name}: region, designations or count edited for this run. Activity rules still come from the project.` : `${preset.name}: project settings from the server (${preset.peoplePerCompany}/company, activity ${preset.activityCheck ? 'on' : 'off'}).`) : 'No project chosen: the fields under Advanced are used as typed.'}</div>
          </div>
          <div className="field"><label>Batch name <small>optional</small></label><input className="input" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Sharp – batch 3" /></div>
          <div className="grid2">
            <div className="field"><label>People to keep per company</label><input className="input" type="number" min="1" max="25" value={form.count} onChange={(e) => set('count', e.target.value)} /><div className="hint">Final list: this many active people (HIGH + MEDIUM).</div></div>
            <div className="field"><label>People checked per round</label><input className="input" type="number" min="1" max="25" value={form.pool} disabled={!auto} onChange={(e) => set('pool', e.target.value)} /><div className="hint">Found and checked before keeping the best.</div></div>
          </div>
          <div className="hint" style={{ opacity: auto ? 1 : 0.5 }}>Each round: find {pool} people per company in priority order → check their LinkedIn activity → keep the {keep} most active (HIGH first, then MEDIUM). Still short after 2 rounds? A Next round button appears.</div>
          <DesignationPanel icp={form.icp} />
          <details style={{ marginTop: 12 }}>
            <summary>Advanced: region, designations text, LinkedIn link lookup</summary>
            <div className="field"><label>Region of the person</label><textarea value={form.geography} onChange={(e) => set('geography', e.target.value)} placeholder="South India" style={{ minHeight: 44 }} />
              <div>{GEO.map((g) => <span key={g} className="chip btn-chip" onClick={() => set('geography', form.geography.trim() ? form.geography.trim() + '; ' + g : g)}>{g}</span>)}</div>
              <div className="hint">Empty = anywhere.</div></div>
            <div className="field"><label>Designations <small>industries; Priority 1 titles &gt; Priority 2 &gt; Priority 3</small></label><textarea value={form.icp} onChange={(e) => set('icp', e.target.value)} placeholder="Healthcare; CIO, COO > Head of IT > IT Manager" /><div className="hint">Commas between titles, <code>&gt;</code> between priority groups. Priority 1 is searched first.</div></div>
            <div className="field"><label>LinkedIn link lookup</label>
              <select className="input" value={form.resolve} onChange={(e) => set('resolve', e.target.value)}>
                <option value="search">Free (recommended) · 0 Apollo credits</option>
                <option value="none">Names and designations only · no LinkedIn link</option>
                <option value="apollo+search">Apollo enrichment, then free lookup · 1 credit per person</option>
                <option value="apollo">Apollo enrichment only · 1 credit per person</option>
              </select>
              <div className="hint" style={{ color: form.resolve.startsWith('apollo') ? 'var(--bad)' : undefined }}>{form.resolve === 'search' ? 'People from Apollo search (0 credits); LinkedIn link found by web search (0 credits).' : form.resolve === 'none' ? 'Names and designations only. 0 credits.' : 'Apollo enrichment costs 1 credit per person.'}</div>
              {serverInfo && !serverInfo.searchProviders?.length && <div className="hint" style={{ color: 'var(--bad)' }}>Web search is not configured on the server (SERPER_API_KEY or similar). Runs will fail rather than spend Apollo credits.</div>}
            </div>
          </details>
        </div>
      </div>

      <div className="card">
        <div className="head"><h2>Companies</h2><span className="hint" style={{ margin: 0 }}>{typedInfo.count ? `${typedInfo.count} compan${typedInfo.count === 1 ? 'y' : 'ies'} pasted` : file ? `file: ${file.name}` : ''}</span></div>
        <div className="body">
          <textarea value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={'Paste the companies here, one per line:\nsharp.com\nhttps://www.linkedin.com/company/acme/\nAcme Pvt Ltd'} style={{ minHeight: 220, fontSize: 14 }} />
          <div className="hint">A website per line works best. A name or LinkedIn page is fine too: we find the website for free.</div>
          <details style={{ marginTop: 8 }}>
            <summary>or upload a CSV / Excel file instead</summary>
            <div className="drop" style={{ marginTop: 6 }} onClick={() => fileRef.current.click()} onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('over'); }} onDragLeave={(e) => e.currentTarget.classList.remove('over')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
              <div><b>Drop the CSV / Excel here</b> or click to choose</div>
              <div className="hint">Columns: <b>Website</b> (best), or <b>LinkedIn URL</b> / <b>Company Name</b>. <a href={'data:text/csv;charset=utf-8,' + encodeURIComponent('Company Name,Website,LinkedIn URL\r\nExample Company,example.com,https://www.linkedin.com/company/example/\r\n')} download="companies-template.csv" onClick={(e) => e.stopPropagation()}>Template</a></div>
            </div>
            {preview && <div className="preview hint">{preview.name} · {preview.rows} rows · {preview.head}</div>}
          </details>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn lg" disabled={!canRun} onClick={run}>{starting ? <><i className="spin" /> Starting…</> : '▶ Find prospects'}</button>
            {!preset && !form.icp.trim() && <span className="hint">Choose a project first.</span>}
          </div>
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span>Automatic: check LinkedIn activity and keep only the active people <small>({pool} checked → {keep} kept, up to 2 rounds)</small></span></label>
        </div>
      </div>
    </section>
  );
}
