#!/usr/bin/env node
/**
 * generate-embeddings.mjs — Pre-compute bundle embeddings for semantic search
 *
 * Reads bundles.json, generates a 384-dim embedding for each bundle using the
 * same model the browser uses (Xenova/all-MiniLM-L6-v2, q8).  Writes the
 * result to embeddings.json so the site can load pre-computed vectors instead
 * of recomputing them per session in the browser.
 *
 * This eliminates the "Indexing bundles…" delay on every user visit — the
 * model only needs to embed the user's query, not all 42 bundles.
 *
 * Usage:
 *   node .github/scripts/generate-embeddings.mjs
 *   node .github/scripts/generate-embeddings.mjs --input bundles.json --output embeddings.json
 *   node .github/scripts/generate-embeddings.mjs --dry-run
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs }     from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    input:     { type: 'string',  default: 'bundles.json' },
    output:    { type: 'string',  default: 'embeddings.json' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

// ── Load model ────────────────────────────────────────────────────────────────
// Use same version as the browser CDN import so vectors are in the same space.
const { pipeline, env } = await import('@huggingface/transformers');
env.allowLocalModels = false;
// Cache model files in .hf-cache next to this script to enable GH Actions caching
env.cacheDir = path.join(__dirname, '../../.hf-cache');

console.log('Loading model: Xenova/all-MiniLM-L6-v2 (q8)…');
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
console.log('Model ready.\n');

// ── Read bundles ──────────────────────────────────────────────────────────────
const bundles = JSON.parse(fs.readFileSync(args.input, 'utf8'));
console.log(`Computing embeddings for ${bundles.length} bundles…`);

// ── Compute ───────────────────────────────────────────────────────────────────
const embeddings = {};
for (const b of bundles) {
  // Exactly matches the text construction in index.html's loadSemanticSearch()
  const text = [b.name, b.namespace, b.description || '', (b.tags || []).join(' ')].join(' ');
  const out  = await embedder(text, { pooling: 'mean', normalize: true });

  // Store as regular array rounded to 6 decimal places.
  // Float32 has ~7 sig figs; 6dp keeps full precision while trimming trailing noise.
  // 42 bundles × 384 dims × ~8 chars/value ≈ ~130 KB total.
  embeddings[b.id] = Array.from(out.data).map(v => Math.round(v * 1e6) / 1e6);
  console.log(`  ✓  ${b.id}`);
}

const count = Object.keys(embeddings).length;

if (args['dry-run']) {
  const sizeEst = JSON.stringify(embeddings).length;
  console.log(`\n[dry-run] Would write ${count} embeddings (~${Math.round(sizeEst / 1024)} KB).`);
} else {
  fs.writeFileSync(args.output, JSON.stringify(embeddings) + '\n');
  const size = fs.statSync(args.output).size;
  console.log(`\nWritten → ${args.output}  (${count} embeddings, ${Math.round(size / 1024)} KB)`);
}
