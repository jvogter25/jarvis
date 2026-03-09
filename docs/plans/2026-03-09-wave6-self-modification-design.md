# Wave 6: Jarvis Self-Modification + Tool Discovery Design

## Goal

Jarvis can modify its own codebase from Discord — adding new integrations, changing behavior, or installing tools Jake discovers on Twitter — with Opus writing and reviewing all code. Jake approves intent in plain English, never reviews diffs.

## Architecture

### Self-Modification Pipeline

**Trigger**: Jarvis detects a message requiring code changes and calls a new `self_modify_request` tool in `brain.ts`. This replaces the old `request_tool_install` flow for anything beyond pre-defined install plans.

**Code generation**: Opus writes all required files. A second Opus call reviews for correctness, safety, and whether any existing core files are touched.

**Smart gate — based on what files change:**

- **Safe change** (new files only, no edits to existing files): Jake approves in Discord → direct push to `main` → Railway redeploys
- **Core change** (any edit to an existing file like `brain.ts`, `handlers.ts`, `index.ts`, `builder.ts`, etc.): GitHub PR opened on branch `self-modify/<feature>` → Jake approves in Discord → Jarvis auto-merges → Railway redeploys

**Discord UX — Jake never sees code:**

Safe change example:
> "I'll create `src/tools/resend.ts` and add `resend` to package.json. Opus reviewed it — clean. Want me to ship it? (yes/no)"

Core change example:
> "This requires editing `handlers.ts` to add a new command. Opus reviewed it — clean. PR: https://github.com/jvogter25/jarvis/pull/12. Say **ship it** and I'll merge."

### MCP/Tool Discovery Loop

**Schedule**: Fridays at 9am (separate from Monday product pulse)

**Sources**: Brave Search queries targeting:
- `"new MCP server" site:twitter.com`
- `"Claude MCP" tool release`
- `"AI agent tool" npm 2026`
- `"Model Context Protocol" new integration`

**Evaluation per tool** (Opus, structured prompt):
- Is this useful for Jarvis's B2B SaaS mission?
- What would Jarvis concretely do with it?
- Security implications (what secrets needed, what access granted)
- Implementation type: npm package (write tool file) or MCP server config
- Install complexity: simple / moderate / complex

**Digest posted to `#engineering`**:
```
Weekly Tool Digest — March 14

1. Resend (email API)
   Why: send transactional emails from built products.
   Security: needs RESEND_API_KEY — send-only, no inbox access.
   Install: simple — 1 new file + 1 env var.
   → Say `install resend` in #jarvis to add it.

2. Exa (semantic search)
   Why: better research quality than Brave for competitor intel.
   Security: API key only, no data stored.
   Install: simple — augments current search tool.
   → Say `install exa` in #jarvis to add it.
```

### Ad-hoc URL Evaluation (Jake pastes a link)

When Jake pastes a URL into `#jarvis` with any hint of "what do you think" or just the URL alone, Jarvis:
1. Browses it with `browse_web`
2. Runs the same Opus evaluation (usefulness, security, complexity)
3. Responds conversationally: "This is an email API — I could use it to send transactional emails from built products. Clean install, just needs an API key. Want me to add it?"
4. Jake says yes → self-modify pipeline runs

No special command needed — handled naturally in conversation. System prompt updated to instruct proactive tool evaluation on URL pastes.

## Files Changed

| File | Change |
|------|--------|
| `src/tools/self-modify.ts` | Major rewrite: smart gate, Opus code gen, Claude review, PR creation |
| `src/brain.ts` | Add `self_modify_request` tool schema + executor case |
| `src/overnight/tool-discovery.ts` | New: Brave Search scraper + Opus evaluation + digest poster |
| `src/discord/handlers.ts` | Add `pendingPRApproval` state for core-change PR merges |
| `src/index.ts` | Add Friday 9am tool discovery cron |
| System prompt (Supabase) | Add URL evaluation behavior + tool discovery instinct |

**Not touched**: research loop, builder, memory, GitHub client (already has `createPR`)

## Key Constraints

- All code written and reviewed by Opus — never sonnet or haiku for self-modification
- Jake approves intent only, never code
- Core files (brain.ts, handlers.ts, index.ts, builder.ts, supabase.ts, trainer.ts) always require PR, never direct push
- Tool discovery digest goes to `#engineering`, not `#jarvis` — keeps main channel clean
- If Opus review finds issues, it fixes them in a loop (max 3 iterations) before presenting to Jake
- Railway auto-deploys on merge to main (existing behavior, no change needed)
