// "industries; P1 titles > P2 titles" -> [[...], [...]]
export function icpGroups(raw) {
  const people = raw.includes(';') ? raw.split(';').slice(1).join(';') : raw;
  return people.split(/\s*>\s*/).map((g) => g.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)).filter((g) => g.length);
}
// pasted companies -> CSV the server understands
export function typedToCsv(text) {
  const q = (v) => '"' + String(v || '').replace(/"/g, '""') + '"';
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[,\t;]+/).map((x) => x.trim()).filter(Boolean);
    let name = '', site = '', li = '';
    for (const p of parts) {
      if (/linkedin\.com\/(company|school|showcase)\//i.test(p)) li = p;
      else if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(p)) site = p;
      else name = name ? name + ' ' + p : p;
    }
    if (!name && !site && !li) continue;
    rows.push([q(name), q(site), q(li)].join(','));
  }
  return { csv: rows.length ? 'Company Name,Website,LinkedIn URL\r\n' + rows.join('\r\n') + '\r\n' : '', count: rows.length };
}
export const LEGENDS = {
  sharp: [['high', 'HIGH', 'active on LinkedIn in the last year and 500+ connections'], ['medium', 'MEDIUM', 'active in the last year, under 500 connections'], ['low', 'LOW', 'nothing on LinkedIn in the last year']],
  yard: [['high', 'High', 'posted or 2+ actions in the last 30 days'], ['medium', 'Medium', 'some activity in the last 90 days'], ['low', 'Low', 'last activity 3-6 months ago'], ['unknown', 'Unknown', 'nothing seen in 6 months']],
  standard: [['high', 'HIGH', 'posted on LinkedIn in the last 90 days'], ['medium', 'MEDIUM', 'reposted, commented or reacted in the last 90 days, or 500+ connections'], ['low', 'LOW', 'nothing in 90 days and under 500 connections']]
};
export const prTag = (x) => { const m = String(x.match || '').match(/Priority (\d+)/); return m ? 'P' + m[1] : null; };
export const isGood = (r) => ['high', 'medium'].includes(String(r.activity || '').toLowerCase());
