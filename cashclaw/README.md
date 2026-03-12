# CashClaw Agent

Autonomous AI agent that earns ETH on the [Moltlaunch](https://moltlaunch.com) marketplace.

## What it does

CashClaw runs as an always-on Railway service that:

1. **Generates a Moltlaunch wallet** on first startup and logs the address + private key
2. **Polls the Moltlaunch inbox** every 2 minutes for new task requests
3. **Uses GPT-4o** to analyze each request, determine skill match, and quote a price (0.005–0.01 ETH)
4. **Accepts matching tasks**, declines everything else
5. **Waits for escrow** confirmation before executing
6. **Executes the task** using one of 5 built-in skills
7. **Submits the deliverable** as markdown
8. **Claims payment** after 24hr client review window

## 5 Skills

| Skill | What it does | Price |
|-------|-------------|-------|
| SEO Audit | Crawl URL via Jina.ai + GPT-4o technical report | 0.007–0.01 ETH |
| Content Writing | Long-form GPT-4o blog post (1500–3000 words) | 0.005–0.007 ETH |
| Code Review | Analyze code + structured feedback report | 0.007–0.01 ETH |
| Competitor Research | Web search + strategic teardown | 0.007–0.01 ETH |
| Landing Page Copy | Conversion-focused copy for product/service | 0.005–0.007 ETH |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jvogter25/cashclaw-agent
cd cashclaw-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Add OPENAI_API_KEY at minimum
```

### 3. First run (generates wallet)

```bash
npm start
```

Copy the logged `AGENT_ADDRESS` and `MOLTLAUNCH_PRIVATE_KEY` into your `.env` / Railway environment.

### 4. Deploy to Railway

1. Push to GitHub
2. Create new Railway project → Deploy from GitHub repo → select `cashclaw-agent`
3. Add environment variables from `.env.example`
4. Railway auto-deploys on every push

## Architecture

```
src/
├── index.ts          # Entry point, startup, poll interval
├── wallet.ts         # Wallet generation / loading
├── moltlaunch.ts     # Moltlaunch API client (inbox, quote, submit, claim)
├── analyze.ts        # GPT-4o task analysis + skill routing
├── inbox.ts          # Polling loop, escrow tracking, claim scheduling
├── executor.ts       # Routes to correct skill module
├── discord.ts        # Discord webhook notifications
└── skills/
    ├── seo-audit.ts
    ├── content-writing.ts
    ├── code-review.ts
    ├── competitor-research.ts
    └── landing-page-copy.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | GPT-4o API key |
| `AGENT_ADDRESS` | Yes* | Agent Ethereum address (generated on first run) |
| `MOLTLAUNCH_PRIVATE_KEY` | Yes* | Agent private key (generated on first run) |
| `DISCORD_ENGINEERING_WEBHOOK` | No | Discord webhook for status updates |
| `BRAVE_SEARCH_API_KEY` | No | Improves competitor research |
| `MOLTLAUNCH_API_URL` | No | Override Moltlaunch API base URL |

*Auto-generated on first startup if not set.
