#!/usr/bin/env node
/**
 * sweep.mjs — Amplifier Registry nightly sweep
 *
 * Reads bundles.json, calls the GitHub API for each bundle's repo,
 * enriches the metadata (stars, last push, description, behaviors), and writes
 * an updated bundles.json.
 *
 * Usage:
 *   node sweep.mjs --input bundles.json --output bundles.json
 *   node sweep.mjs --dry-run   (print diff, no write)
 */

import fs from 'fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    input:   { type: 'string',  default: 'bundles.json' },
    output:  { type: 'string',  default: 'bundles.json' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

const TOKEN = process.env.GITHUB_TOKEN || '';
const DRY   = args['dry-run'];

// ── GitHub API helper ────────────────────────────────────────────────────────
async function ghApi(path) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path} => ${res.status}`);
  return res.json();
}

// ── Extract owner/repo from GitHub URL ──────────────────────────────────────
function parseRepo(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:#.*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ── Behavior scanner helpers ─────────────────────────────────────────────────

// Fetch a raw file from GitHub (does not consume API quota)
async function fetchRaw(owner, repo, path) {
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
      );
      if (res.ok) return res.text();
    } catch { /* try next branch */ }
  }
  return null;
}

// Extract description from a behavior YAML (handles block scalar and inline)
function extractDescription(text) {
  // Block scalar: "  description: |\n    line1\n    line2"
  const blockMatch = text.match(/^[ \t]{2,}description:\s*[|>][-+]?\s*\n((?:[ \t]{4,}[^\n]*\n?)+)/m);
  if (blockMatch) {
    const raw    = blockMatch[1];
    const indent = raw.match(/^([ \t]+)/)?.[1]?.length ?? 4;
    return raw.split('\n').map(l => l.slice(indent)).join('\n').trim();
  }
  // Inline: "  description: some text"
  const inlineMatch = text.match(/^[ \t]{2,}description:\s+['"]?(.+?)['"]?\s*$/m);
  return inlineMatch?.[1]?.trim() || '';
}

// Extract module names listed under a top-level YAML section (tools or hooks)
function extractModules(text, section) {
  const re = new RegExp(`^${section}:\\s*\\n((?:[ \\t][^\\n]*\\n?)*)`, 'm');
  const block = text.match(re)?.[1] || '';
  return [...block.matchAll(/- module:\s*(.+)/g)].map(m => m[1].trim());
}

// Extract agent refs (namespace:name) from the agents: section
function extractAgents(text) {
  const re = /^agents:\s*\n((?:[ \t][^\n]*\n?)*)/m;
  const block = text.match(re)?.[1] || '';
  const agents = new Set();
  // List items: "  - namespace:agent-name" (including under include:)
  for (const m of block.matchAll(/- ([a-z][a-z0-9-]*:[a-z][a-z0-9/_-]*)/g)) agents.add(m[1]);
  // Map values:  "include: namespace:path"
  for (const m of block.matchAll(/include:\s+([a-z][a-z0-9-]*:[a-z][a-z0-9/_-]*)/g)) agents.add(m[1]);
  return [...agents].slice(0, 10);
}

// Parse a single behavior YAML into a structured object
function parseBehaviorYaml(text, filePath, repoGitUrl) {
  // Must have bundle.name
  const name = text.match(/^bundle:\s*\n\s+name:\s*(.+)/m)?.[1]?.trim();
  if (!name) return null;

  const version  = text.match(/^\s+version:\s*['"]?([^\s'"#\n]+)/m)?.[1]?.trim();
  const rawDesc  = extractDescription(text);
  const tools    = extractModules(text, 'tools');
  const hooks    = extractModules(text, 'hooks');
  const agents   = extractAgents(text);
  const install  = `amplifier bundle add ${repoGitUrl}@main#subdirectory=${filePath} --app`;

  const result = { file: filePath, name, install };
  if (version) result.version = version;
  if (rawDesc) result.description = rawDesc.replace(/\n+/g, ' ').trim().slice(0, 280);
  if (tools.length)  result.tools  = tools;
  if (hooks.length)  result.hooks  = hooks;
  if (agents.length) result.agents = agents;
  return result;
}

// Scan a repo's behaviors/ directory and return parsed behavior objects.
// Returns null on API error (caller preserves existing data), [] if no behaviors found.
async function scanBehaviors(owner, repo, repoGitUrl) {
  let tree;
  try {
    tree = await ghApi(`/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
  } catch {
    return null; // transient error — preserve existing behaviors
  }

  const behaviorPaths = (tree.tree || [])
    .filter(f => f.type === 'blob' && /^behaviors\/[^/]+\.yaml$/.test(f.path))
    .map(f => f.path);

  if (!behaviorPaths.length) return [];

  const results = [];
  for (const path of behaviorPaths) {
    const text = await fetchRaw(owner, repo, path);
    if (!text) continue;
    const parsed = parseBehaviorYaml(text, path, repoGitUrl);
    if (parsed) results.push(parsed);
    await new Promise(r => setTimeout(r, TOKEN ? 20 : 250));
  }
  return results;
}

// Real data only — no synthetic metrics generated here.

// ── Main ─────────────────────────────────────────────────────────────────────
const raw  = fs.readFileSync(args.input, 'utf8');
const bundles = JSON.parse(raw);

console.log(`Sweeping ${bundles.length} bundles...`);
let updated = 0, failed = 0;

for (const bundle of bundles) {
  const r = parseRepo(bundle.repo);
  if (!r) { console.warn(`  skip  ${bundle.id} — no parseable repo URL`); continue; }

  try {
    const info = await ghApi(`/repos/${r.owner}/${r.repo}`);

    // ── Privacy gate: skip anything not publicly accessible ────────────────
    if (info.private) {
      console.warn(`  skip  ${bundle.id} — repo is private, removing from registry`);
      bundle._remove = true;
      continue;
    }

    // Enrich: prefer fetched data but don't overwrite hand-crafted descriptions
    const changes = [];

    if (info.description && !bundle.description) {
      bundle.description = info.description;
      changes.push('description');
    }

    const lastPush = info.pushed_at?.slice(0,10);
    if (lastPush && lastPush !== bundle.lastUpdated) {
      bundle.lastUpdated = lastPush;
      changes.push('lastUpdated');
    }

    if (info.topics?.length && !bundle.tags?.length) {
      bundle.tags = info.topics.slice(0, 6);
      changes.push('tags');
    }

    // Real signals: stars and forks from GitHub
    const newStars = info.stargazers_count || 0;
    const newForks = info.forks_count || 0;

    if (newStars !== bundle.stars) {
      bundle.stars = newStars;
      changes.push(`stars=>${newStars}`);
    }
    if (newForks !== bundle.forks) {
      bundle.forks = newForks;
      changes.push(`forks=>${newForks}`);
    }

    // ── Behavior scanning ──────────────────────────────────────────────────
    // Convert https://github.com/owner/repo to git+https://github.com/owner/repo
    const repoGitUrl = `git+https://github.com/${r.owner}/${r.repo}`;
    const behaviors = await scanBehaviors(r.owner, r.repo, repoGitUrl);
    if (behaviors === null) {
      // API error — keep whatever we had
    } else if (behaviors.length > 0) {
      bundle.behaviors = behaviors;
      bundle.behaviorsScannedAt = new Date().toISOString().slice(0, 10);
      changes.push(`behaviors:${behaviors.length}`);
    } else {
      // Repo has no behaviors/ dir — clear stale data
      if (bundle.behaviors) {
        delete bundle.behaviors;
        delete bundle.behaviorsScannedAt;
        changes.push('behaviors:cleared');
      }
      bundle.behaviorsScannedAt = new Date().toISOString().slice(0, 10);
    }

    if (changes.length) {
      console.log(`  +  ${bundle.id} [${changes.join(', ')}]`);
      updated++;
    } else {
      console.log(`  -  ${bundle.id} no changes`);
    }

    // Rate-limit: 60 req/hr unauthenticated, 5000 with token
    await new Promise(r => setTimeout(r, TOKEN ? 50 : 1200));

  } catch (err) {
    console.warn(`  x  ${bundle.id} => ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. ${updated} updated, ${failed} failed, ${bundles.length - updated - failed} unchanged.`);

// Drop anything flagged as private during this sweep
const finalBundles = bundles.filter(b => !b._remove);
const dropped = bundles.length - finalBundles.length;
if (dropped > 0) console.log(`\n  Dropped ${dropped} bundles whose repos are now private.`);

if (DRY) {
  console.log('\n[dry-run] Would write:');
  console.log(JSON.stringify(finalBundles, null, 2).slice(0, 400) + '...');
} else {
  fs.writeFileSync(args.output, JSON.stringify(finalBundles, null, 2) + '\n');
  console.log(`Written => ${args.output} (${finalBundles.length} bundles)`);
}
