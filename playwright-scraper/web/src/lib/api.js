// Thin client for the server API. Every call carries the browser's owner
// token so this browser only sees and controls its own runs.
function ownerToken() {
  let o = null;
  try { o = localStorage.getItem('owner'); } catch {}
  if (!o || !/^[\w-]{8,64}$/.test(o)) {
    o = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, '');
    try { localStorage.setItem('owner', o); } catch {}
  }
  return o;
}
export const OWNER = ownerToken();

async function call(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Owner': OWNER } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) { const e = new Error((data && data.error) || `${r.status} ${r.statusText}`); e.status = r.status; e.data = data; throw e; }
  return data;
}

export const api = {
  presets: () => call('/presets'),
  jobs: () => call('/jobs'),
  job: (id) => call(`/jobs/${id}`),
  rows: async (id) => { const all = []; let from = 0; for (;;) { const d = await call(`/jobs/${id}/rows?from=${from}`); all.push(...d.rows); from = d.from + d.rows.length; if (!d.rows.length || from >= d.total) break; } return all; },
  start: (params, file) => call('/jobs?' + new URLSearchParams(params), { method: 'POST', body: file }),
  stop: (id) => call(`/jobs/${id}/stop`, { method: 'POST' }),
  activity: (id) => call(`/jobs/${id}/activity`),
  startActivity: (id, all) => call(`/jobs/${id}/activity${all ? '?all=1' : ''}`, { method: 'POST' }),
  stopActivity: (id) => call(`/jobs/${id}/activity`, { method: 'DELETE' }),
  removeRow: (id, idx, name, replace) => call(`/jobs/${id}/rows/${idx}?name=${encodeURIComponent(name)}${replace ? '' : '&replace=0'}`, { method: 'DELETE' }),
  nextRound: (id, companyKey) => call(`/jobs/${id}/auto${companyKey ? '?company=' + encodeURIComponent(companyKey) : ''}`, { method: 'POST' }),
  tsv: async (id) => { const r = await fetch(`/jobs/${id}/download?format=tsv&inline=1`, { headers: { 'X-Owner': OWNER } }); return r.text(); },
  downloadUrl: (id, format) => `/jobs/${id}/download?format=${format}&owner=${OWNER}`
};

export const companyKey = (r) => `${r.company}|${r.companyWebsite || ''}|${r.companyUrl || ''}`;
