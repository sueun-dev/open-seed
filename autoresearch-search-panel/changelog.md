# Autoresearch Changelog: Search Panel VS Code Fidelity

## Eval Criteria (Binary)

1. **Search input with inline toggle buttons** — Does the search input have Aa (case sensitive), Ab (whole word), .* (regex) toggle buttons inside it?
2. **Replace row with chevron toggle** — Is there a collapsible replace input row toggled by a chevron?
3. **Files to include/exclude** — Is there a collapsible "files to include" and "files to exclude" section with toggle?
4. **Results as collapsible file tree** — Are search results grouped by file in a collapsible tree (not a flat list)?
5. **No standalone Search button** — Search triggers on Enter/typing, no big "Search" button?
6. **VS Code styling** — Proper VS Code dark theme spacing, input heights (~24px), compact layout?

---

## Experiment 0 — baseline

**Score:** 0/6 (0%)
**Description:** Original search panel with basic input, standalone "Search" button, and single glob filter input.
**Failing evals:** All 6 evals failed. No VS Code features present.

---

## Experiment 1 — keep

**Score:** 6/6 (100%)
**Change:** Complete rewrite of search panel HTML, CSS, and JS to match VS Code's native search UI.
**Reasoning:** Baseline was 0% — needed a comprehensive change since no VS Code features existed.
**Result:** All 6 structural evals pass. All 20 deep evals pass. All 30 live integration tests pass.

Changes made:
- Replaced `<h2>Search in Project</h2>` with compact header layout
- Added inline toggle buttons: Aa (case), Ab (whole word), .* (regex) inside search input
- Added collapsible replace row with chevron toggle (▶/▼)
- Added collapsible "files to include" / "files to exclude" section
- Search results now grouped by file in collapsible tree with match count badges
- Removed standalone "Search" button — search triggers on debounced typing + Enter
- Input height 26px, border-radius 3px, 22x22 toggle buttons (VS Code standard)
- grep flags properly connected: -i (case), -w (word), -E (regex), --include, --exclude
- Match highlighting with yellow background in results

**Remaining failures:** None on structural/functional evals. Visual pixel-perfection requires browser testing.

