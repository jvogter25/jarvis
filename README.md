# Jarvis — AI Co-CEO

An always-on AI orchestrator that runs on Railway, accessible via Discord. Give it a direction and it coordinates execution — research, code, email, product — while you're away from your computer.

## What It Does

- **Talks to you via Discord** — respond from your phone anywhere
- **Builds and ships code** — pushes to GitHub, Railway redeploys automatically
- **Self-improves** — ask it to add new tools or capabilities and it writes, reviews, and deploys the code itself
- **Monitors your inbox** — scores emails, drafts replies in your voice for approval
- **Researches opportunities** — scrapes Reddit, HN, Indie Hackers for validated product ideas
- **Runs overnight** — rewrites its own system prompt nightly based on what worked and what didn't

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
| `#jarvis` | Talk to Jarvis directly |
| `#morning-brief` | Daily overnight summary posted at 7am |
| `#research` | Validated product opportunities |
| `#engineering` | Build updates and PRs |
| `#marketing` | Copy and launch plans |
| `#overnight-log` | What Jarvis worked on overnight |

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

> "Build me a tool that posts a weather summary to #morning-brief every day"

He'll generate the code, have Opus review it, show you a diff, and ask for approval. Safe changes push directly to main. Changes to core files (brain.ts, handlers.ts, etc.) go through a PR first.

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
| 1-3 | Discord bot, Claude brain, Supabase memory, 61-agent manifest |
| 4 | Research loop (Reddit, HN, Indie Hackers) |
| 5 | GitHub integration, self-modify pipeline |
| 6 | Overnight trainer, morning brief, tool discovery |
| 7 | Knowledge base, training channel ingestion |
| 8 | Gmail + Calendar integration, inbox monitor |
