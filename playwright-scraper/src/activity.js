// LinkedIn activity check through Apify actors (the researcher's own Apify
// account). For each person with a profile URL it runs, in parallel: a
// posts actor, a comments actor, a reactions actor and a profile-details
// actor (connection count), then labels:
//   HIGH    an original post within the last 90 days (proof: post URL + date)
//   MEDIUM  any other activity at all - an older post, or a repost, comment
//           or reaction at any time (proof: its link) - whatever the
//           connection count; or 500+ connections with nothing found
//   LOW     nothing found and fewer than 500 connections
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

function fmtDate(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

// Posts actor items: post_type regular/quote = original, repost = repost.
function summarizePosts(items, username) {
  const out = [];
  for (const it of items || []) {
    const ts = tsOf(it);
    if (!ts) continue;
    const type = String(it.post_type || '').toLowerCase();
    const author = it.author && it.author.username;
    // A regular post by someone else in the profile's feed is not this
    // person's activity; a repost carries the original author, so it counts.
    if (type !== 'repost' && author && username && author.toLowerCase() !== username.toLowerCase()) continue;
    out.push({ kind: type === 'repost' ? 'repost' : 'post', ts, url: it.url || '', text: (it.text || '').slice(0, 120) });
  }
  return out;
}

function summarizeComments(items) {
  return (items || []).map((it) => ({ kind: 'comment', ts: tsOf(it), url: it.comment_link || (it.post && it.post.post_url) || '', text: (it.comment_text || '').slice(0, 120) })).filter((x) => x.ts);
}

// Reactions actor items: { action: "Komala Maran likes this", post_url, timestamps }
function summarizeReactions(items) {
  return (items || []).map((it) => ({ kind: 'reaction', ts: tsOf(it), url: it.post_url || it.url || (it.post && it.post.post_url) || '', text: String(it.action || '').slice(0, 60) })).filter((x) => x.ts);
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
function toCount(v) {
  if (typeof v === 'number') return v;
  const m = String(v).replace(/,/g, '').match(/(\d+)(\+?)/);
  return m ? parseInt(m[1], 10) : null;
}

function classify({ activities = [], connections = null, now = Date.now() }) {
  const cutoff = now - WINDOW_DAYS * 86400000;
  const sorted = activities.slice().sort((a, b) => b.ts - a.ts);
  const last = sorted[0] || null;
  const counts = { posts: 0, reposts: 0, comments: 0, reactions: 0 };
  for (const a of sorted) counts[a.kind === 'post' ? 'posts' : a.kind === 'repost' ? 'reposts' : a.kind === 'comment' ? 'comments' : 'reactions']++;
  const recentPost = sorted.find((a) => a.kind === 'post' && a.ts >= cutoff);
  if (recentPost) return { label: 'HIGH', reason: `posted on ${fmtDate(recentPost.ts)}`, proof: recentPost.url, lastActivity: fmtDate(last.ts), counts, connections };
  if (last) {
    const what = last.kind === 'post' ? 'older post' : last.kind === 'reaction' ? (last.text || 'reacted') : last.kind;
    return { label: 'MEDIUM', reason: `${what} on ${fmtDate(last.ts)}`, proof: last.url, lastActivity: fmtDate(last.ts), counts, connections };
  }
  if (connections != null && connections >= CONNECTIONS_MEDIUM) return { label: 'MEDIUM', reason: `${connections}+ connections, no activity found`, proof: '', lastActivity: '', counts, connections };
  return { label: 'LOW', reason: connections != null ? `${connections} connections, no activity found` : 'no activity found', proof: '', lastActivity: '', counts, connections };
}

// One person -> activity record. Actor failures are recorded, not thrown.
async function checkPerson(cfg, person, opts = {}) {
  const username = usernameOf(person.profileUrl);
  if (!username) return { label: '', reason: 'no LinkedIn URL', proof: '', lastActivity: '', connections: null, counts: {}, errors: ['no LinkedIn URL'] };
  const input = { username, profile_url: person.profileUrl, page_number: 1, limit: cfg.maxItems, max_results: cfg.maxItems };
  const errors = [];
  const safe = (p, name) => p.catch((err) => { errors.push(`${name}: ${err.message}`); return null; });
  const [posts, comments, profile, reactions] = await Promise.all([
    safe(runActor(cfg, cfg.actors.posts, input, opts), 'posts'),
    safe(runActor(cfg, cfg.actors.comments, input, opts), 'comments'),
    safe(runActor(cfg, cfg.actors.profile, input, opts), 'profile'),
    safe(runActor(cfg, cfg.actors.reactions, input, opts), 'reactions')
  ]);
  const activities = [...summarizePosts(posts, username), ...summarizeComments(comments), ...summarizeReactions(reactions)];
  const connections = profile && profile.length ? connectionsOf(profile[0]) : null;
  const result = classify({ activities, connections, now: opts.now });
  if (errors.length) { result.errors = errors; if (!activities.length && connections == null) { result.label = ''; result.reason = 'check failed: ' + errors.join('; '); } }
  return result;
}

// Runs the check over `people` (objects with profileUrl), a few at a time.
async function runActivityCheck(cfg, people, { onProgress = () => {}, shouldStop = () => false, concurrency = 2, fetchImpl, now } = {}) {
  if (!cfg.configured) throw new Error(`Apify tokens missing on the server: ${cfg.missing.join(', ')} (or set APIFY_TOKEN for all)`);
  const results = new Array(people.length);
  let next = 0;
  const state = { total: people.length, done: 0, high: 0, medium: 0, low: 0, failed: 0 };
  async function worker() {
    while (next < people.length && !shouldStop()) {
      const i = next++;
      const p = people[i];
      try {
        results[i] = await checkPerson(cfg, p, { fetchImpl, now });
      } catch (err) {
        results[i] = { label: '', reason: `check failed: ${err.message}`, proof: '', lastActivity: '', connections: null, counts: {}, errors: [err.message] };
      }
      const l = results[i].label;
      if (l === 'HIGH') state.high++; else if (l === 'MEDIUM') state.medium++; else if (l === 'LOW') state.low++; else state.failed++;
      state.done++;
      logger.info(`  activity ${p.name || p.profileUrl}: ${l || 'n/a'} - ${results[i].reason}`);
      onProgress(state);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length || 1) }, worker));
  return { results, state };
}

module.exports = { configFromEnv, usernameOf, runActor, classify, checkPerson, runActivityCheck, summarizePosts, summarizeComments, summarizeReactions, connectionsOf, tsOf, WINDOW_DAYS };
