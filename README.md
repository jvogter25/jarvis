# Jarvis — AI Co-CEO

An always-on AI orchestrator that runs on Railway, accessible via Discord. Give it a direction and it coordinates execution — research, code, email, product — while you're away from your computer.

## What It Does

- **Talks to you via Discord** — respond from your phone anywhere
- **Builds and ships code** — pushes to GitHub, Railway redeploys automatically
- **Self-modifies on command** — say "implement a version command" and it writes the code, pushes a branch, opens a PR, and waits for your `ship it`
- **Approval loop** — coding progress logs go to #engineering; approval prompts go to #jarvis; one `ship it` executes the PR
- **Monitors your inbox** — scores emails, drafts replies in your voice for approval
- **Researches opportunities** — scrapes Reddit, HN, Indie Hackers for validated product ideas
- **Runs overnight** — rewrites its own system prompt nightly based on what worked and what didn't
- **Knowledge base** — feed it domain material in #training and it extracts + stores insights for future reasoning
- **Multi-project workspace** — each project gets its own Discord category, GitHub repo, system prompt, and morning brief

## Architecture

```
Railway (always-on Node.js process)
├── Discord bot          — primary interface
├── Brain (Claude API)   — reasoning + tool execution
├── Memory (Supabase)    — persistent across restarts
├── Tools                — Gmail, GitHub, browser, shell, search, Slack, self-modify
└── Cron jobs            — morning brief (7am), inbox monitor (every 30min), overnight trainer (2am)

GitHub (jvogter25/jarvis)
└── Auto-deploys to Railway on push to main
```

## Discord Channels

| Channel | Purpose |
|---|---|
| `#jarvis` | Talk to Jarvis directly — approval prompts always come here |
| `#morning-brief` | Daily overnight summary posted at 7am |
| `#research` | Validated product opportunities |
| `#engineering` | Build progress logs, PRs, staging URLs |
| `#marketing` | Copy and launch plans |
| `#overnight-log` | What Jarvis worked on overnight |
| `#training` | Feed domain knowledge: `sales: [url or text]`, `marketing: [text]`, etc. |
| `#design-elements` | Drop screenshots or URLs to update the design library |

## Setup (for new instances)

### 1. Accounts you need

- [Railway](https://railway.app) — for hosting ($5/mo Hobby plan required)
- [Discord](https://discord.com/developers) — create a bot application
- [Supabase](https://supabase.com) — free tier is fine
- [Anthropic](https://console.anthropic.com) — API key
- [GitHub](https://github.com) — personal access token (repo + contents permissions)
- [Google Cloud](https://console.cloud.google.com) — for Gmail integration (optional)

### 2. Discord server setup

Create a server with these channels: `jarvis`, `morning-brief`, `research`, `engineering`, `marketing`, `overnight-log`

Invite your bot with these permissions: Read Messages, Send Messages, Read Message History, Add Reactions

### 3. Supabase tables

Run these in the Supabase SQL editor:

```sql
create table memory (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  content text not null,
  created_at timestamptz default now()
);

create table system_prompt (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  version int not null default 1,
  created_at timestamptz default now()
);

create table knowledge_base (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  content text not null,
  created_at timestamptz default now()
);
```

### 4. Environment variables

Set these in Railway:

```
DISCORD_TOKEN=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_JARVIS=
DISCORD_CHANNEL_MORNING_BRIEF=
DISCORD_CHANNEL_RESEARCH=
DISCORD_CHANNEL_ENGINEERING=
DISCORD_CHANNEL_MARKETING=
DISCORD_CHANNEL_OVERNIGHT_LOG=

ANTHROPIC_API_KEY=

SUPABASE_URL=
SUPABASE_ANON_KEY=

GITHUB_TOKEN=
GITHUB_OWNER=

# Optional — Gmail integration
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=

# Optional — E2B code sandbox
E2B_API_KEY=
```

### 5. Gmail OAuth setup (optional)

1. Create a Google Cloud project, enable Gmail API and Google Calendar API
2. Create OAuth 2.0 credentials (Desktop app type)
3. Add your Gmail address as a test user in the OAuth consent screen
4. Run `node scripts/gmail-auth.mjs` locally and follow the browser flow
5. Copy the printed `GMAIL_REFRESH_TOKEN` into Railway env vars

### 6. Deploy

```bash
git clone https://github.com/YOUR_USERNAME/jarvis
cd jarvis
# Set env vars in Railway, connect repo, deploy
```

Railway detects Node.js automatically. Build runs `npm ci`, start runs `tsx src/index.ts`.

## Local Development

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # tsx watch mode, hot reload
```

## Self-Modification

Jarvis can write and deploy new tools himself. In Discord:

> "implement a version command"
> "add a ping command"
> "build a search feature"
> "create a webhook handler"

He'll plan the task, clone the repo into a sandbox, run Claude Code to write the implementation, push a branch, and ask for approval in #jarvis. Say `ship it` and he opens a PR on GitHub. Safe new-file additions push directly to main; edits to core files go through a PR first.

**Channel routing:**
- Progress logs (cloning, planning, done) → `#engineering`
- Approval prompt ("Say **ship it** when ready") → `#jarvis`
- `ship it` in #jarvis → PR opened + Slack notification

**Core files** (brain.ts, handlers.ts, index.ts, builder.ts, supabase.ts, trainer.ts, registry.ts, channels.ts) always go through a PR — never direct-pushed.

## Project Structure

```
src/
├── index.ts              — entry point, cron schedule
├── brain.ts              — Claude API loop, tool schemas and executors
├── discord/
│   ├── handlers.ts       — message routing, approval flows
│   └── channels.ts       — channel ID helpers
├── tools/
│   ├── self-modify.ts    — code generation + GitHub push pipeline
│   ├── gmail.ts          — Gmail + Calendar API wrapper
│   ├── search.ts         — web search
│   ├── browser.ts        — Playwright scraping
│   ├── shell.ts          — sandboxed shell via E2B
│   ├── slack.ts          — Slack integration
│   ├── builder.ts        — project scaffolding
│   ├── knowledge.ts      — Supabase knowledge base queries
│   └── registry.ts       — tool definitions list
├── overnight/
│   ├── trainer.ts        — nightly system prompt rewriter
│   ├── briefing.ts       — morning brief generator
│   ├── inbox-monitor.ts  — email scoring + reply drafting
│   ├── product-pulse.ts  — opportunity research loop
│   └── tool-discovery.ts — identifies capability gaps
├── memory/
│   └── supabase.ts       — conversation memory
├── github/
│   └── client.ts         — GitHub API helpers
└── agents/
    ├── manifest.ts        — loads 61-agent roster
    └── agents.json        — agent definitions
```

## Waves Completed

| Wave | Features |
|---|---|
| 1–3 | Discord bot, Claude brain, Supabase memory, 61-agent manifest |
| 4 | Research loop (Reddit, HN, Brave Search, Product Hunt, IndieHackers, G2) |
| 5 | GitHub integration, self-modify pipeline (Opus writes + reviews all code) |
| 6 | Overnight trainer (nightly system prompt rewrite), morning brief, weekly tool discovery |
| 7 | Knowledge base + #training channel, multi-project workspaces, E2B preview-before-deploy |
| 8 | Gmail + Calendar integration, inbox monitor, email draft approval flow |
| 9 | Self-modify approval loop fixed — natural coding requests ("implement X command", "add Y feature") correctly route through Claude Code → branch → PR → `ship it` approval; channel routing cleaned up (#engineering = logs, #jarvis = approvals) |
