const config = require('./config');
const logger = require('./logger');

// Prompt is identical to the one in ../n8n/02-ingest-webhook.json's
// "OpenAI - Qualify Candidate" node - keep the two in sync if the rubric changes.
function buildPrompt(c) {
  return `You are a LeadStrategus prospect qualification agent for client Sharp SSDI.

Objective: find people who influence Managed IT, Data Center Management, Document Management Systems, Digital Transformation, workflow automation, IT modernization, enterprise applications, administration, purchasing, and procurement decisions at their company.

Persona tiers (use for the 'priority' field):
Tier 1 — CIO, Group CIO, Chief Information & Digital Officer, Head of IT, IT Director, VP IT, Head of Technology, Head of Information Systems, Head of IT Infrastructure, Head of Enterprise Applications, Head of Digital Transformation, Chief Transformation Officer: direct ownership or strong influence over enterprise technology, infrastructure, systems, automation, or digital transformation decisions.
Tier 2 — COO, Head of Operations, VP Operations, Head of Business Transformation, Head of Process Excellence, Head of Automation, Head of Administration, Head of Procurement, Head of Purchase/Purchasing, Procurement Director, Purchase Director, Chief Procurement Officer, VP Procurement/Purchase: strong influence over operational improvement, enterprise processes, administration, vendor selection, purchasing, procurement, or commercial decisions.
Tier 3 — CFO, Finance Head, Shared Services Head, Commercial Head, Senior Procurement Manager, Senior Purchase Manager, Senior Administration Manager: secondary or supporting influence over workflows, approvals, purchasing, enterprise services, or transformation initiatives.
Avoid — Software Engineers, Developers, Software Engineering leaders, Product Engineering, Product Management, R&D, IT Support Engineers, System Administrators, Network Administrators, Junior IT roles, Procurement Executives, Purchase Executives, Buyers, Procurement Analysts, Admin Executives, Administrative Assistants, Junior Managers, standalone Data/Analytics/BI roles: do not prioritize.

Title-relevance score anchors (use these as reference points for the 'score' field, 1-100):
CIO / Group CIO / Chief Information & Digital Officer: 95+
IT Head / Head of IT / VP IT / IT Director: 90+
Head of IT Infrastructure / Head of Information Systems / Head of Enterprise Applications / Head of Digital Transformation / Chief Transformation Officer: 85-92
CTO: 90+ only if responsible for enterprise IT, infrastructure, internal systems, or digital transformation; score much lower if primarily responsible for software engineering, product development, architecture, or R&D
Chief Procurement Officer / Head of Procurement / Head of Purchase / Procurement Director / Purchase Director / Head of Administration: 78-88
COO / VP Operations / Head of Operations / Head of Business Transformation / Head of Process Excellence / Head of Automation: 70-85
IT Manager / Infrastructure Manager / Applications Manager / GM IT / DGM IT / AGM IT: 65-78
Senior Procurement Manager / Senior Purchase Manager / Senior Administration Manager: 60-72
CFO / Finance Head / Shared Services Head / Commercial Head: 45-60
Engineer / Developer / IT Support / SysAdmin / Junior IT / Junior Procurement / Junior Purchase / Junior Admin / standalone Data or Analytics roles: below 40

No company-level data (size, industry, tech maturity) is available for this candidate — score based on title and title description alone, and do not guess at company context. Judge functional relevance before generic seniority. Use the title description to understand actual responsibilities when available. Normalize equivalent titles such as IT Head / Head IT / Head of Information Technology and Purchase Head / Head of Purchase / Head Purchasing. Broader enterprise, group, global, corporate, or company-wide responsibility should score higher than narrow responsibility when seniority is similar. Do not automatically prioritize a senior executive from an unrelated function over a more relevant IT, transformation, administration, procurement, or purchasing leader.

Candidate:
Name: ${c.name}
Title: ${c.title}
Title description: ${c.titleDescription || 'None provided'}
Profile: ${c.profileUrl}
Company: ${c.company}
Location: ${c.location || 'Unknown'}

Return ONLY valid JSON with these exact keys: {"score": number, "seniority": "C-Suite|VP|Director|Manager|Other", "priority": "Tier 1|Tier 2|Tier 3|Skip", "reason": string}`;
}

const FALLBACK = { score: 0, seniority: 'Other', priority: 'Skip', reason: 'Could not parse LLM response' };

async function callOpenAI(prompt) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.openAiModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }

    const body = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    logger.warn(`OpenAI ${res.status} (attempt ${attempt}/${maxAttempts}): ${body.slice(0, 200)}`);
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`OpenAI request failed with ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  throw new Error('OpenAI request failed');
}

async function qualifyCandidate(candidate) {
  try {
    const content = await callOpenAI(buildPrompt(candidate));
    const parsed = JSON.parse(content);
    return {
      score: Number(parsed.score) || 0,
      seniority: parsed.seniority || 'Other',
      priority: parsed.priority || 'Skip',
      reason: parsed.reason || ''
    };
  } catch (err) {
    logger.warn(`Qualification failed for ${candidate.name}: ${err.message}`);
    return { ...FALLBACK, reason: `${FALLBACK.reason}: ${err.message}` };
  }
}

// Scores every candidate, then keeps the top N by score per company - same
// selection rule as the n8n pipeline's "Top 4 Per Company" node.
async function qualifyAndSelect(candidates) {
  const scored = [];
  for (const c of candidates) {
    const q = await qualifyCandidate(c);
    scored.push({
      ...c,
      ...q,
      status: q.score >= config.autoApproveScore ? 'Auto-Approved' : 'Needs Review'
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, config.topNPerCompany);
}

module.exports = { qualifyAndSelect };
