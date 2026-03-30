#!/usr/bin/env node
/**
 * sweep.mjs — Amplifier Registry nightly sweep
 *
 * Reads bundles.json, calls the GitHub API for each bundle's repo,
 * enriches the metadata (stars, last push, description), and writes
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

// ── GitHub API helper ────────────────────────────────────────────
async function ghApi(path) {
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}`);
  return res.json();
}

// ── Extract owner/repo from GitHub URL ───────────────────────────
function parseRepo(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:#.*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Real data only — no synthetic metrics generated here.

// ── Main ─────────────────────────────────────────────────────────
const raw  = fs.readFileSync(args.input, 'utf8');
const bundles = JSON.parse(raw);

console.log(`Sweeping ${bundles.length} bundles…`);
let updated = 0, failed = 0;

for (const bundle of bundles) {
  const r = parseRepo(bundle.repo);
  if (!r) { console.warn(`  skip  ${bundle.id} — no parseable repo URL`); continue; }

  try {
    const info = await ghApi(`/repos/${r.owner}/${r.repo}`);

    // ── Privacy gate: skip anything not publicly accessible ──────────────
    if (info.private) {
      console.warn(`  🔒 skip  ${bundle.id} — repo is private, removing from registry`);
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
      changes.push(`stars→${newStars}`);
    }
    if (newForks !== bundle.forks) {
      bundle.forks = newForks;
      changes.push(`forks→${newForks}`);
    }

    if (changes.length) {
      console.log(`  ✓  ${bundle.id} [${changes.join(', ')}]`);
      updated++;
    } else {
      console.log(`  —  ${bundle.id} no changes`);
    }

    // Rate-limit: 60 req/hr unauthenticated, 5000 with token
    await new Promise(r => setTimeout(r, TOKEN ? 50 : 1200));

  } catch (err) {
    console.warn(`  ✗  ${bundle.id} → ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. ${updated} updated, ${failed} failed, ${bundles.length - updated - failed} unchanged.`);

// Drop anything flagged as private during this sweep
const finalBundles = bundles.filter(b => !b._remove);
const dropped = bundles.length - finalBundles.length;
if (dropped > 0) console.log(`\n⚠️  Dropped ${dropped} bundles whose repos are now private.`);

if (DRY) {
  console.log('\n[dry-run] Would write:');
  console.log(JSON.stringify(finalBundles, null, 2).slice(0, 400) + '…');
} else {
  fs.writeFileSync(args.output, JSON.stringify(finalBundles, null, 2) + '\n');
  console.log(`Written → ${args.output} (${finalBundles.length} bundles)`);
}
