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

// posts actor
const posts = a.summarizePosts([
  { post_type: 'regular', posted_at: { date: '2026-09-30 12:10:52', timestamp: now - 1 * day }, url: 'https://www.linkedin.com/posts/activity-1', author: { username: 'kingshuk' } },
  { post_type: 'repost', posted_at: { date: '2026-09-26 06:14:44', timestamp: now - 5 * day }, url: 'https://www.linkedin.com/posts/activity-2', author: { username: 'anurag-malti-chaurasia' } },
  { post_type: 'regular', posted_at: { timestamp: now - 2 * day }, url: 'x', author: { username: 'komalamaran' } },
  { post_type: 'regular', posted_at: { timestamp: now - 400 * day }, url: 'https://www.linkedin.com/posts/activity-old', author: { username: 'kingshuk' } }
], 'kingshuk');
assert.deepStrictEqual(posts.map((p) => p.kind), ['post', 'repost', 'post'], 'another author\'s regular post is not this person\'s activity; a repost is');

// comments actor
const comments = a.summarizeComments([{ comment_text: 'Congrats', created_at: { timestamp: now - 10 * day, formatted: '2026-09-21 09:13:14' }, comment_link: 'https://www.linkedin.com/feed/update/urn:li:activity:1?commentUrn=x' }]);
assert.strictEqual(comments[0].kind, 'comment'); assert.ok(comments[0].url.includes('commentUrn'));

// reactions actor
const reactions = a.summarizeReactions([{ action: 'Komala Maran celebrates this', post_url: 'https://www.linkedin.com/posts/anurag_x', timestamps: { date: '2026-09-18 11:46:11', timestamp: now - 13 * day } }]);
assert.strictEqual(reactions[0].kind, 'reaction'); assert.strictEqual(reactions[0].text, 'Komala Maran celebrates this');

// labels
let r = a.classify({ activities: posts, connections: 300, now });
assert.strictEqual(r.label, 'HIGH'); assert.strictEqual(r.proof, 'https://www.linkedin.com/posts/activity-1'); assert.match(r.reason, /posted on 2026-09-30/);
r = a.classify({ activities: [posts[1]], connections: 100, now });
assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /repost on 2026-09-26/); assert.strictEqual(r.proof, 'https://www.linkedin.com/posts/activity-2');
r = a.classify({ activities: comments, connections: 100, now }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /comment/);
r = a.classify({ activities: reactions, connections: null, now }); assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /celebrates this on 2026-09-18/);
r = a.classify({ activities: [posts[2]], connections: 1839, now }); // only an old post
assert.strictEqual(r.label, 'MEDIUM'); assert.match(r.reason, /1839\+ connections, no activity in 90 days/); assert.strictEqual(r.lastActivity, '2025-08-27');
r = a.classify({ activities: [posts[2]], connections: 120, now }); assert.strictEqual(r.label, 'LOW'); assert.match(r.reason, /last activity 2025-08-27/);
r = a.classify({ activities: [], connections: null, now }); assert.strictEqual(r.label, 'LOW');

(async () => {
  // full check against mocked Apify: 4 actors in parallel, token in header, errors recorded not thrown.
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); calls.push(u.pathname);
    const act = decodeURIComponent(u.pathname.split('/')[3]);
    const expectTok = act.endsWith('posts') ? 'Bearer t-posts' : act.endsWith('comments') ? 'Bearer t-comments' : act.endsWith('reactions') ? 'Bearer t-reactions' : 'Bearer t-profile';
    assert.strictEqual(init.headers.Authorization, expectTok, 'each actor gets only its own token');
    const body = JSON.parse(init.body); assert.strictEqual(body.username, 'kingshuk');
    assert.strictEqual(body.limit, 2, 'actors are asked for 2 items'); assert.strictEqual(u.searchParams.get('limit'), '2', 'dataset capped at 2');
    const actor = decodeURIComponent(u.pathname.split('/')[3]);
    let d;
    if (actor.endsWith('posts')) d = [1, 2, 3].map((i) => ({ post_type: 'regular', posted_at: { timestamp: now - i * 3 * day }, url: 'https://www.linkedin.com/posts/p' + i, author: { username: 'kingshuk' } }));
    else if (actor.endsWith('comments')) d = [];
    else if (actor.endsWith('detail')) d = [{ basic_info: { connection_count: 1839 } }];
    else return { ok: false, status: 500, text: async () => 'actor crashed' };
    return { ok: true, status: 201, json: async () => d, text: async () => '' };
  };
  const cfg = a.configFromEnv({ APIFY_POSTS_TOKEN: 't-posts', APIFY_COMMENTS_TOKEN: 't-comments', APIFY_REACTIONS_TOKEN: 't-reactions', APIFY_PROFILE_TOKEN: 't-profile' });
  assert.strictEqual(cfg.configured, true);
  const partial = a.configFromEnv({ APIFY_POSTS_TOKEN: 'x' });
  assert.strictEqual(partial.configured, false); assert.deepStrictEqual(partial.missing, ['APIFY_COMMENTS_TOKEN', 'APIFY_REACTIONS_TOKEN', 'APIFY_PROFILE_TOKEN']);
  assert.strictEqual(a.configFromEnv({ APIFY_TOKEN: 'one' }).configured, true, 'a single token still works as fallback');
  const res = await a.checkPerson(cfg, { name: 'Kingshuk Hazra', profileUrl: 'https://www.linkedin.com/in/kingshuk' }, { fetchImpl, now });
  assert.strictEqual(res.label, 'HIGH'); assert.strictEqual(res.connections, 1839);
  assert.strictEqual(res.counts.posts, 2, 'never more than 2 items per actor are used');
  assert.strictEqual(res.proof, 'https://www.linkedin.com/posts/p1'); assert.deepStrictEqual(res.errors, ['reactions: Apify apimaestro~linkedin-profile-reactions 500: actor crashed']);
  assert.strictEqual(calls.length, 4);
  const noUrl = await a.checkPerson(cfg, { name: 'X', profileUrl: '' }, { fetchImpl, now });
  assert.strictEqual(noUrl.label, '');
  const { results, state } = await a.runActivityCheck(cfg, [{ name: 'A', profileUrl: 'https://www.linkedin.com/in/kingshuk' }, { name: 'B', profileUrl: 'https://www.linkedin.com/in/kingshuk' }], { fetchImpl, now });
  assert.deepStrictEqual(results.map((x) => x.label), ['HIGH', 'HIGH']); assert.strictEqual(state.high, 2);
  await assert.rejects(a.runActivityCheck(partial, [], {}), /APIFY_COMMENTS_TOKEN/);
  console.log('PASS: linkedin activity labels');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
