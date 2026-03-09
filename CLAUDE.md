# Jarvis — AI Co-CEO System

## What This Is
Jarvis is an always-on AI orchestrator that runs on a Railway VPS, accessible via Discord from anywhere. He sits on top of 61 specialized AI agents (from the agency-agents repo) and a market research loop. The user interfaces with Jarvis like a co-CEO — give him a direction, he coordinates the team and executes.

## Why We're Building This
- Owner (Jake) has a full-time job and wants to run side hustles without being at his computer
- Current side hustle: South Bay Digital (GHL AI receptionist service for contractors) at `/Users/JakeLaylo/client-onboarding-gen`
- Goal: Jarvis + agents find validated product opportunities, build them, ship them — Jake reviews and approves from his phone via Discord
- Key distinction from tools like OpenClaw/ClawdBots: Jarvis runs on a server, NOT on Jake's local machine. He has access only to what he's been given keys to (GitHub, Vercel, Discord, Claude API, Supabase). No local device access.

## Full System Architecture

```
Railway VPS (~$5-10/mo)
├── Jarvis Discord bot (always on, Node.js/TypeScript)
│   ├── Memory: Supabase (persistent across restarts)
│   ├── Brain: Claude API (claude-sonnet-4-6)
│   ├── Agent routing: 61-agent manifest
│   └── Overnight loop: rewrites own system prompt nightly (gets smarter)
├── Research Loop (cron, every 6hrs)
│   ├── Scrapes Reddit API, HN Algolia, Playwright on IH/PH
│   ├── Scores opportunities: pain clarity + "would pay" signals + no dominant <$100/mo solution
│   └── Posts validated ideas to #research Discord channel
└── GitHub integration: Jarvis can push code and create PRs

Vercel (existing, unchanged)
└── South Bay Digital marketing site + onboarding tool + report tool
    New products also deploy here via GitHub → Vercel auto-deploy

Discord Server: "Jarvis HQ"
├── #jarvis          → Jake talks to Jarvis directly
├── #morning-brief   → Jarvis posts overnight summary every morning
├── #research        → research agent posts validated opportunities
├── #engineering     → engineering agent build updates + PRs
├── #marketing       → marketing agent copy/launch plans
└── #overnight-log   → what Jarvis worked on overnight
```

## Tech Stack
- **Runtime:** Node.js + TypeScript
- **Discord:** discord.js v14
- **AI:** @anthropic-ai/sdk (claude-sonnet-4-6)
- **Memory:** Supabase (PostgreSQL, free tier)
- **Deploy:** Railway
- **GitHub integration:** Octokit
- **Cron:** node-cron
- **Code sandbox:** E2B (future, for running generated code before shipping)

## Agent Team (agency-agents repo)
61 pre-built agent personalities covering:
- Engineering: frontend, backend, mobile, AI, DevOps, prototyping, senior dev
- Design: UI/UX, research, architecture, branding, visual, image gen
- Marketing: growth, content, Twitter, TikTok, Instagram, Reddit, app store
- Product: sprint prioritization, trend research, feedback synthesis
- QA: performance, API testing, quality verification
- Support: customer service, analytics, finance, legal
- Specialized: multi-agent orchestration, data analytics, sales

Install: `git clone https://github.com/msitarzewski/agency-agents`
Jarvis reads all 61 as a manifest and routes to them based on task type.

## Overnight Training Loop
Every night at 2am:
1. Jarvis reviews the day's conversations and agent outputs
2. Claude analyzes: what was routed correctly, what produced bad outputs, what confused Jarvis
3. Rewrites Jarvis's own system prompt to be better
4. Saves new version to Supabase
5. Posts summary to #overnight-log
6. Morning briefing posted to #morning-brief by 7am

This is the autoresearch pattern (karpathy/autoresearch) applied to prompt optimization instead of neural net weight training.

## Build Order
1. [ ] Jarvis bot skeleton — Discord connection, Claude API, basic Supabase memory
2. [ ] Agent manifest — all 61 agents loaded, Jarvis routes to them
3. [ ] Research loop — cron job, Reddit/HN/IH scraper, posts to #research
4. [ ] GitHub integration — Jarvis pushes code, creates PRs
5. [ ] Overnight training loop — after enough conversation data exists

## Prerequisites Needed from Jake
- [ ] Railway account (railway.app)
- [ ] Discord server "Jarvis HQ" created + bot application created at discord.com/developers
- [ ] Supabase project created (supabase.com)
- [ ] Anthropic API key (can reuse existing or create new at console.anthropic.com)
- [ ] GitHub personal access token for jvogter25 (repo + contents permissions)

## Environment Variables
See `.env.example` for all required keys.

## South Bay Digital (Separate Project)
Located at: `/Users/JakeLaylo/client-onboarding-gen`
Deployed at: Vercel (marketing site + onboarding tool)
Status: Core tool working (Claude API generates GHL assets). Needs: UI polish, more trade types, fix CTA URLs, connect marketing site + tool as one deploy.
GHL integration: intentionally deferred until 14-day free trial window.

## Jake's Stack & Constraints
- MacBook Pro M1 2021
- Languages: comfortable with Next.js/TypeScript (from South Bay Digital work)
- Hours: limited (full-time job), wants Jarvis to operate autonomously
- Revenue target: beat stablecoin yields (5-15% APY) as baseline, build toward $3-5k/mo side income
- Hosting preference: Vercel for web apps, Railway for persistent processes
