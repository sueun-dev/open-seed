# AGENTS.md (packages/deploy/)

## Scope
Multi-channel deployment — git, npm, docker, webhooks, PR creation, cron.

## Rules
- All channels extend DeployChannel abstract base
- New channels: create in channels/, register in factory
- Async deployment — never block on channel execution

## Testing
- Run: `pytest packages/deploy/tests/`
- Mock all external operations (git push, npm publish, docker build)
