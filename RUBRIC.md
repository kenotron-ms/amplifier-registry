# Amplifier Registry — Quality Rubric

**Version:** 1.0  
**Effective:** 2026-03-29  
**Applies to:** All bundles, agents, modules, tools, and recipes listed in this registry.

Every entry in this registry receives a quality score computed by running the same rubric against the same inputs, every time. This document is the canonical definition of that rubric. If the rubric changes, the version number increments and all scores are recomputed.

---

## How scoring works

Five dimensions, each scored **0 – 4**. Scores are summed to a total of **0 – 20**, then mapped to a **1.0 – 5.0 star rating**.

| Dimension | Source | Weight |
|---|---|---|
| 1. Documentation | LLM-judged (README + description) | 4 pts |
| 2. Bundle / Agent Design | LLM-judged (bundle structure, context files) | 4 pts |
| 3. Activity & Maintenance | GitHub API — objective | 4 pts |
| 4. Code / Prompt Quality | LLM-judged (code or prompt content) | 4 pts |
| 5. Trust Signals | GitHub API — objective | 4 pts |
| **Total** | | **20 pts** |

**Star mapping:**

| Points | Stars | Display |
|---|---|---|
| 18 – 20 | 5.0 | ★★★★★ |
| 15 – 17 | 4.5 | ★★★★½ |
| 12 – 14 | 4.0 | ★★★★ |
| 9 – 11 | 3.5 | ★★★½ |
| 6 – 8  | 3.0 | ★★★ |
| 3 – 5  | 2.0 | ★★ |
| 0 – 2  | 1.0 | ★ |

---

## Dimension 1 — Documentation Quality

*How well does the README communicate what this does, who it's for, and how to use it?*

| Score | Criteria |
|---|---|
| **4** | Clear purpose statement, clear audience, install instructions, one or more usage examples, and explains when *not* to use it or what tradeoffs exist. |
| **3** | Clear purpose, clear install, at least one usage example. No significant gaps. |
| **2** | Purpose is clear, install command present, but no examples or the audience is ambiguous. |
| **1** | README exists but is sparse, vague, or primarily a copy of the auto-generated template. |
| **0** | No README, empty README, or README that does not describe the bundle at all. |

**LLM prompt anchor:** *"Evaluate the README and description for this Amplifier bundle. Score 0–4 on Documentation Quality using the rubric. A 4 requires: purpose, audience, install, example, and tradeoffs. A 0 means no useful documentation exists."*

---

## Dimension 2 — Bundle / Agent Design

*Is this a well-designed Amplifier bundle? Does it follow ecosystem patterns and provide a clear, usable interface?*

| Score | Criteria |
|---|---|
| **4** | Proper Amplifier bundle structure. Rich context files. Clear agent/tool description. Follows the context-sink pattern or delegation philosophy where appropriate. Obvious care taken in prompt design. |
| **3** | Proper bundle structure with meaningful context files. The install command and type declaration make sense. Minor gaps in description quality. |
| **2** | Recognizable as an Amplifier bundle. Install command works. Context files present but thin. |
| **1** | Minimal bundle structure. Install command declared but little or no accompanying context, description, or agent guidance. |
| **0** | Cannot be identified as a proper Amplifier bundle. No meaningful bundle-specific structure. |

**LLM prompt anchor:** *"Evaluate the bundle structure, context files, agent descriptions, and adherence to Amplifier design philosophy. Score 0–4 on Bundle Design. A 4 is a model example of how to build an Amplifier bundle."*

---

## Dimension 3 — Activity & Maintenance

*Is this bundle being actively maintained? Computed from public GitHub API data — no LLM involvement.*

| Score | Criteria |
|---|---|
| **4** | Last commit ≤ 30 days ago **and** at least one of: issues closed in past 90 days, a release tag exists, or a merged PR in past 90 days. |
| **3** | Last commit ≤ 60 days ago, or last commit ≤ 90 days with some issue or PR activity. |
| **2** | Last commit ≤ 180 days ago. |
| **1** | Last commit between 6 and 12 months ago. |
| **0** | No commits in over 12 months, or repository appears abandoned. |

**Inputs from GitHub API:** `pushed_at`, `open_issues_count`, closed issues count, release tags, merged PRs.

---

## Dimension 4 — Code / Prompt Quality

*Is the underlying implementation — code, prompts, recipes, or context — of high quality?*

| Score | Criteria |
|---|---|
| **4** | Implementation demonstrates clear expertise. Prompts are well-structured with explicit reasoning guidance. Code (if present) is readable, handles edge cases, and follows language best practices. No obvious quick-fix patterns. |
| **3** | Solid implementation with minor weaknesses. Prompts are coherent and purposeful. Code is reasonable. |
| **2** | Functional but shallow. Prompts are generic or could apply to many different tools without significant modification. Code, if present, is basic. |
| **1** | Minimal implementation. Little evidence of design thought in prompts or code. |
| **0** | No meaningful implementation visible. Placeholder content or entirely boilerplate. |

**LLM prompt anchor:** *"Evaluate the quality of the code, prompts, recipes, or context files in this bundle. Score 0–4 on Code/Prompt Quality. Focus on: expertise visible in prompt design, code clarity, edge case handling, and whether this looks purpose-built or copy-pasted."*

---

## Dimension 5 — Trust Signals

*Does this bundle meet baseline standards for safety and transparency? Computed from public GitHub API data.*

| Score | Criteria |
|---|---|
| **4** | LICENSE file present **and** CI/CD workflow files present **and** structured tests or a CHANGELOG exist. |
| **3** | LICENSE present **and** CI/CD workflow present. No tests or CHANGELOG. |
| **2** | LICENSE present. No CI or tests, but README has clear structure (headings, sections). |
| **1** | LICENSE present. README is unstructured. No CI or tests. |
| **0** | No LICENSE file. Cannot be trusted for any production use. |

**Inputs from GitHub API:** presence of `LICENSE`, `.github/workflows/`, test file patterns (`test/`, `tests/`, `*.test.*`, `*.spec.*`), `CHANGELOG`.

---

## Scoring process

1. **GitHub API pass** — the nightly sweep fetches objective signals for Dimensions 3 and 5 directly from the GitHub API without authentication, ensuring only public data is used.

2. **LLM evaluation pass** — a separate scoring run fetches the public README and bundle structure for Dimensions 1, 2, and 4. It constructs a structured prompt using this rubric and calls Claude to produce a JSON response with scores and reasoning per dimension.

3. **Score written to `bundles.json`** — each bundle gets a `quality` object with per-dimension scores, a total, the computed star rating, and the date scored.

4. **Rescoring cadence** — Dimensions 3 and 5 rescore nightly (they change as repos update). Dimensions 1, 2, and 4 rescore weekly, or when the bundle's README changes.

---

## Contesting a score

If you are the author of a listed bundle and believe a score is wrong, open an issue in this repo with the label `score-dispute`. Include:
- The bundle ID
- Which dimension(s) you dispute
- What evidence contradicts the score

Disputes will trigger a manual rescore with the same rubric. If the rubric itself is flawed, open a `rubric-feedback` issue — any change to the rubric triggers a full rescore of all bundles.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-03-29 | Initial rubric. Five dimensions, 0–4 each, sum → stars. |
