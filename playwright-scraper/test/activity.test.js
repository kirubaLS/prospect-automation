// LinkedIn activity labels from Apify actor outputs (shapes taken from real runs).
//   node test/activity.test.js
const assert = require('assert');
const a = require('../src/activity');
const now = Date.parse('2026-10-01T00:00:00Z');
const day = 86400000;

assert.strictEqual(a.usernameOf('https://www.linkedin.com/in/kingshuk?miniProfileUrn=x'), 'kingshuk');
assert.strictEqual(a.usernameOf('https://in.linkedin.com/in/priya-nathan-123'), 'priya-nathan-123');
assert.strictEqual(a.usernameOf('https://www.linkedin.com/company/acme'), null);

// profile actor: basic_info.connection_count
assert.strictEqual(a.connectionsOf({ basic_info: { fullname: 'Kiruba Karan', follower_count: 1836, connection_count: 1839 } }), 1839);
assert.strictEqual(a.connectionsOf({ basic_info: { connection_count: '500+' } }), 500);
assert.strictEqual(a.connectionsOf({ experience: [] }), null);
assert.strictEqual(a.followersOf({ basic_info: { follower_count: 1836, connection_count: 1839 } }), 1836);

// posts actor
const posts = a.summarizePosts([
  { post_type: 'regular', posted_at: { date: '2026-09-30 12:10:52', timestamp: now - 1 * day }, url: 'https://www.linkedin.com/posts/activity-1', author: { username: 'kingshuk' } },
  { post_type: 'repost', posted_at: { date: '2026-09-26 06:14:44', timestamp: now - 5 * day }, url: 'https://www.linkedin.com/posts/activity-2', author: { username: 'anurag-malti-chaurasia' } },
  { post_type: 'regular', posted_at: { timestamp: now - 2 * day }, url: 'x', author: { username: 'komalamaran' } },
  { post_type: 'regular', posted_at: { timestamp: now - 400 * day }, url: 'https://www.linkedin.com/posts/activity-old', author: { username: 'kingshuk' } }
], 'kingshuk');
assert.deepStrictEqual(posts.map((p) => p.kind), ['post', 'repost', 'post'], 'another author\'s regular post is not this person\'s activity; a repost is');
// author matching: the URL slug may differ from the actor's username, so the profile's own slug/name also count; unknown authors are kept
const selfK = { usernames: ['kingshuk-hazra-1a2b', 'kingshukhazra'], names: ['Kingshuk Hazra'] };
assert.strictEqual(a.isSelf({ username: 'kingshukhazra' }, selfK), true);
assert.strictEqual(a.isSelf({ name: 'Kingshuk Hazra', username: 'ACoAAB123' }, selfK), true, 'name match beats a slug mismatch');
assert.strictEqual(a.isSelf({ username: 'someone-else', name: 'Some One' }, selfK), false);
assert.strictEqual(a.isSelf({}, selfK), true, 'nothing to compare: keep the post');
assert.strictEqual(a.isSelf({ username: 'anyone' }, { usernames: [], names: [] }), true, 'no identity known: keep the post');
assert.strictEqual(a.summarizePosts([{ post_type: 'regular', posted_at: { timestamp: now - day }, url: 'u', author: { username: 'kingshuk-hazra-1a2b', name: 'Kingshuk Hazra' } }], selfK).length, 1);

// comments actor
const comments = a.summarizeComments([{ comment_text: 'Congrats', created_at: { timestamp: now - 10 * day, formatted: '2026-09-21 09:13:14' }, comment_link: 'https://www.linkedin.com/feed/update/urn:li:activity:1?commentUrn=x' }]);
assert.strictEqual(comments[0].kind, 'comment'); assert.ok(comments[0].url.includes('commentUrn'));

// reactions actor
const reactions = a.summarizeReactions([{ action: 'Komala Maran celebrates this', post_url: 'https://www.linkedin.com/posts/anurag_x', timestamps: { date: '2026-09-18 11:46:11', timestamp: now - 13 * day } }]);
assert.strictEqual(reactions[0].kind, 'reaction'); assert.strictEqual(reactions[0].text, 'Komala Maran celebrates this');

// labels: HIGH = original post in 90 days; MEDIUM = other activity in 90 days, or 500+ connections; LOW otherwise.
const pu = 'https://www.linkedin.com/in/kingshuk';
assert.strictEqual(a.activityPage(pu), 'https://www.linkedin.com/in/kingshuk/recent-activity/all/');
let r = a.classify({ activities: posts, connections: 300, now, profileUrl: pu });
assert.strictEqual(r.label, 'HIGH'); assert.strictEqual(r.proof, 'https://www.linkedin.com/posts/activity-1'); assert.match(r.reason, /HIGH because of an original post on 2026-09-30, within 90 days of 2026-10-01; 300 connections \(under 500\)/);
r = a.classify({ activities: [posts[1]], connections: 100, now });
assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /MEDIUM because of a repost on 2026-09-26, within 90 days of 2026-10-01, but no original post in that time; 100 connections \(under 500\)/); assert.strictEqual(r.proof, 'https://www.linkedin.com/posts/activity-2');
r = a.classify({ activities: comments, connections: 100, now }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /comment/);
r = a.classify({ activities: reactions, connections: null, now }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /a reaction \("Komala Maran celebrates this"\) on 2026-09-18/); assert.match(r.reason, /connections unknown/);
r = a.classify({ activities: [posts[2]], connections: 120, now, profileUrl: pu }); // post older than 90 days, few connections
assert.strictEqual(r.label, 'LOW', 'an old post is not recent activity'); assert.match(r.reason, /LOW because nothing in the last 90 days \(latest activity was an original post on 2025-08-27, older than 90 days\) and 120 connections \(under 500\)/);
assert.strictEqual(r.proof, 'https://www.linkedin.com/in/kingshuk/recent-activity/all/'); assert.strictEqual(r.lastActivity, '2025-08-27', 'the old date is still reported');
r = a.classify({ activities: [posts[2]], connections: 900, now, profileUrl: pu }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /MEDIUM because of 900 connections \(500\+\) even though nothing in the last 90 days \(latest activity was an original post on 2025-08-27/);
const oldComment = a.summarizeComments([{ comment_text: 'x', created_at: { timestamp: now - 400 * day }, comment_link: 'https://www.linkedin.com/feed/update/old' }]);
r = a.classify({ activities: oldComment, connections: 50, now }); assert.strictEqual(r.label, 'LOW', 'a comment from a year ago, under 500 connections, is LOW');
r = a.classify({ activities: a.summarizeReactions([{ action: 'Glenn Gauthier likes this', post_url: 'https://www.linkedin.com/posts/x?utm_source=share&rcm=SECRET', timestamps: { timestamp: now - 2100 * day } }]), connections: 216, now }); assert.strictEqual(r.label, 'LOW', 'a like from 2020 is not activity'); assert.match(r.reason, /a reaction \("Glenn Gauthier likes this"\) on 2020-\d\d-\d\d, older than 90 days/);
assert.strictEqual(a.summarizeReactions([{ action: 'x', post_url: 'https://www.linkedin.com/posts/x?utm_source=share&rcm=SECRET', timestamps: { timestamp: now } }])[0].url, 'https://www.linkedin.com/posts/x', 'tracking query stripped from proof links');
r = a.classify({ activities: [], connections: 1839, now, profileUrl: pu }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /MEDIUM because of 1839 connections \(500\+\) even though no post, repost, comment or reaction found on 2026-10-01/);
assert.strictEqual(r.proof, 'https://www.linkedin.com/in/kingshuk/recent-activity/all/', 'MEDIUM by connections still has a proof link');
r = a.classify({ activities: [], connections: 500, now, profileUrl: pu }); assert.strictEqual(r.label, 'MEDIUM');
r = a.classify({ activities: [], connections: 499, now, profileUrl: pu }); assert.strictEqual(r.label, 'LOW'); assert.match(r.reason, /LOW because no post, repost, comment or reaction found on 2026-10-01 and 499 connections \(under 500\)/);
assert.strictEqual(r.proof, 'https://www.linkedin.com/in/kingshuk/recent-activity/all/', 'LOW has a proof link too');
r = a.classify({ activities: [], connections: null, now, profileUrl: pu }); assert.strictEqual(r.label, 'LOW'); assert.match(r.reason, /connections unknown/);

// ---- Yard scheme ----
{
  const pu = 'https://www.linkedin.com/in/kingshuk';
  const act = (kind, ago, url = 'u') => ({ kind, ts: now - ago * day, url });
  const y = (activities, extra = {}) => a.classifyYard({ activities, now, profileUrl: pu, connections: 3000, ...extra });
  let r = y([act('post', 8, 'p1'), act('post', 20, 'p2'), act('post', 27, 'p3')]);
  assert.strictEqual(r.label, 'High'); assert.match(r.reason, /3 posts in the last 30 days; latest activity 8 days ago/); assert.strictEqual(r.proof, 'p1');
  r = y([act('comment', 5)]); assert.strictEqual(r.label, 'High', 'any meaningful activity within 14 days');
  r = y([act('comment', 20), act('repost', 28)]); assert.strictEqual(r.label, 'High', '2+ meaningful activities in 30 days');
  r = y([act('comment', 22)]); assert.strictEqual(r.label, 'Medium'); assert.match(r.reason, /one comment 22 days ago, no evidence of regular activity/);
  r = y([act('post', 42), act('reaction', 10), act('reaction', 30)]); assert.strictEqual(r.label, 'Medium'); assert.match(r.reason, /last post 42 days ago; 2 reactions since/);
  r = y([act('reaction', 12), act('reaction', 40)]); assert.strictEqual(r.label, 'Medium'); assert.match(r.reason, /only reactions in the last 90 days \(2\)/);
  r = y([act('post', 120)]); assert.strictEqual(r.label, 'Low'); assert.match(r.reason, /120 days ago; nothing in the last 90 days/);
  r = y([act('reaction', 150)]); assert.strictEqual(r.label, 'Low');
  r = y([act('post', 400)]); assert.strictEqual(r.label, 'Unknown'); assert.match(r.reason, /no activity in the last 180 days/);
  r = y([]); assert.strictEqual(r.label, 'Unknown'); assert.match(r.reason, /no visible activity/); assert.strictEqual(r.proof, 'https://www.linkedin.com/in/kingshuk/recent-activity/all/');
  r = y([], { dataOk: false }); assert.strictEqual(r.label, 'Unknown'); assert.match(r.reason, /could not be fetched/);
  r = y([], { connections: 5000 }); assert.strictEqual(r.label, 'Unknown', 'connections never lift the label');
  assert.strictEqual(r.connections, 5000, 'but are still reported');
}

(async () => {
  // Sequential with early exit: posts decide -> only 1 actor runs; each actor gets only its own token.
  const cfg = a.configFromEnv({ APIFY_POSTS_TOKEN: 't-posts', APIFY_COMMENTS_TOKEN: 't-comments', APIFY_REACTIONS_TOKEN: 't-reactions', APIFY_PROFILE_TOKEN: 't-profile' });
  assert.strictEqual(cfg.configured, true);
  const partial = a.configFromEnv({ APIFY_POSTS_TOKEN: 'x' });
  assert.strictEqual(partial.configured, false); assert.deepStrictEqual(partial.missing, ['APIFY_COMMENTS_TOKEN', 'APIFY_REACTIONS_TOKEN', 'APIFY_PROFILE_TOKEN']);
  assert.strictEqual(a.configFromEnv({ APIFY_TOKEN: 'one' }).configured, true, 'a single token still works as fallback');

  const makeFetch = (data) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      const act = decodeURIComponent(u.pathname.split('/')[3]);
      const key = act.endsWith('posts') ? 'posts' : act.endsWith('comments') ? 'comments' : act.endsWith('reactions') ? 'reactions' : 'profile';
      calls.push(key);
      assert.strictEqual(init.headers.Authorization, 'Bearer t-' + key, 'each actor gets only its own token');
      const body = JSON.parse(init.body); assert.strictEqual(body.username, 'kingshuk');
      assert.strictEqual(body.limit, 2, 'actors are asked for 2 items'); assert.strictEqual(u.searchParams.get('limit'), '2', 'dataset capped at 2');
      const d = data[key];
      if (d === 'crash') return { ok: false, status: 500, text: async () => 'actor crashed' };
      return { ok: true, status: 201, json: async () => d || [], text: async () => '' };
    };
    return { fetchImpl, calls };
  };
  const me = { name: 'Kingshuk Hazra', profileUrl: 'https://www.linkedin.com/in/kingshuk' };
  const recentPosts = [1, 2, 3].map((i) => ({ post_type: 'regular', posted_at: { timestamp: now - i * 3 * day }, url: 'https://www.linkedin.com/posts/p' + i, author: { username: 'kingshuk' } }));

  const prof = [{ basic_info: { connection_count: 1839, follower_count: 1836 } }];
  let f = makeFetch({ profile: prof, posts: recentPosts });
  let res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'HIGH'); assert.strictEqual(res.proof, 'https://www.linkedin.com/posts/p1');
  assert.strictEqual(res.connections, 1839, 'connections always filled, even for HIGH'); assert.strictEqual(res.followers, 1836);
  assert.match(res.reason, /1839 connections \(500\+\)/);
  assert.strictEqual(res.counts.posts, 2, 'never more than 2 items per actor are used');
  assert.deepStrictEqual(f.calls, ['profile', 'posts'], 'profile first, then posts decide: no other actor runs');

  f = makeFetch({ profile: prof, posts: [], comments: [{ comment_text: 'nice', created_at: { timestamp: now - 20 * day }, comment_link: 'https://www.linkedin.com/feed/update/c1' }] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'MEDIUM'); assert.strictEqual(res.proof, 'https://www.linkedin.com/feed/update/c1'); assert.strictEqual(res.connections, 1839);
  assert.deepStrictEqual(f.calls, ['profile', 'posts', 'comments'], 'stops at comments when the comment is recent');

  // an old comment does not decide: reactions are still checked, and the old date is reported
  f = makeFetch({ profile: [{ basic_info: { connection_count: 120 } }], posts: [], comments: [{ comment_text: 'old', created_at: { timestamp: now - 200 * day }, comment_link: 'https://www.linkedin.com/feed/update/c0' }], reactions: [] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'LOW'); assert.deepStrictEqual(f.calls, ['profile', 'posts', 'comments', 'reactions'], 'old activity does not stop the chain');
  assert.strictEqual(res.lastActivity, a.classify({ activities: a.summarizeComments([{ created_at: { timestamp: now - 200 * day } }]), now }).lastActivity);

  f = makeFetch({ profile: prof, posts: [], comments: [], reactions: [{ action: 'Kingshuk Hazra likes this', post_url: 'https://www.linkedin.com/posts/r1', timestamps: { timestamp: now - 5 * day } }] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'MEDIUM'); assert.match(res.reason, /likes this/);
  assert.deepStrictEqual(f.calls, ['profile', 'posts', 'comments', 'reactions'], 'stops at reactions');

  f = makeFetch({ posts: [], comments: [], reactions: [], profile: [{ basic_info: { connection_count: 1839 } }] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'MEDIUM'); assert.strictEqual(res.connections, 1839); assert.deepStrictEqual(f.calls, ['profile', 'posts', 'comments', 'reactions']);
  assert.strictEqual(res.proof, 'https://www.linkedin.com/in/kingshuk/recent-activity/all/');

  f = makeFetch({ posts: [], comments: [], reactions: [], profile: [{ basic_info: { connection_count: 120 } }] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'LOW'); assert.match(res.reason, /LOW because no post, repost, comment or reaction found on 2026-10-01 and 120 connections \(under 500\)/);
  r = a.classify({ activities: [], connections: 8, now, profileUrl: 'https://www.linkedin.com/in/x' }); assert.match(r.reason, /8 connections \(under 50: looks like a dormant profile\)/);

  // a crashed actor is skipped, the chain continues
  f = makeFetch({ posts: 'crash', comments: [], reactions: [], profile: [{ basic_info: { connection_count: 900 } }] });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'MEDIUM'); assert.deepStrictEqual(res.errors, ['posts: Apify apimaestro~linkedin-profile-posts 500: actor crashed']);
  // profile actor failing is retried once and the error lands in the note
  f = makeFetch({ posts: [], comments: [], reactions: [], profile: 'crash' });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, 'LOW'); assert.match(res.reason, /connections unknown \(profile actor failed: Apify apimaestro~linkedin-profile-detail 500: actor crashed\)/);
  assert.deepStrictEqual(f.calls.slice(0, 2), ['profile', 'profile'], 'profile is retried once');
  // everything crashed -> no label, explained
  f = makeFetch({ posts: 'crash', comments: 'crash', reactions: 'crash', profile: 'crash' });
  res = await a.checkPerson(cfg, me, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(res.label, ''); assert.match(res.reason, /check failed/);

  const noUrl = await a.checkPerson(cfg, { name: 'X', profileUrl: '' }, { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.strictEqual(noUrl.label, '');
  f = makeFetch({ posts: recentPosts });
  const { results, state } = await a.runActivityCheck(cfg, [{ name: 'A', profileUrl: 'https://www.linkedin.com/in/kingshuk' }, { name: 'B', profileUrl: 'https://www.linkedin.com/in/kingshuk' }], { fetchImpl: f.fetchImpl, now, retryDelayMs: 0 });
  assert.deepStrictEqual(results.map((x) => x.label), ['HIGH', 'HIGH']); assert.strictEqual(state.high, 2);
  await assert.rejects(a.runActivityCheck(partial, [], {}), /APIFY_COMMENTS_TOKEN/);

  // Yard scheme through runActivityCheck: all four actors run, 5 items each, Unknown counted.
  const seen = [];
  const yardFetch = async (url, init) => {
    const u = new URL(url); const act = decodeURIComponent(u.pathname.split('/')[3]);
    const key = act.endsWith('posts') ? 'posts' : act.endsWith('comments') ? 'comments' : act.endsWith('reactions') ? 'reactions' : 'profile';
    seen.push(key);
    assert.strictEqual(JSON.parse(init.body).limit, 5); assert.strictEqual(u.searchParams.get('limit'), '5');
    const d = key === 'profile' ? [{ basic_info: { connection_count: 2500 } }] : [];
    return { ok: true, status: 201, json: async () => d, text: async () => '' };
  };
  const yr = await a.runActivityCheck(cfg, [me], { fetchImpl: yardFetch, now, scheme: 'yard', maxItems: 5 });
  assert.deepStrictEqual(seen, ['profile', 'posts', 'comments', 'reactions'], 'yard runs every actor');
  assert.strictEqual(yr.results[0].label, 'Unknown'); assert.strictEqual(yr.results[0].connections, 2500); assert.strictEqual(yr.state.unknown, 1); assert.strictEqual(yr.state.scheme, 'yard');
  console.log('PASS: linkedin activity labels');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
