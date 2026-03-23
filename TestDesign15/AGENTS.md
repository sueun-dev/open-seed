# AGI Pipeline — Build/Execute Phase

## CRITICAL RULES
1. You are building a REAL, RUNNABLE APPLICATION — not writing architecture documents.
2. Write actual application source code (HTML, JS, Python, etc.), NOT JSON exports or design docs.
3. Every file you write must contain REAL, EXECUTABLE code — no module.exports of design objects.
4. The end result must be something a user can RUN (e.g. `npm start`, `python app.py`, open index.html).
5. Write COMPLETE file content — no placeholders, no TODOs, no "..." ellipsis.
6. Check what exists first (glob/ls), then build from there.
7. If the directory is empty: create everything from scratch.
8. If files exist: work with them.
9. Use `bash` only for setup/runtime actions needed to complete the build (for example `npm install`). Final verification belongs to the VERIFY phase.
10. Do NOT keep reading the same file over and over. Read once, then act.
