import { useEffect, useMemo, useState } from 'react';
import { api, companyKey } from './api.js';
import { prTag, isGood } from './icp.js';
import { useToast, useConfirm, useInterval, busy } from '../components/ui.jsx';

// Everything a results layout needs: rows, derived groups, and the actions
// (replace / delete / bulk / next round / activity) with confirmations and toasts.
export function useRun(job, refresh) {
  const toast = useToast(); const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [working, setWorking] = useState(false);
  const live = busy(job);
  const canEdit = !live && job.status !== 'queued';

  async function load() { try { setRows(await api.rows(job.id)); } catch {} finally { setLoading(false); } }
  useEffect(() => { setLoading(true); setPicked(new Set()); load(); }, [job.id]); // eslint-disable-line
  useInterval(load, 3000, live);
  useEffect(() => { load(); }, [job.status, job.activity && job.activity.status, job.auto && job.auto.stage, job.auto && job.auto.round, job.progress && job.progress.prospects]); // eslint-disable-line

  const people = rows.filter((r) => r.companyStatus === 'Found' && r.name);
  const withUrl = people.filter((r) => r.profileUrl);
  const unlabelled = withUrl.filter((r) => !r.activity && !r.activityPending);
  // company groups in row order
  const companies = useMemo(() => {
    const out = []; const idx = {};
    for (const r of rows) { const k = companyKey(r); if (idx[k] == null) { idx[k] = out.length; out.push({ key: k, name: r.company, status: r.companyStatus, header: r, people: [], note: r.note || '', autoNote: r.autoNote || '', needsRound: r.needsRound || 0, industry: r.industry, employees: r.employees }); }
      const c = out[idx[k]]; if (r.companyStatus === 'Found' && r.name) c.people.push(r); if (r.autoNote) c.autoNote = r.autoNote; if (r.needsRound) c.needsRound = r.needsRound; if (r.note && !c.note) c.note = r.note; }
    for (const c of out) { c.good = c.people.filter(isGood).length; c.tally = {}; for (const p of c.people) { const t = prTag(p); if (t) c.tally[t] = (c.tally[t] || 0) + 1; } }
    return out;
  }, [rows]);

  async function act(fn, okMsg) { setWorking(true); try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); } catch (e) { toast(e.message, 'err'); } finally { setWorking(false); await load(); refresh(); } }
  async function removeOne(r, replace) {
    const ok = await confirm({ title: replace ? `Replace ${r.name}?` : `Delete ${r.name}?`, body: replace ? 'Removes this person and fetches the next matching person for the company (0 Apollo credits).' : 'Removes this person for good. No replacement is searched.', ok: replace ? 'Replace' : 'Delete', danger: !replace });
    if (!ok) return;
    await act(() => api.removeRow(job.id, rows.indexOf(r), r.name, replace), (d) => d.message);
  }
  async function bulk(replace) {
    const sel = [...picked].map((i) => rows[i]).filter(Boolean);
    const ok = await confirm({ title: `${replace ? 'Replace' : 'Delete'} ${sel.length} selected?`, body: replace ? 'Each is removed and the next match for their company is fetched.' : 'They are removed for good.', ok: replace ? 'Replace all' : 'Delete all', danger: !replace });
    if (!ok) return;
    setWorking(true);
    let done = 0, added = 0;
    for (const i of [...picked].sort((x, y) => y - x)) { const r = rows[i]; if (!r) continue; try { const d = await api.removeRow(job.id, i, r.name, replace); done++; if (d.replacement) added++; } catch {} }
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
  const stopActivity = () => act(() => api.stopActivity(job.id), 'Stopping…');
  const toggle = (r) => { const i = rows.indexOf(r); setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); };
  const isPicked = (r) => picked.has(rows.indexOf(r));

  return { rows, loading, people, withUrl, unlabelled, companies, live, canEdit, working, picked, toggle, isPicked, clearPicks: () => setPicked(new Set()), removeOne, bulk, nextRound, checkActivity, stopActivity };
}
