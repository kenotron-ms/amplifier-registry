#!/usr/bin/env node
/**
 * score.mjs — Amplifier Registry quality scorer
 *
 * Scores bundles against the rubric defined in RUBRIC.md.
 * Two passes:
 *   1. Objective pass  — GitHub API, no LLM (dims 3 + 5)
 *   2. LLM pass        — Anthropic API, requires ANTHROPIC_API_KEY (dims 1, 2, 4)
 *
 * Usage:
 *   node score.mjs                        # objective only (safe without API key)
 *   node score.mjs --llm                  # full score including LLM dims
 *   node score.mjs --llm --bundle zen-architect   # single bundle
 *   node score.mjs --dry-run              # print scores, don't write
 */

import fs from 'fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    llm:       { type: 'boolean', default: false },
    bundle:    { type: 'string'  },
    'dry-run': { type: 'boolean', default: false },
    input:     { type: 'string',  default: 'bundles.json' },
    output:    { type: 'string',  default: 'bundles.json' },
  },
  strict: false,
});

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN   || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const SCORE_VERSION  = '1.0';
const DRY            = args['dry-run'];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ghGet(path) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GH ${path} → ${r.status}`);
  return r.json();
}

function parseRepo(url) {
  const m = url?.match(/github\.com\/([^/#]+\/[^/#]+)/);
  return m ? m[1] : null;
}

function daysSince(isoDate) {
  if (!isoDate) return 999;
  return Math.floor((Date.now() - new Date(isoDate)) / 86400000);
}

function starsToLabel(n) {
  return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);
}

// ── Dimension 3: Activity & Maintenance (objective) ──────────────────────────

async function scoreActivity(repoPath, info) {
  const pushDays = daysSince(info.pushed_at);

  // Try to get recent closed issues count
  let closedIssues = 0;
  let hasReleases   = false;
  let hasMergedPRs  = false;
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    const closed = await ghGet(`/repos/${repoPath}/issues?state=closed&since=${ninetyDaysAgo}&per_page=1`);
    closedIssues = closed.length;
    const releases = await ghGet(`/repos/${repoPath}/releases?per_page=1`);
    hasReleases = releases.length > 0;
    const prs = await ghGet(`/repos/${repoPath}/pulls?state=closed&per_page=5`);
    hasMergedPRs = prs.some(p => p.merged_at);
  } catch { /* continue with what we have */ }

  const recentActivity = closedIssues > 0 || hasReleases || hasMergedPRs;

  if (pushDays <= 30 && recentActivity) return 4;
  if (pushDays <= 30) return 3;
  if (pushDays <= 60) return 3;
  if (pushDays <= 90 && recentActivity) return 3;
  if (pushDays <= 180) return 2;
  if (pushDays <= 365) return 1;
  return 0;
}

// ── Dimension 5: Trust Signals (objective) ───────────────────────────────────

async function scoreTrust(repoPath) {
  let hasLicense    = false;
  let hasCi         = false;
  let hasTests      = false;
  let hasChangelog  = false;

  try {
    const tree = await ghGet(`/repos/${repoPath}/git/trees/HEAD?recursive=0`);
    const paths = (tree.tree || []).map(f => f.path.toLowerCase());

    hasLicense   = paths.some(p => p === 'license' || p === 'license.md' || p === 'license.txt');
    hasCi        = paths.some(p => p.startsWith('.github/workflows'));
    hasTests     = paths.some(p => p === 'test' || p === 'tests' || p.includes('.test.') || p.includes('.spec.'));
    hasChangelog = paths.some(p => p.startsWith('changelog') || p.startsWith('history'));
  } catch { /* repo may have no commits or unusual structure */ }

  if (hasLicense && hasCi && (hasTests || hasChangelog)) return 4;
  if (hasLicense && hasCi) return 3;
  if (hasLicense) return 2;
  return 0; // No LICENSE = 0 regardless of anything else
}

// ── Fetch README ──────────────────────────────────────────────────────────────

async function fetchReadme(repoPath) {
  // Try raw.githubusercontent.com first — doesn't consume API quota
  for (const branch of ['main', 'master']) {
    for (const file of ['README.md', 'readme.md', 'README.MD']) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${repoPath}/${branch}/${file}`);
        if (r.ok) return (await r.text()).slice(0, 8000);
      } catch { /* try next */ }
    }
  }
  // Fall back to API
  try {
    const r = await ghGet(`/repos/${repoPath}/readme`);
    return r.content ? Buffer.from(r.content, 'base64').toString('utf8').slice(0, 8000) : '';
  } catch { return ''; }
}

// ── LLM scoring (dims 1, 2, 4) ───────────────────────────────────────────────

const DIM_PROMPTS = {
  docs: `You are scoring Dimension 1 — Documentation Quality.

Rubric:
4 = Clear purpose, clear audience, install instructions, usage example, AND discusses tradeoffs or when not to use.
3 = Clear purpose, install, at least one usage example. No major gaps.
2 = Purpose clear, install present, but no examples or audience unclear.
1 = README exists but sparse, vague, or mostly template boilerplate.
0 = No README, empty, or gives no useful information about the bundle.

Output ONLY valid JSON: {"score": <0-4>, "reason": "<one sentence>"}`,

  design: `You are scoring Dimension 2 — Bundle / Agent Design Quality.

Rubric:
4 = Proper Amplifier bundle structure, rich context files, clear agent/tool description, follows context-sink or delegation philosophy, obvious care in prompt design.
3 = Proper structure, meaningful context files, install and type make sense. Minor gaps.
2 = Recognizable Amplifier bundle, install present, context files thin.
1 = Minimal bundle structure, install declared, but little or no context or guidance.
0 = Cannot be identified as a proper Amplifier bundle.

Output ONLY valid JSON: {"score": <0-4>, "reason": "<one sentence>"}`,

  code: `You are scoring Dimension 4 — Code / Prompt Quality.

Rubric:
4 = Clear expertise: well-structured prompts with reasoning guidance, handles edge cases, no quick-fix patterns.
3 = Solid, minor weaknesses. Prompts coherent and purposeful.
2 = Functional but shallow. Prompts generic or could apply to many tools unchanged.
1 = Minimal. Little design thought visible in prompts or code.
0 = No meaningful implementation. Placeholder or entirely boilerplate.

Output ONLY valid JSON: {"score": <0-4>, "reason": "<one sentence>"}`,
};

async function scoreLLMDim(dim, bundle, readme) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = DIM_PROMPTS[dim];
  const userContent  = `Bundle: ${bundle.namespace}:${bundle.name}
Type: ${bundle.type}
Description: ${bundle.description || '(none)'}
Install: ${bundle.install || '(none)'}

README (truncated to 8000 chars):
\`\`\`
${readme || '(no readme found)'}
\`\`\``;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '{}';

  // Extract JSON even if the model wraps it in markdown fences
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(jsonStr);
    return { score: Math.max(0, Math.min(4, Number(parsed.score) || 0)), reason: parsed.reason || '' };
  } catch {
    console.warn(`    warn: couldn't parse LLM response for ${dim}: ${text.slice(0,80)}`);
    return { score: 0, reason: 'Could not parse' };
  }
}

// ── Star rating from total ────────────────────────────────────────────────────

function totalToRating(total) {
  if (total >= 18) return 5.0;
  if (total >= 15) return 4.5;
  if (total >= 12) return 4.0;
  if (total >=  9) return 3.5;
  if (total >=  6) return 3.0;
  if (total >=  3) return 2.0;
  return 1.0;
}

// ── Score one bundle ──────────────────────────────────────────────────────────

async function scoreBundle(bundle) {
  const repoPath = parseRepo(bundle.repo);
  if (!repoPath) return null;

  console.log(`  Scoring ${bundle.id}…`);

  let info;
  try { info = await ghGet(`/repos/${repoPath}`); }
  catch (e) { console.warn(`    skip — ${e.message}`); return null; }

  if (info.private) { console.warn(`    skip — private repo`); return null; }

  // Objective dims
  const [activity, trust] = await Promise.all([
    scoreActivity(repoPath, info).catch(() => 0),
    scoreTrust(repoPath).catch(() => 0),
  ]);

  // LLM dims (optional)
  let docs = bundle.quality?.docs ?? null;
  let design = bundle.quality?.design ?? null;
  let code = bundle.quality?.code ?? null;
  let docsReason   = bundle.quality?.docsReason   || '';
  let designReason = bundle.quality?.designReason  || '';
  let codeReason   = bundle.quality?.codeReason    || '';

  if (args.llm) {
    const readme = await fetchReadme(repoPath);
    await new Promise(r => setTimeout(r, 200)); // brief pause between calls
    const [d, de, c] = await Promise.all([
      scoreLLMDim('docs',   bundle, readme).catch(e => ({ score: 0, reason: e.message })),
      scoreLLMDim('design', bundle, readme).catch(e => ({ score: 0, reason: e.message })),
      scoreLLMDim('code',   bundle, readme).catch(e => ({ score: 0, reason: e.message })),
    ]);
    docs = d.score;   docsReason   = d.reason;
    design = de.score; designReason = de.reason;
    code = c.score;   codeReason   = c.reason;
  }

  // Use existing LLM scores if we didn't re-run LLM, or default to 2 if never scored
  if (docs   === null) docs   = bundle.quality?.docs   ?? 2;
  if (design === null) design = bundle.quality?.design  ?? 2;
  if (code   === null) code   = bundle.quality?.code   ?? 2;

  const total  = docs + design + activity + code + trust;
  const rating = totalToRating(total);

  return {
    docs, design, activity, code, trust,
    docsReason, designReason, codeReason,
    total,
    rating,
    scoreVersion: SCORE_VERSION,
    scoredAt: new Date().toISOString().slice(0, 10),
    llmScored: args.llm,
    // Surface real GitHub signals
    stars:     info.stargazers_count ?? bundle.stars ?? 0,
    forks:     info.forks_count      ?? bundle.forks ?? 0,
    lastUpdated: info.pushed_at?.slice(0,10) ?? bundle.lastUpdated,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const raw     = fs.readFileSync(args.input, 'utf8');
const bundles = JSON.parse(raw);

const targets = args.bundle
  ? bundles.filter(b => b.id === args.bundle)
  : bundles;

if (!targets.length) {
  console.error(`No bundles found${args.bundle ? ` matching id="${args.bundle}"` : ''}`);
  process.exit(1);
}

console.log(`\nScoring ${targets.length} bundle(s)${args.llm ? ' (with LLM dims)' : ' (objective dims only)'}…\n`);

let scored = 0, skipped = 0;

for (const bundle of targets) {
  const result = await scoreBundle(bundle);
  if (!result) { skipped++; continue; }

  // Write back into the original bundles array
  const idx = bundles.findIndex(b => b.id === bundle.id);
  if (idx >= 0) {
    bundles[idx].quality     = result;
    bundles[idx].rating      = result.rating;     // top-level for compat
    bundles[idx].stars       = result.stars;
    bundles[idx].forks       = result.forks;
    bundles[idx].lastUpdated = result.lastUpdated;
  }
  scored++;

  // Rate-limit
  await new Promise(r => setTimeout(r, GITHUB_TOKEN ? 80 : 1500));
}

console.log(`\n✓ ${scored} scored, ${skipped} skipped.`);

if (DRY) {
  const sample = bundles.find(b => b.quality);
  console.log('\n[dry-run] Sample quality object:');
  console.log(JSON.stringify(sample?.quality, null, 2));
} else {
  fs.writeFileSync(args.output, JSON.stringify(bundles, null, 2) + '\n');
  console.log(`Written → ${args.output}`);
}
