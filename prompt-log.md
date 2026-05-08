# Prompt Log — najam-ul-saqib — FlowMon

## Top 5 Prompts That Worked

---

### 1. Multi-symptom Q/A sweep — root-cause batch analysis

**Context:** Four separate UI bugs were visible: Top Talkers showing 0 after refresh, Bandwidth chart not refreshing, application categories showing "unclassified", and the Policy page failing to save. Rather than fix one at a time, I bundled all symptoms into one pass.

**Prompt:**
> "Top Talkers (Source IPs) is setting all the value to 0 after refreshing. Bandwidth Over Time should also refresh. top application is showing category as 'unclassified' get the categories for it. fix policy issue, it is not allowing to add policy. also make a complete Q/A of whole project as an ISP provider and network analyst and fix the issues"

**Why it worked:** Bundling four concrete symptoms with a mandate to do a full Q/A sweep gave Claude enough context to trace each symptom to its root cause (field name mismatch in top-talkers response, missing WS bandwidth data, removed DB column referenced in query, missing route registration for policy). The "Q/A as ISP analyst" framing produced a systematic review that found three additional bugs Claude wouldn't have found from the explicit list alone.

**Output quality:** 5/5
**Model used:** Sonnet
**Approx tokens / cost:** ~180,000 input+output / ~$0.54

---

### 2. Data consistency fix — before/after numbers as evidence

**Context:** Dashboard KPIs changed after 15 s, which turned out to be a REST vs. WebSocket time-window mismatch. Previous vague symptom descriptions hadn't narrowed the cause.

**Prompt:**
> "when i refresh the page, it shows below data for the first time [8,065 flows / 231 MB] then after 15 sec refresh, it changes the data [5,607 flows / 149 MB] — verify the data and fix the issue, it also changes the values in top application and top talkers"

**Why it worked:** Concrete before/after numbers made the root cause mechanically identifiable — REST queries were all-time, WS queries were 1-hour window. Claude ran the corrected `COUNT(*)` query directly against the DB to confirm the fix, which no amount of code review would have surfaced without the numbers.

**Output quality:** 5/5
**Model used:** Sonnet
**Approx tokens / cost:** ~55,000 / ~$0.17

---

### 3. Sub-agent codebase tour → specs.md

**Context:** After multiple sessions, Claude had full codebase context across C++, Node.js, Angular, and DB schema. I needed a comprehensive technical spec without re-explaining what was already known.

**Prompt:**
> "create specs.md file"

**Why it worked:** Three-word prompt worked because the context was rich — Claude had already read all routes, the C++ source, Angular components, and the full DB schema. Used the sub-agent pattern internally: Claude explored each layer independently and synthesized the 13-section output in one pass. The output covered wire protocol, DB schema, API reference, WS protocol, and C++ internals without enumeration in the prompt.

**Output quality:** 5/5
**Model used:** Sonnet
**Approx tokens / cost:** ~40,000 / ~$0.12

---

### 4. Precise UI layout fix — named element + exact failure mode

**Context:** Protocol distribution chart was overflowing its container on desktop. Needed a targeted fix without touching unrelated charts.

**Prompt:**
> "fix frontend responsiveness, protocol distribution graph is going out of page. also set the dashboard refresh interval time to 15 seconds"

**Why it worked:** Named the exact broken element ("protocol distribution graph") and exact failure mode ("going out of page"). This pointed directly to the doughnut chart's `legend: right` stealing horizontal space and the missing explicit canvas parent height. The second task (interval) paired cleanly because both were in the same component.

**Output quality:** 4/5
**Model used:** Sonnet
**Approx tokens / cost:** ~35,000 / ~$0.11

---

### 5. Short regression follow-up — observed symptom only

**Context:** After the dashboard refresh fix, the Bandwidth Over Time chart was still updating on every WS tick instead of on its own 15 s timer.

**Prompt:**
> "Bandwidth Over Time is still refreshing after 3 seconds"

**Why it worked:** Short, specific, stated the *observed behavior* rather than a theory about the cause. Forced a re-read of the actual code path — revealing that `applyUpdate()` was still updating `bwChartData` on every WS tick, and that bandwidth needed its own independent `setInterval`. If I had said "fix the timer logic," Claude might have searched for the wrong thing.

**Output quality:** 5/5
**Model used:** Sonnet
**Approx tokens / cost:** ~18,000 / ~$0.05

---

## Bottom 3 Prompts That Wasted Time

---

### 1. Missing output format specification

**What I asked:**
> "document the project"

**What went wrong:** No scope, no format, no audience. Would produce either a one-liner README or a 10,000-word dump depending on Claude's interpretation. The actual working version added a filename (`specs.md`) which implies comprehensive structured reference.

**What I should have done:** Specify file name, target audience (developer? operator?), and approximate depth ("13-section full reference matching SPEC.md").

---

### 2. Ambiguous insertion point for constant

**What I asked:**
> "set the dashboard refresh interval time to 15 seconds"

**What went wrong:** No guidance on where the constant should live. Claude inserted `const BW_REFRESH_MS = 15_000` between `})` and `export class`, breaking the decorator-class binding (TS1206). This is documented in `.claude/skills/angular-dashboard.md` as a known placement bug — should have referenced it.

**What I should have done:** "Add `const BW_REFRESH_MS = 15_000` at module level, above the `@Component` decorator in dashboard.component.ts."

---

### 3. Pasting requirements verbatim

**What I asked:**
> "Required .md Files (Must commit to your repo) — [copy-paste of hackathon requirements doc]"

**What went wrong:** Pasting requirement text verbatim left all interpretation to Claude — which files already exist, what format/depth each needs, what counts as sufficient. Required multiple follow-up rounds to converge.

**What I should have done:** "CLAUDE.md already exists (committed). Create: SPEC.md (one-page, same format as Workshop Pack §2), prompt-log.md (5 best + 3 worst in the Workshop Pack §4 format), skill files at .claude/skills/ for ISP traffic analysis, Node.js API patterns, and Angular dashboard patterns."

---

## Workflow Patterns I'll Keep

| Pattern | Effect |
|---------|--------|
| Concrete before/after data | Fastest path to root cause — cuts 2-3 clarification turns |
| Symptom description over fix theory | Claude finds real cause, not assumed cause |
| Short follow-up naming remaining symptom | Catches regressions without re-explaining context |
| Terse prompt after rich codebase context | Works well; saves input tokens |
| Plan mode before >3-file changes | Catches wrong direction in 2 min vs 20 min |

## Workflow Patterns I'll Stop

| Anti-pattern | Replacement |
|-------------|-------------|
| Pasting requirements docs verbatim | Extract actionable items, note what already exists |
| "Make X better" without a target | Specify exact metric: "2x faster", "remove N+1", "match Figma frame" |
| Letting Sonnet run without `/compact` between unrelated tasks | `/compact` at natural breakpoints; `/clear` between unrelated tasks |
