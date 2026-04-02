# AGENTS.md (packages/guard/)

## Scope
Sentinel verification — retry loop until zero errors, intent classification, evidence checking.

## Rules
- Retry chain: retry → different approach → Insight → user escalate
- Use compute_backoff_ms() for delays — no custom backoff logic
- Evidence-based verification: reads actual files, runs actual tests
- Stagnation detection prevents infinite loops — escalate when no progress
- Security assessment (assess_risk()) before untrusted operations

## Testing
- Run: `pytest packages/guard/tests/`
- Test retry escalation chain and stagnation detection
