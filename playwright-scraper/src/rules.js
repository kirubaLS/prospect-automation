// Deterministic, project-configured qualification: the project's config
// lists priority tiers as title regexes (first match wins, top to bottom),
// an exclude list, and a seniority bonus. Mirrors the researchers' SOPs,
// which are title-driven, at zero cost and with reproducible results.
// A project can set "qualification": "openai" to use the LLM rubric instead.

function compile(patterns) {
  return (patterns || []).map((p) => new RegExp(p, 'i'));
}

function buildMatcher(rules) {
  const tiers = (rules.tiers || []).map((t) => ({ ...t, regexes: compile(t.patterns) }));
  const exclude = compile(rules.exclude);
  const bonus = rules.seniorityBonus || {};

  return function qualify(candidate) {
    const text = `${candidate.title || ''} | ${candidate.headline || ''}`;
    const titleOnly = candidate.title || '';

    const excludedBy = exclude.find((re) => re.test(titleOnly));
    if (excludedBy) {
      return { score: 0, priority: 'Skip', seniority: seniorityLabel(candidate.seniority), reason: `Excluded title pattern: ${excludedBy.source}` };
    }

    for (const tier of tiers) {
      const hit = tier.regexes.find((re) => re.test(titleOnly)) || tier.regexes.find((re) => re.test(text));
      if (hit) {
        const score = Math.max(1, Math.min(100, tier.score + (bonus[candidate.seniority] || 0)));
        return {
          score,
          priority: tier.priority,
          seniority: candidate.seniority ? seniorityLabel(candidate.seniority) : tier.seniority || 'Other',
          reason: `${tier.priority}: title matched "${hit.source}"${candidate.seniority ? ` (Apollo seniority: ${candidate.seniority})` : ''}`
        };
      }
    }

    return {
      score: Math.max(1, 30 + (bonus[candidate.seniority] || 0)),
      priority: 'Skip',
      seniority: seniorityLabel(candidate.seniority),
      reason: 'No ICP title pattern matched'
    };
  };
}

function seniorityLabel(apolloSeniority) {
  const map = {
    owner: 'C-Suite',
    founder: 'C-Suite',
    c_suite: 'C-Suite',
    partner: 'C-Suite',
    vp: 'VP',
    head: 'Director',
    director: 'Director',
    manager: 'Manager',
    senior: 'Other',
    entry: 'Other',
    intern: 'Other'
  };
  return map[apolloSeniority] || 'Other';
}

// Scores every candidate and keeps the top N, preferring earlier seniority
// tiers on equal score (decision makers before fallback managers) and
// dropping "Skip" only when enough non-skipped candidates exist.
function qualifyAndSelectByRules(candidates, project) {
  const qualify = buildMatcher(project.rules || {});
  const scored = candidates
    .map((c) => ({ ...c, ...qualify(c) }))
    // An excluded title (doctor, developer, assistant...) is never a prospect,
    // not even as filler when the company is short of ICP matches.
    .filter((c) => !/^Excluded/.test(c.reason));
  scored.sort((a, b) => b.score - a.score || (a.tierIndex ?? 0) - (b.tierIndex ?? 0));
  const matched = scored.filter((c) => c.priority !== 'Skip');
  // Fill up to the target with unmatched-but-not-excluded people, flagged
  // for review, only when the ICP matches alone fall short.
  const pool = matched.length >= project.targetPerCompany ? matched : scored;
  return pool.slice(0, project.targetPerCompany).map((c) => ({
    ...c,
    status: c.priority === 'Skip' ? 'Needs Review' : 'Auto-Approved'
  }));
}

module.exports = { buildMatcher, qualifyAndSelectByRules, seniorityLabel };
