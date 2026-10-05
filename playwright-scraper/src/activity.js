// LinkedIn activity check through Apify actors (the researcher's own Apify
// account). For each person with a profile URL it runs, in parallel: a
// posts actor, a comments actor, a reactions actor and a profile-details
// actor (connection count), then labels:
//   HIGH    an original post within the last 90 days (proof: post URL + date)
//   MEDIUM  a repost, comment or reaction within the last 90 days (proof: its
//           link), whatever the connection count; or 500+ connections with
//           nothing in the last 90 days
//   LOW     nothing in the last 90 days and fewer than 500 connections (or
//           the count could not be fetched); older activity is still noted
// Actor ids are overridable; the defaults are apimaestro's LinkedIn actors.
const logger = require('./logger');

const APIFY = 'https://api.apify.com/v2';
const WINDOW_DAYS = 90;
const CONNECTIONS_MEDIUM = 500;

// One Apify token per process (APIFY_POSTS_TOKEN, APIFY_COMMENTS_TOKEN,
// APIFY_REACTIONS_TOKEN, APIFY_PROFILE_TOKEN); APIFY_TOKEN fills in for any
// that is not set. A token is only ever sent to its own actor.
function configFromEnv(env = process.env) {
  const fallback = env.APIFY_TOKEN || null;
  const actors = {
    posts: { id: env.APIFY_POSTS_ACTOR || 'apimaestro~linkedin-profile-posts', token: env.APIFY_POSTS_TOKEN || fallback },
    comments: { id: env.APIFY_COMMENTS_ACTOR || 'apimaestro~linkedin-profile-comments', token: env.APIFY_COMMENTS_TOKEN || fallback },
    reactions: { id: env.APIFY_REACTIONS_ACTOR || 'apimaestro~linkedin-profile-reactions', token: env.APIFY_REACTIONS_TOKEN || fallback },
    profile: { id: env.APIFY_PROFILE_ACTOR || 'apimaestro~linkedin-profile-detail', token: env.APIFY_PROFILE_TOKEN || fallback }
  };
  const configured = Object.values(actors).every((a) => !!a.token);
  return {
    actors,
    configured,
    missing: Object.entries(actors).filter(([, a]) => !a.token).map(([k]) => `APIFY_${k.toUpperCase()}_TOKEN`),
    timeoutSecs: parseInt(env.APIFY_TIMEOUT_SECS || '150', 10),
    // Items fetched per actor per person. Two is enough to judge recency
    // (the newest two posts / comments / reactions) and keeps Apify cost low.
    maxItems: Math.max(1, parseInt(env.APIFY_MAX_ITEMS || '2', 10))
  };
}

function usernameOf(profileUrl) {
  const m = String(profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// Runs an actor synchronously and returns its dataset items.
async function runActor(cfg, actor, input, { fetchImpl = fetch } = {}) {
  if (!actor.token) throw new Error(`no Apify token for ${actor.id}`);
  // `limit` here caps the dataset items returned; the input `limit` asks the
  // actor itself to stop early where it supports that.
  const url = `${APIFY}/acts/${encodeURIComponent(actor.id)}/run-sync-get-dataset-items?timeout=${cfg.timeoutSecs}&clean=true&limit=${cfg.maxItems}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}` },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Apify ${actor.id} ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => []);
  const items = Array.isArray(data) ? data : (data && data.items) || [];
  return items.slice(0, cfg.maxItems);
}

// Timestamps come in several shapes across actors.
function tsOf(item) {
  const cands = [
    item && item.posted_at && item.posted_at.timestamp,
    item && item.created_at && item.created_at.timestamp,
    item && item.timestamps && item.timestamps.timestamp,
    item && item.timestamp,
    item && item.posted_at && item.posted_at.date,
    item && item.created_at && item.created_at.formatted,
    item && item.timestamps && item.timestamps.date,
    item && item.date
  ];
  for (const c of cands) {
    if (c == null || c === '') continue;
    const n = typeof c === 'number' ? c : Date.parse(String(c).replace(' ', 'T') + (String(c).length === 19 ? 'Z' : ''));
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

// Post links come back with utm_* and the researcher's own `rcm` member token; keep only the post path.
function cleanUrl(u) {
  const str = String(u || '');
  return /linkedin\.com\/posts\//i.test(str) ? str.split('?')[0] : str;
}

function fmtDate(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

// Posts actor items: post_type regular/quote = original, repost = repost.
// `self` is the person: { usernames: [...], names: [...] } (or a bare
// username). A regular post whose author is clearly somebody else is not this
// person's activity; a repost carries the original author, so it counts.
// When the author cannot be matched to the person by slug or by name, the
// post is kept: the actor was asked for this profile's posts, and dropping a
// real post would wrongly lower HIGH to MEDIUM/LOW.
function isSelf(author, self) {
  if (!author || typeof author !== 'object') return true;
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const slugs = (self.usernames || []).map(norm).filter(Boolean);
  const names = (self.names || []).map(norm).filter(Boolean);
  const aSlug = norm(author.username || author.public_identifier || author.publicIdentifier || (String(author.profile_url || author.url || '').match(/\/in\/([^/?#]+)/i) || [])[1]);
  const aName = norm(author.name || author.full_name || author.fullname || [author.first_name, author.last_name].filter(Boolean).join(' '));
  if (aSlug && slugs.includes(aSlug)) return true;
  if (aName && names.includes(aName)) return true;
  // comparable on at least one side and no match -> somebody else's post
  if ((aSlug && slugs.length) || (aName && names.length)) return false;
  return true;
}
function summarizePosts(items, self) {
  if (typeof self === 'string' || !self) self = { usernames: self ? [self] : [], names: [] };
  const out = [];
  for (const it of items || []) {
    const ts = tsOf(it);
    if (!ts) continue;
    const type = String(it.post_type || '').toLowerCase();
    if (type !== 'repost' && !isSelf(it.author, self)) continue;
    out.push({ kind: type === 'repost' ? 'repost' : 'post', ts, url: cleanUrl(it.url), text: (it.text || '').slice(0, 120) });
  }
  return out;
}

function summarizeComments(items) {
  return (items || []).map((it) => ({ kind: 'comment', ts: tsOf(it), url: it.comment_link || (it.post && it.post.post_url) || '', text: (it.comment_text || '').slice(0, 120) })).filter((x) => x.ts);
}

// Reactions actor items: { action: "Komala Maran likes this", post_url, timestamps }
function summarizeReactions(items) {
  return (items || []).map((it) => ({ kind: 'reaction', ts: tsOf(it), url: cleanUrl(it.post_url || it.url || (it.post && it.post.post_url) || ''), text: String(it.action || '').slice(0, 60) })).filter((x) => x.ts);
}

// Connection count from a profile-details item, whatever the field is called.
function connectionsOf(item) {
  if (!item || typeof item !== 'object') return null;
  const direct = ['connections', 'connection_count', 'connections_count', 'connectionsCount', 'numConnections'];
  for (const k of direct) if (item[k] != null && item[k] !== '') return toCount(item[k]);
  for (const sub of ['basic_info', 'basicInfo', 'profile', 'data']) if (item[sub] && typeof item[sub] === 'object') { const v = connectionsOf(item[sub]); if (v != null) return v; }
  for (const [k, v] of Object.entries(item)) if (/connection/i.test(k) && (typeof v === 'number' || typeof v === 'string')) return toCount(v);
  return null;
}
function followersOf(item) {
  if (!item || typeof item !== 'object') return null;
  for (const k of ['follower_count', 'followers', 'followers_count', 'followerCount']) if (item[k] != null && item[k] !== '') return toCount(item[k]);
  for (const sub of ['basic_info', 'basicInfo', 'profile', 'data']) if (item[sub] && typeof item[sub] === 'object') { const v = followersOf(item[sub]); if (v != null) return v; }
  return null;
}
function toCount(v) {
  if (typeof v === 'number') return v;
  const m = String(v).replace(/,/g, '').match(/(\d+)(\+?)/);
  return m ? parseInt(m[1], 10) : null;
}

function activityPage(profileUrl) {
  const u = usernameOf(profileUrl);
  return u ? `https://www.linkedin.com/in/${encodeURIComponent(u)}/recent-activity/all/` : String(profileUrl || '');
}

// Every label gets a proof: the activity link when there is one, otherwise
// the person's recent-activity page (where "nothing found" and the
// connection count can be verified), plus a note with the date checked.
function classify({ activities = [], connections = null, now = Date.now(), profileUrl = '', connectionsNote = '' }) {
  const cutoff = now - WINDOW_DAYS * 86400000;
  const checked = fmtDate(now);
  const page = activityPage(profileUrl);
  const sorted = activities.slice().sort((a, b) => b.ts - a.ts);
  const last = sorted[0] || null;
  const counts = { posts: 0, reposts: 0, comments: 0, reactions: 0 };
  for (const a of sorted) counts[a.kind === 'post' ? 'posts' : a.kind === 'repost' ? 'reposts' : a.kind === 'comment' ? 'comments' : 'reactions']++;
  const describe = (x) => `${x.kind === 'post' ? 'an original post' : x.kind === 'repost' ? 'a repost' : x.kind === 'comment' ? 'a comment' : `a reaction${x.text ? ` ("${x.text}")` : ''}`} on ${fmtDate(x.ts)}`;
  const conn = connections == null ? `connections unknown${connectionsNote ? ` (${connectionsNote})` : ''}`
    : connections >= CONNECTIONS_MEDIUM ? `${connections} connections (500+)` : `${connections} connections (under 500)`;
  const recentPost = sorted.find((a) => a.kind === 'post' && a.ts >= cutoff);
  if (recentPost) return { label: 'HIGH', reason: `HIGH because of ${describe(recentPost)}, within ${WINDOW_DAYS} days of ${checked}; ${conn}`, proof: recentPost.url || page, lastActivity: fmtDate(last.ts), counts, connections };
  const recent = sorted.find((a) => a.ts >= cutoff);
  if (recent) return { label: 'MEDIUM', reason: `MEDIUM because of ${describe(recent)}, within ${WINDOW_DAYS} days of ${checked}, but no original post in that time; ${conn} - recent activity counts as MEDIUM whatever the connection count`, proof: recent.url || page, lastActivity: fmtDate(last.ts), counts, connections };
  const nothing = last ? `nothing in the last ${WINDOW_DAYS} days (latest activity was ${describe(last)}, older than ${WINDOW_DAYS} days)` : `no post, repost, comment or reaction found on ${checked}`;
  if (connections != null && connections >= CONNECTIONS_MEDIUM) return { label: 'MEDIUM', reason: `MEDIUM because of ${conn} even though ${nothing}`, proof: page, lastActivity: last ? fmtDate(last.ts) : '', counts, connections };
  return { label: 'LOW', reason: `LOW because ${nothing} and ${conn}`, proof: page, lastActivity: last ? fmtDate(last.ts) : '', counts, connections };
}

// Yard scheme: LinkedIn activity as outreach probability. Only intentional
// activity counts (posts, reposts, comments); reactions are weak evidence;
// connections, followers, job changes and profile updates never count.
//   High     meaningful activity in the last 30 days: a post, or 2+ meaningful
//            activities, or any meaningful activity within 14 days
//   Medium   one meaningful activity 15-30 days ago, or the last one 31-90
//            days ago, or only reactions within 90 days
//   Low      last activity 91-180 days ago
//   Unknown  nothing within 180 days, or the data was not accessible
function classifyYard({ activities = [], connections = null, now = Date.now(), profileUrl = '', dataOk = true }) {
  const day = 86400000;
  const checked = fmtDate(now);
  const page = activityPage(profileUrl);
  const sorted = activities.filter((a) => a.ts).sort((a, b) => b.ts - a.ts);
  const meaningful = sorted.filter((a) => a.kind !== 'reaction');
  const ageDays = (a) => Math.floor((now - a.ts) / day);
  const counts = { posts: 0, reposts: 0, comments: 0, reactions: 0 };
  for (const a of sorted) counts[a.kind === 'post' ? 'posts' : a.kind === 'repost' ? 'reposts' : a.kind === 'comment' ? 'comments' : 'reactions']++;
  const base = { counts, connections, lastActivity: sorted[0] ? fmtDate(sorted[0].ts) : '' };
  const describe = (list) => {
    const n = { post: 0, repost: 0, comment: 0 };
    for (const a of list) n[a.kind] = (n[a.kind] || 0) + 1;
    return Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ');
  };

  const m30 = meaningful.filter((a) => ageDays(a) <= 30);
  const latest = meaningful[0];
  if (m30.length && (m30.some((a) => a.kind === 'post') || m30.length >= 2 || ageDays(m30[0]) <= 14)) {
    return { ...base, label: 'High', reason: `${describe(m30)} in the last 30 days; latest activity ${ageDays(m30[0])} days ago`, proof: m30[0].url || page };
  }
  if (m30.length === 1) {
    return { ...base, label: 'Medium', reason: `one ${m30[0].kind} ${ageDays(m30[0])} days ago, no evidence of regular activity`, proof: m30[0].url || page };
  }
  if (latest && ageDays(latest) <= 90) {
    const since = sorted.filter((a) => a.kind === 'reaction' && a.ts > latest.ts).length;
    return { ...base, label: 'Medium', reason: `last ${latest.kind} ${ageDays(latest)} days ago${since ? `; ${since} reaction${since > 1 ? 's' : ''} since` : ''}`, proof: latest.url || page };
  }
  const r90 = sorted.filter((a) => a.kind === 'reaction' && ageDays(a) <= 90);
  if (r90.length) {
    return { ...base, label: 'Medium', reason: `only reactions in the last 90 days (${r90.length}), latest ${ageDays(r90[0])} days ago; no posts or comments`, proof: r90[0].url || page };
  }
  if (sorted[0] && ageDays(sorted[0]) <= 180) {
    return { ...base, label: 'Low', reason: `latest activity (${sorted[0].kind}) ${ageDays(sorted[0])} days ago; nothing in the last 90 days`, proof: sorted[0].url || page };
  }
  if (!dataOk) return { ...base, label: 'Unknown', reason: `activity could not be fetched on ${checked}`, proof: page };
  return { ...base, label: 'Unknown', reason: sorted[0] ? `no activity in the last 180 days (latest ${ageDays(sorted[0])} days ago)` : `no visible activity on ${checked}`, proof: page };
}

// One person -> activity record. The profile actor runs first for everyone
// (the connection count is a decision key, so it is always filled), then
// the activity actors run one after another and stop at the first that
// decides the label:
//   posts -> HIGH (recent post) or MEDIUM (older post / repost)
//   comments -> MEDIUM
//   reactions -> MEDIUM
//   none -> MEDIUM (500+ connections) or LOW
// Actor failures are recorded on the record, never thrown.
async function checkPerson(cfg, person, opts = {}) {
  const username = usernameOf(person.profileUrl);
  if (!username) return { label: '', reason: 'no LinkedIn URL', proof: '', lastActivity: '', connections: null, followers: null, counts: {}, checked: [], errors: ['no LinkedIn URL'] };
  const input = { username, profile_url: person.profileUrl, page_number: 1, limit: cfg.maxItems, max_results: cfg.maxItems };
  const errors = [];
  const checked = [];
  const run = async (key) => {
    checked.push(key);
    try { return await runActor(cfg, cfg.actors[key], input, opts); } catch (err) { errors.push(`${key}: ${err.message}`); return null; }
  };

  let profile = await run('profile');
  if (profile === null || !profile.length) { // the connection count decides MEDIUM vs LOW, so try once more
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 3000));
    profile = await run('profile');
  }
  const info = profile && profile.length ? profile[0] : null;
  const connections = info ? connectionsOf(info) : null;
  const followers = info ? followersOf(info) : null;
  const profileErr = errors.filter((e) => e.startsWith('profile:')).pop();
  const connectionsNote = connections != null ? '' : profileErr ? `profile actor failed: ${profileErr.slice(9, 120)}` : !info ? 'profile actor returned no data for this URL' : 'no connection count in the profile data';
  const bi = (info && (info.basic_info || info.basicInfo)) || info || {};
  const self = {
    usernames: [username, bi.public_identifier, bi.publicIdentifier, bi.username, usernameOf(bi.profile_url || bi.url || '')].filter(Boolean),
    names: [person.name, bi.fullname, bi.full_name, bi.name, [bi.first_name, bi.last_name].filter(Boolean).join(' ')].filter(Boolean)
  };

  const finish = (activities) => {
    const result = classify({ activities, connections, connectionsNote, now: opts.now, profileUrl: person.profileUrl });
    result.followers = followers;
    result.checked = checked;
    if (errors.length) result.errors = errors;
    if (errors.length === checked.length && !activities.length && connections == null) { result.label = ''; result.reason = 'check failed: ' + errors.join('; '); }
    return result;
  };

  if (cfg.scheme === 'yard') {
    // Counting "2+ activities this month" needs every source, so no early exit.
    const [po, co, re] = [await run('posts'), await run('comments'), await run('reactions')];
    const activities = [...summarizePosts(po, self), ...summarizeComments(co), ...summarizeReactions(re)];
    const dataOk = [po, co, re].some((x) => x !== null);
    const result = classifyYard({ activities, connections, now: opts.now, profileUrl: person.profileUrl, dataOk });
    result.followers = followers;
    result.checked = checked;
    if (errors.length) result.errors = errors;
    return result;
  }

  // Stop at the first actor that shows activity inside the window; older
  // activity is kept for the note but does not decide, so the next actor runs.
  const cutoff = (opts.now || Date.now()) - WINDOW_DAYS * 86400000;
  const recent = (list) => list.some((x) => x.ts >= cutoff);
  const posts = summarizePosts(await run('posts'), self);
  if (recent(posts)) return finish(posts);
  const comments = summarizeComments(await run('comments'));
  if (recent(comments)) return finish([...posts, ...comments]);
  const reactions = summarizeReactions(await run('reactions'));
  return finish([...posts, ...comments, ...reactions]);
}

// Runs the check over `people` (objects with profileUrl), a few at a time.
async function runActivityCheck(baseCfg, people, { onProgress = () => {}, shouldStop = () => false, concurrency = 2, fetchImpl, now, scheme = 'standard', maxItems } = {}) {
  if (!baseCfg.configured) throw new Error(`Apify tokens missing on the server: ${baseCfg.missing.join(', ')} (or set APIFY_TOKEN for all)`);
  const cfg = { ...baseCfg, scheme, maxItems: Math.max(1, parseInt(maxItems, 10) || baseCfg.maxItems) };
  const results = new Array(people.length);
  let next = 0;
  const state = { total: people.length, done: 0, high: 0, medium: 0, low: 0, unknown: 0, failed: 0, scheme };
  async function worker() {
    while (next < people.length && !shouldStop()) {
      const i = next++;
      const p = people[i];
      try {
        results[i] = await checkPerson(cfg, p, { fetchImpl, now });
      } catch (err) {
        results[i] = { label: '', reason: `check failed: ${err.message}`, proof: '', lastActivity: '', connections: null, counts: {}, errors: [err.message] };
      }
      const l = String(results[i].label || '').toUpperCase();
      if (l === 'HIGH') state.high++; else if (l === 'MEDIUM') state.medium++; else if (l === 'LOW') state.low++; else if (l === 'UNKNOWN') state.unknown++; else state.failed++;
      state.done++;
      logger.info(`  activity ${p.name || p.profileUrl}: ${l || 'n/a'} - ${results[i].reason}`);
      onProgress(state);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length || 1) }, worker));
  return { results, state };
}

module.exports = {
  isSelf, configFromEnv, usernameOf, activityPage, runActor, classify, classifyYard, checkPerson, runActivityCheck, summarizePosts, summarizeComments, summarizeReactions, connectionsOf, followersOf, tsOf, WINDOW_DAYS };
