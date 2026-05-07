# Prompt Log — FlowMon Development

## 5 Best Prompts

---

### 1. Multi-bug diagnostic with context
**Prompt:**
> "Top Talkers (Source IPs) is setting all the value to 0 after refreshing. Bandwidth Over Time should also refresh. top application is showing category as "unclassified" get the categories for it. fix policy issue, it is not allowing to add policy. also make a complete Q/A of whole project as an ISP provider and network analyst and fix the issues"

**Why it worked:**
Bundled four concrete symptoms with a mandate to do a full Q/A sweep. This gave Claude enough context to trace each symptom to its root cause (field name mismatch, missing route registration, removed DB column referenced in WHERE, missing WS bandwidth data) rather than guessing. The "Q/A as an ISP analyst" framing also unlocked a systematic review that found additional bugs (unusual_port unimplemented, IPDR flows missing category, mappings import case inconsistency).

**Lesson:** Describe *what you observe*, not what you think the fix is. Multiple symptoms in one prompt is fine — Claude can triage them.

---

### 2. Data consistency debugging with before/after evidence
**Prompt:**
> "when i refresh the page, it shows below data for the first time [8,065 flows / 231 MB] then after 15 sec refresh, it changes the data [5,607 flows / 149 MB] — verify the data and fix the issue, it also changes the values in top application and top talkers"

**Why it worked:**
Provided concrete before/after numbers. This made it trivial to identify the cause (REST queries all-time, WS queries 1-hour window) and verify the fix by running the corrected queries directly against the DB. Without the numbers, this would have been hard to diagnose.

**Lesson:** Include actual data values when reporting inconsistencies. "The numbers change" is vague; "8,065 becomes 5,607" is immediately actionable.

---

### 3. Specification generation with implicit scope
**Prompt:**
> "create specs.md file"

**Why it worked:**
Short prompt, but issued after the full codebase had been explored across multiple sessions. Claude had read all routes, the C++ source, the Angular components, and the DB schema. The three-word prompt correctly implied "comprehensive technical spec of everything you know about this project." The output covered all 13 sections — wire protocol, DB schema, API reference, WS protocol — without needing to enumerate them.

**Lesson:** Terse prompts work when the context is rich. Don't over-specify what you want documented if Claude already knows the system.

---

### 4. Responsive layout fix with specific symptom
**Prompt:**
> "fix frontend responsiveness, protocol distribution graph is going out of page. also set the dashboard refresh interval time to 15 seconds"

**Why it worked:**
Named the exact broken element ("protocol distribution graph") and the exact failure mode ("going out of page"). This pointed directly to the doughnut chart's `legend: right` stealing horizontal space and the missing explicit canvas height. The second request (interval) was simple and concrete.

**Lesson:** Name the exact UI element and failure mode, not "the charts look weird." Pairing a layout bug with a config change in one prompt is efficient.

---

### 5. Root-cause verification prompt
**Prompt:**
> "Bandwidth Over Time is still refreshing after 3 seconds"

**Why it worked:**
Followed up immediately after the previous fix landed. Short, specific, and stated the *observed behaviour* rather than a theory about the cause. This forced a re-read of the actual code path — revealing that `applyUpdate()` was still updating `bwChartData` on every WS tick regardless of the interval, and that bandwidth needed its own independent `setInterval`.

**Lesson:** A short follow-up that names the remaining symptom is more useful than a long re-explanation of what was already fixed.

---

## 3 Worst Prompts

---

### 1. Missing output format specification
**Prompt (hypothetical version):**
> "document the project"

**Why it failed:**
No scope, no format, no audience. Would produce either a one-liner README or a 10,000-word dump depending on Claude's interpretation. The actual prompt used was better because it specified the file name (`specs.md`) which implies a structured, comprehensive reference document.

**Lesson:** Always specify: file name, target audience (developer? operator?), and approximate depth (one-page spec vs. full reference).

---

### 2. Implicitly conflicting requirements
**Prompt (the actual one that caused the build error):**
> "set the dashboard refresh interval time to 15 seconds"

**Why it caused a problem:**
The prompt was correct in intent but didn't specify *where* the constant should live. Claude inserted `const BW_REFRESH_MS = 15_000` between `})` and `export class`, breaking the decorator-class binding. The prompt didn't say "keep the code structure valid" because that's assumed — but the edit operation didn't verify placement.

**Lesson:** When asking for a new constant or configuration value, specify "add it at the module level" or "as a class property" to avoid ambiguous insertion points.

---

### 3. Compound action without priority signal
**Prompt:**
> "Required .md Files (Must commit to your repo) — [list of CLAUDE.md, SPEC.md, prompt log, skills]"

**Why it's weak:**
Copied requirements text verbatim without telling Claude what already exists, what the deadline priority is, or what format/depth each file needs. Required Claude to infer all of that. A better version would be: "CLAUDE.md already exists. Create SPEC.md (one-page), prompt-log.md (5 best + 3 worst prompts from this session), and personal skill files at ~/.claude/skills/ covering [topics]."

**Lesson:** Pasting requirement docs verbatim leaves too much interpretation to Claude. Extract the actionable items and specify what already exists.

---

## Patterns Observed

| Pattern | Effect |
|---------|--------|
| Concrete before/after data | Fastest path to root cause |
| Symptom description over theory | Claude finds real cause, not assumed cause |
| Short follow-up after partial fix | Catches regressions without re-explaining context |
| Terse prompt after rich context | Works well; over-specification wastes tokens |
| Pasted requirements verbatim | Forces Claude to re-parse intent; slower and less accurate |
