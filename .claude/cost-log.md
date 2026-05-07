# Cost Log — FlowMon Development

## Summary

| Session | Date | Task | Tokens (approx) | Cost (approx) |
|---------|------|------|-----------------|---------------|
| 1 | 2026-05-07 | Bug fixes + full Q/A (Top Talkers, Bandwidth, Categories, Policy) | ~180 000 | ~$0.54 |
| 2 | 2026-05-07 | specs.md creation (13-section full technical spec) | ~40 000 | ~$0.12 |
| 3 | 2026-05-07 | Frontend responsiveness + 15 s refresh interval | ~35 000 | ~$0.11 |
| 4 | 2026-05-07 | TS1206 decorator build error fix | ~12 000 | ~$0.04 |
| 5 | 2026-05-07 | Bandwidth chart decoupling (own setInterval) | ~18 000 | ~$0.05 |
| 6 | 2026-05-07 | Data consistency fix (WS/REST scope mismatch) | ~55 000 | ~$0.17 |
| 7 | 2026-05-07 | Required .md files (SPEC, prompt-log, skills) | ~30 000 | ~$0.09 |
| 8 | 2026-05-07 | Cost log, standup, demo script, scorecard, reflection | ~20 000 | ~$0.06 |
| **Total** | | | **~390 000** | **~$1.18** |

> Token estimates based on claude-sonnet-4-6 pricing ($3/$15 per M input/output).
> Actual billed usage visible in Anthropic Console → Usage.

---

## Cost Observations

| Observation | Impact |
|-------------|--------|
| Bundling multiple bugs in one prompt (Session 1) reduced round-trips | Saved ~2–3 sessions worth of overhead |
| Providing concrete before/after numbers (Session 6) resolved root cause in one pass | Avoided 2–3 follow-up clarification turns |
| `create specs.md` after rich context needed no re-exploration | Minimal input tokens; full output |
| Short follow-up prompts after partial fixes are cheapest path to correctness | Each follow-up < 20 k tokens |

---

## Running Total

**Estimated total spend to date: ~$1.18**

Update this table after each significant work session. Token counts can be read from the Anthropic Console or estimated from file-diff sizes (~750 tokens per KB of code changed).
