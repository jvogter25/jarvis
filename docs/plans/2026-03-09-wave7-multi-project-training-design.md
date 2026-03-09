# Wave 7: Multi-Project Workspace + Training System Design

## Goal

Jarvis operates multiple projects simultaneously in isolated Discord folders, learns continuously from material Jake feeds it, and previews builds in E2B sandbox before consuming Vercel deployment slots.

## Architecture

### Training System

**Single `#training` channel** in Jarvis HQ (global). Jake drops URLs or text with an explicit domain tag (e.g. "sales: [URL]", "marketing: [article]"). Jarvis reads the content, extracts key insights, stores in a new `knowledge_base` Supabase table.

**Three-layer learning:**
- **Immediate:** insights stored on post
- **Nightly:** overnight trainer folds new `knowledge_base` entries into global system prompt
- **On-demand:** new `search_knowledge` tool queries knowledge base when Jarvis is doing domain-relevant work (writing copy → searches marketing/sales, making design decisions → searches design)

**Knowledge sync to projects:** weekly Monday auto-sync propagates global prompt improvements to all active project prompts. Manual trigger: Jake says "sync knowledge" in any project channel.

### Project Workspace

**Discord Category per project** with 7 channels:
```
📁 PROJECT NAME
├── #general         → main chat with Jarvis about this project
├── #research        → competitor tracking, market validation
├── #engineering     → build updates, PRs, deploys
├── #marketing       → copy, campaigns, launch plans
├── #design          → design decisions, component notes
├── #morning-brief   → daily project status
└── #overnight-log   → what Jarvis worked on overnight
```

**Per-project system prompt** — forked from current global prompt at creation time, stored in `project_configs` Supabase table with project slug + all channel IDs mapped.

**Project-aware message routing** — `handlers.ts` checks incoming channel ID against known project channels. If match → load project system prompt + project history. If no match → global system prompt (current behavior).

### Project Creation Flow

**Two triggers:**
1. Jake says "create project: [name]" in global `#jarvis`
2. Jake approves a research opportunity ("build this")

**Sequence:**
1. Jarvis confirms: name, description, build type (if unclear)
2. Creates Discord Category + 7 channels via Discord API
3. Creates GitHub repo (empty, no Vercel yet)
4. Saves `project_configs` record with channel ID map + project system prompt (forked from global)
5. Posts welcome to project `#general`

### Build Pipeline (changed)

**Phase 1 — E2B Preview:**
1. Generate Next.js files
2. Spin up E2B sandbox: `npm install && npx next dev --port 3000`
3. Expose port → public URL (lives ~1hr)
4. Post to project `#engineering`: "Preview live: [url] — say **ship it** to deploy, or tell me what to change"

**Phase 2 — Vercel Deploy (only after approval):**
1. Create Vercel project
2. Fork `jarvis-template`, push generated files to staging branch
3. Production deploy on "ship it"

**Vercel slots preserved** — no slot consumed until Jake approves E2B preview.

### Per-Project Autonomous Loops

Single Railway process iterates over all active projects:

| Loop | Schedule | Posts to |
|---|---|---|
| Morning brief | 7am daily | Project `#morning-brief` |
| Overnight log | 2am daily | Project `#overnight-log` |
| Research (project-scoped) | Every 6hrs | Project `#research` |
| Product pulse | Mondays 8am | Project `#engineering` |

Global loops (market research, tool discovery) continue unchanged.

## Files Changed

| File | Change |
|---|---|
| `src/memory/supabase.ts` | Add `knowledge_base` table helpers + `project_configs` table helpers |
| `src/memory/schema.sql` | New tables: `knowledge_base`, `project_configs` |
| `src/discord/handlers.ts` | Add `#training` channel handler + project-aware routing |
| `src/discord/client.ts` | Route `#training` channel + all project channels |
| `src/tools/knowledge.ts` | New: save/search knowledge base |
| `src/tools/project-setup.ts` | New: create Discord category + channels + GitHub repo + project_configs record |
| `src/brain.ts` | Add `search_knowledge` + `create_project` tool schemas + executors |
| `src/tools/registry.ts` | Register new tools |
| `src/overnight/trainer.ts` | Fold knowledge_base insights into nightly prompt rewrite |
| `src/overnight/briefing.ts` | Iterate over active projects, post to project #morning-brief |
| `src/overnight/product-pulse.ts` | Post to project #engineering instead of global |
| `src/research/loop.ts` | Add per-project research loop (competitor/market scoped) |
| `src/tools/builder.ts` | Split build into Phase 1 (E2B preview) + Phase 2 (Vercel, post-approval) |
| `src/index.ts` | Per-project research cron |

## Key Constraints

- Discord API: bot needs `MANAGE_CHANNELS` + `MANAGE_GUILD` permissions to create categories/channels
- E2B Next.js preview: sandbox runs `next dev`, exposes port 3000 via E2B's `getHost()` API — URL lives ~1hr
- Vercel free tier: never call `createVercelProject()` until E2B preview approved
- Project system prompts stored in `project_configs.system_prompt` — separate from `system_prompts` table (which is global only)
- Knowledge sync: `project_configs.last_synced_at` tracks when project last got global prompt update
- All project channel IDs stored in `project_configs.channels` as JSON: `{ general, research, engineering, marketing, design, morning_brief, overnight_log }`
