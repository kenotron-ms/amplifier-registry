# Amplifier Registry

**→ [kenotron-ms.github.io/amplifier-registry](https://kenotron-ms.github.io/amplifier-registry/)**

Community registry for [Amplifier](https://github.com/microsoft/amplifier) bundles, agents, modules, tools, and recipes. Browse by type, sort by quality score, and submit your own.

---

## What's in here

| File | Purpose |
|---|---|
| `index.html` | The registry site — a self-contained single-page app |
| `bundles.json` | All listed bundles with metadata and quality scores |
| `RUBRIC.md` | The published quality rubric (5 dimensions, 0–4 each) |
| `.github/workflows/pages.yml` | Deploys to GitHub Pages on every push to `main` |
| `.github/workflows/sweep.yml` | Nightly sweep — updates stars, forks, last-updated from GitHub API |
| `.github/scripts/sweep.mjs` | The sweep script |
| `.github/scripts/score.mjs` | The quality scoring engine (objective + LLM) |

## How scores work

Every bundle is scored on five dimensions using [RUBRIC.md](./RUBRIC.md):

1. **Documentation** — LLM reads the public README
2. **Bundle / Agent Design** — LLM evaluates Amplifier pattern adherence
3. **Activity & Maintenance** — GitHub API: recency, issues, releases
4. **Code / Prompt Quality** — LLM evaluates prompts and implementation
5. **Trust Signals** — GitHub API: LICENSE, CI, tests

Total 0–20 points → 1.0–5.0 star rating. All repos are verified publicly accessible before listing.

## Adding a bundle

**Option A — Open an issue** using the [bundle submission template](https://github.com/kenotron-ms/amplifier-registry/issues/new?template=bundle-submission.yml). We'll verify it, run the scorer, and add it.

**Option B — Open a PR** adding your bundle directly to `bundles.json`. Match the existing schema; leave `quality` empty and it will be populated by the next scoring run.

The only requirement: **the repo must be publicly accessible** without authentication.

## Running the sweep locally

```bash
GITHUB_TOKEN=$(gh auth token) node .github/scripts/sweep.mjs
```

## Running the scorer locally

```bash
# Objective dims only (activity + trust from GitHub API)
GITHUB_TOKEN=$(gh auth token) node .github/scripts/score.mjs

# Full score including LLM dims (requires Anthropic API key)
GITHUB_TOKEN=$(gh auth token) \
ANTHROPIC_API_KEY=sk-ant-... \
node .github/scripts/score.mjs --llm

# Single bundle
GITHUB_TOKEN=$(gh auth token) \
ANTHROPIC_API_KEY=sk-ant-... \
node .github/scripts/score.mjs --llm --bundle zen-architect
```

## Triggering the sweep via GitHub Actions

```bash
gh workflow run sweep.yml --repo kenotron-ms/amplifier-registry
```
