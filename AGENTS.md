# AGENTS.md

## Project Overview

This is a **research repository** for studying memory integration strategies between Mastra (mastra-ai/mastra) and OpenCode (anomalyco/opencode). The primary deliverables are:

- The research document in `research/opencode-mastra-memory.md`
- Planning documents in `plans/` that turn the research into implementation options and phased proposals

This is primarily a **research repository**. There is no conventional app build/test pipeline for this repo itself. The `repos/` directory is only for optional local reference clones used during research verification.

Exception:

- There is now a project-local OpenCode plugin prototype under `.opencode/plugins/observational-memory.ts`
- There is also a focused smoke script at `scripts/smoke-om-plugin.mjs`
- These exist only to validate the observational-memory plan and plugin behavior; they are not a general repo-wide build/test system

---

## No Build/Lint/Test Commands

This repository does not have a normal build/lint/test pipeline. There are no repo-wide:

- Build commands
- Lint commands  
- Test commands
- Package managers for the repository as a whole (npm, pnpm, yarn, cargo, etc.)

**Do not invent generic build, lint, or test commands** - they will not work.

Allowed exception for the local OM plugin prototype:

- `.opencode/package.json` may be used for local plugin dependency installation only
- `scripts/smoke-om-plugin.mjs` may be used as the primary smoke test
- If `bun` is available locally, the smoke script may also be used in `--opencode` mode to try a real OpenCode CLI run against `repos/opencode`

### How To Test Things

If you are working on the local observational-memory plugin prototype, use these checks:

1. Install local plugin dependencies if needed:
   - `cd .opencode && npm install`
2. Run the plugin smoke test:
   - `node --experimental-strip-types scripts/smoke-om-plugin.mjs`
3. If `bun` is installed and you want a fuller CLI smoke check:
   - `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode`
4. Inspect current observational-memory state directly when needed:
   - `node --experimental-strip-types scripts/om-status.mjs <session-id>`
5. If you want to copy or refresh the plugin in another repository, use:
   - `./setup-om-plugin.sh /path/to/target-repo`
   - `./update-om-plugin.sh /path/to/target-repo`
6. For manual verification, run OpenCode from the repo root and ask it to call:
   - `om_status`
   - `om_export`
   - `om_observe`
   - `om_reflect`
   - `om_forget`

Validation expectations:

- Prefer the smoke script over ad hoc commands
- Treat the Node smoke script as the minimum required check after plugin edits
- If `bun` is unavailable, note that the full OpenCode CLI smoke path could not be run
- Do not add unrelated test tooling to the repo just to validate this plugin

---

## Research and Plan Document Guidelines

### Purpose

The main research document (`research/opencode-mastra-memory.md`) analyzes:

1. How Mastra implements four memory types:
   - Message history
   - Working memory  
   - Semantic recall
   - Observational memory

2. How OpenCode currently handles persistence and context

3. Implementation strategy recommendations for adding memory features to OpenCode

Planning documents in `plans/` should:

- Derive directly from the research findings
- Make assumptions and recommendations explicit
- Clearly separate:
  - locked decisions
  - recommended defaults
  - open questions / ambiguities
  - phased follow-up work

### Working on Research Documents

When modifying the research document:

1. **Maintain technical accuracy** - Verify any code paths, function names, or file locations before citing them

2. **Use precise terminology** - Match Mastra/OpenCode terminology exactly (e.g., "observational memory" not "observation memory")

3. **Include code references** - Reference specific files and line numbers when discussing implementations:
   - OpenCode: `packages/opencode/src/...`
   - Mastra: `packages/core/src/...`, `packages/memory/src/...`

4. **Keep structure organized** - The research document uses clear sections:
   - Quick Recommendation
   - The Four Memory Types
   - Repo Pointers
   - Deep Dive sections
   - Implementation Strategy
   - Phased Roadmap
   - Open Questions

5. **Update SHA references** - When referencing specific commits, include the full SHA and branch name

6. **Be factual** - This is a technical analysis, not opinion. Distinguish between documented behavior and implementation assumptions.

### Working on Plan Documents

When modifying files in `plans/`:

1. **Keep them traceable to research** - cite the source research doc(s) they derive from

2. **Separate recommendation from alternatives** - if a plan includes multiple options, make the recommended default explicit

3. **Call out implementation status clearly** - distinguish:
   - current recommendation
   - future phases
   - not-yet-decided items

4. **Prefer operational detail over prose** - thresholds, state schemas, hooks, and failure behavior should be explicit when known

5. **Record tradeoffs** - especially when a plan intentionally differs from Mastra or OpenCode upstream behavior

---

## Directory Structure

```
opencode-memory-research/
├── research/
│   └── opencode-mastra-memory.md       # Primary research document
├── plans/
│   ├── phase-1-observational-memory.md    # Phase 1 spectrum / option framing
│   └── phase-1-observational-memory-v2.md # Recommended mini-B v2 plan
└── repos/
    ├── mastra/                          # optional local mastra reference clone
    └── opencode/                        # optional local opencode reference clone
```

---

## Adding New Research or Plans

If you add new documentation files:

1. Place research analyses in `research/`
2. Place implementation proposals or phased designs in `plans/`
3. Use Markdown format (`.md`)
4. Include date in frontmatter or header
5. Reference specific SHAs when discussing code
6. Keep a consistent heading hierarchy

If you supersede an older plan, say so explicitly near the top of the new file.

---

## Code Reference Format

When referencing code from external repositories:

- **OpenCode**: `packages/opencode/src/<path>` (e.g., `packages/opencode/src/session/session.sql.ts`)
- **Mastra Core**: `packages/core/src/<path>`  
- **Mastra Memory**: `packages/memory/src/<path>`

Example: "The message history processor is at `packages/core/src/processors/memory/message-history.ts`"

---

## Verification

When the research mentions specific code behavior:

1. Verify file paths exist in the referenced repositories
2. Check line numbers are accurate
3. Confirm API/function signatures match current code
4. Note any discrepancies between documentation and implementation

---

## Future Development

If this research leads to actual implementation:

1. Implementation would likely occur in a separate plugin repository
2. Or as a fork of anomalyco/opencode
3. Build/test commands would follow OpenCode's conventions (likely pnpm-based)

For OpenCode's actual build commands, refer to the OpenCode repository directly.

---

## Contact

This is a personal research repository. For questions about OpenCode, see https://github.com/anomalyco/opencode
