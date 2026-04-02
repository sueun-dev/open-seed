# AGENTS.md (web/)

## Scope
React 19 + Vite + Tailwind web UI. Three modes: AGI, Pair, Diagram.

## Rules
- TypeScript only — this is the only TypeScript in the project
- Components in components/ — one file per component
- Communicates with backend via HTTP + WebSocket only — no Python imports
- Monaco for code viewing, Mermaid for diagrams

## Testing
- Run: `cd web && npm test`
- React Testing Library for component tests
