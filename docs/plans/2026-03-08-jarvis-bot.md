# Jarvis Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an always-on Discord bot that acts as Jake's AI co-CEO, routing tasks to 61 specialized agents, running a research loop, and self-improving its system prompt nightly.

**Architecture:** A Node.js/TypeScript process on Railway that wraps the Claude API and responds to Discord messages. Memory is persisted in Supabase so context survives restarts. Cron jobs run research scraping (every 6 hrs) and overnight self-improvement (2am).

**Tech Stack:** discord.js v14, @anthropic-ai/sdk, @supabase/supabase-js, node-cron, axios, octokit, tsx (dev), TypeScript

---

## Prerequisites Checklist (Jake must complete before Task 1)

- [ ] Create Discord server "Jarvis HQ" with these channels: `#jarvis`, `#morning-brief`, `#research`, `#engineering`, `#marketing`, `#overnight-log`
- [ ] Create Discord bot at discord.com/developers → Applications → New Application → Bot tab → copy token. Enable "Message Content Intent" under Privileged Gateway Intents.
- [ ] Invite bot to server: OAuth2 → URL Generator → scopes: `bot`, permissions: `Send Messages`, `Read Message History`, `View Channels`
- [ ] Create Supabase project at supabase.com → copy Project URL and anon key
- [ ] Have Anthropic API key ready (console.anthropic.com)
- [ ] Create GitHub PAT for jvogter25: github.com/settings/tokens → repo + contents permissions

---

## File Map (full src layout we're building)

```
src/
├── index.ts                  # entry point
├── brain.ts                  # Claude API wrapper
├── discord/
│   ├── client.ts             # Discord client init
│   ├── handlers.ts           # message event handlers
│   └── channels.ts           # channel helpers
├── memory/
│   ├── supabase.ts           # Supabase client + CRUD
│   └── schema.sql            # DB schema to run in Supabase SQL editor
├── agents/
│   ├── types.ts              # Agent interface
│   ├── manifest.ts           # loads agency-agents repo
│   └── router.ts             # routes user messages to agents
├── research/
│   ├── scraper.ts            # Reddit, HN, IH scrapers
│   ├── scorer.ts             # opportunity scoring
│   └── loop.ts               # cron-driven loop
├── github/
│   └── client.ts             # Octokit wrapper
└── overnight/
    ├── trainer.ts            # prompt self-improvement
    └── briefing.ts           # morning briefing generator
```

---

## Task 1: Project bootstrap — .env.example + entry point

**Files:**
- Create: `.env.example`
- Create: `src/index.ts`

**Step 1: Create .env.example**

```bash
# src/index.ts doesn't exist yet — create .env.example first
```

Create `.env.example`:
```
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_JARVIS=channel_id
DISCORD_CHANNEL_MORNING_BRIEF=channel_id
DISCORD_CHANNEL_RESEARCH=channel_id
DISCORD_CHANNEL_ENGINEERING=channel_id
DISCORD_CHANNEL_MARKETING=channel_id
DISCORD_CHANNEL_OVERNIGHT_LOG=channel_id

ANTHROPIC_API_KEY=your_anthropic_key

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key

GITHUB_TOKEN=your_github_pat
GITHUB_OWNER=jvogter25
```

**Step 2: Copy to .env and fill in values**

```bash
cp .env.example .env
# Edit .env with real values
```

**Step 3: Create src/index.ts (bare skeleton)**

```typescript
import 'dotenv/config';

async function main() {
  console.log('Jarvis starting...');
}

main().catch(console.error);
```

**Step 4: Verify TypeScript compiles**

```bash
npx tsx src/index.ts
```
Expected: prints `Jarvis starting...`

**Step 5: Commit**

```bash
git init
git add .env.example src/index.ts package.json tsconfig.json
git commit -m "chore: project bootstrap with env template"
```

---

## Task 2: Supabase schema + memory layer

**Files:**
- Create: `src/memory/schema.sql`
- Create: `src/memory/supabase.ts`

**Step 1: Create schema.sql**

Create `src/memory/schema.sql`:
```sql
-- Run this in the Supabase SQL Editor at supabase.com → your project → SQL Editor

-- Stores conversation messages per Discord channel
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

-- Stores Jarvis's evolving system prompt
create table if not exists system_prompts (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  content text not null,
  created_at timestamptz default now()
);

-- Stores validated research opportunities
create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  title text not null,
  summary text not null,
  score int not null,
  raw jsonb,
  posted_to_discord boolean default false,
  created_at timestamptz default now()
);

-- Seed initial system prompt
insert into system_prompts (version, content) values (
  1,
  'You are Jarvis, Jake''s AI co-CEO. You help Jake run side hustles by coordinating a team of 61 specialized AI agents. You are strategic, direct, and focused on business results. Jake is busy with a full-time job — keep responses concise and actionable. Current focus: South Bay Digital (GHL AI receptionist service for contractors).'
);
```

**Step 2: Run schema in Supabase**
- Go to supabase.com → your project → SQL Editor
- Paste and run the contents of `schema.sql`
- Verify tables appear in Table Editor

**Step 3: Create src/memory/supabase.ts**

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export type Message = {
  role: 'user' | 'assistant';
  content: string;
};

/** Get last N messages for a channel (for Claude context window) */
export async function getRecentMessages(channelId: string, limit = 20): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).reverse() as Message[];
}

/** Save a message to memory */
export async function saveMessage(channelId: string, role: 'user' | 'assistant', content: string) {
  const { error } = await supabase
    .from('messages')
    .insert({ channel_id: channelId, role, content });

  if (error) throw error;
}

/** Get the current system prompt */
export async function getSystemPrompt(): Promise<string> {
  const { data, error } = await supabase
    .from('system_prompts')
    .select('content')
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data.content;
}

/** Save a new system prompt version */
export async function saveSystemPrompt(content: string) {
  const { data: latest } = await supabase
    .from('system_prompts')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .single();

  const nextVersion = (latest?.version ?? 0) + 1;

  const { error } = await supabase
    .from('system_prompts')
    .insert({ version: nextVersion, content });

  if (error) throw error;
}

/** Save a research opportunity */
export async function saveOpportunity(opp: {
  source: string;
  title: string;
  summary: string;
  score: number;
  raw: unknown;
}) {
  const { error } = await supabase
    .from('opportunities')
    .insert({ ...opp });

  if (error) throw error;
}

/** Get unposted opportunities */
export async function getUnpostedOpportunities() {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('posted_to_discord', false)
    .order('score', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/** Mark opportunity as posted */
export async function markOpportunityPosted(id: string) {
  const { error } = await supabase
    .from('opportunities')
    .update({ posted_to_discord: true })
    .eq('id', id);

  if (error) throw error;
}
```

**Step 4: Verify the module resolves**

```bash
npx tsx -e "import './src/memory/supabase'; console.log('OK')"
```
Expected: `OK` (no errors)

**Step 5: Commit**

```bash
git add src/memory/
git commit -m "feat: supabase memory layer with messages, prompts, opportunities"
```

---

## Task 3: Claude brain wrapper

**Files:**
- Create: `src/brain.ts`

**Step 1: Create src/brain.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Send a conversation to Claude and get a response */
export async function think(systemPrompt: string, history: Message[], userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type');
  return block.text;
}
```

**Step 2: Verify it resolves**

```bash
npx tsx -e "import './src/brain'; console.log('OK')"
```
Expected: `OK`

**Step 3: Commit**

```bash
git add src/brain.ts
git commit -m "feat: claude brain wrapper"
```

---

## Task 4: Agent manifest

**Note:** This requires the agency-agents repo. Clone it adjacent to the jarvis repo:

```bash
cd /Users/JakeLaylo
git clone https://github.com/msitarzewski/agency-agents
```

Then check what format the agent files are in (likely markdown) before writing the manifest loader.

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/manifest.ts`
- Create: `src/agents/router.ts`

**Step 1: Inspect agency-agents repo format**

```bash
ls /Users/JakeLaylo/agency-agents
ls /Users/JakeLaylo/agency-agents/agents 2>/dev/null || ls /Users/JakeLaylo/agency-agents
head -50 "$(ls /Users/JakeLaylo/agency-agents/**/*.md | head -1)" 2>/dev/null || head -50 "$(ls /Users/JakeLaylo/agency-agents/*.md | head -1)"
```

Adapt the manifest loader to match whatever format the files are in.

**Step 2: Create src/agents/types.ts**

```typescript
export interface Agent {
  id: string;          // filename slug, e.g. "frontend-engineer"
  name: string;        // display name
  description: string; // what this agent does (for routing)
  systemPrompt: string;// full system prompt content
}
```

**Step 3: Create src/agents/manifest.ts**

Assumes agents are `.md` files in a directory. Adjust `AGENTS_DIR` after inspecting the repo.

```typescript
import fs from 'fs';
import path from 'path';
import { Agent } from './types';

const AGENTS_DIR = path.join(__dirname, '../../../agency-agents');

let _agents: Agent[] | null = null;

export function loadAgents(): Agent[] {
  if (_agents) return _agents;

  const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));

  _agents = agentFiles.map(file => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8');
    const slug = file.replace('.md', '');

    // Extract name from first # heading, or use slug
    const nameMatch = content.match(/^#\s+(.+)/m);
    const name = nameMatch ? nameMatch[1].trim() : slug;

    // Extract description from first paragraph after heading
    const descMatch = content.match(/^#[^\n]*\n+([^\n#]+)/m);
    const description = descMatch ? descMatch[1].trim() : '';

    return { id: slug, name, description, systemPrompt: content };
  });

  console.log(`Loaded ${_agents.length} agents`);
  return _agents;
}
```

**Step 4: Create src/agents/router.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { loadAgents } from './manifest';
import { think } from '../brain';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Pick the best agent for a task, or null if Jarvis handles it directly */
export async function routeToAgent(userMessage: string): Promise<string | null> {
  const agents = loadAgents();

  const agentList = agents.map(a => `- ${a.id}: ${a.description}`).join('\n');

  const routingPrompt = `You are a task router. Given a user message, decide which specialist agent (if any) should handle it.

Available agents:
${agentList}

If the message is general conversation, strategy, or status — respond with: NONE
Otherwise respond with just the agent ID (e.g. "frontend-engineer"). No explanation.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    messages: [{ role: 'user', content: userMessage }],
    system: routingPrompt,
  });

  const block = response.content[0];
  if (block.type !== 'text') return null;

  const agentId = block.text.trim();
  if (agentId === 'NONE') return null;

  const agent = agents.find(a => a.id === agentId);
  if (!agent) return null;

  // Call the agent with the user message
  return think(agent.systemPrompt, [], userMessage);
}
```

**Step 5: Verify**

```bash
npx tsx -e "import { loadAgents } from './src/agents/manifest'; const agents = loadAgents(); console.log('Agents loaded:', agents.length)"
```
Expected: `Agents loaded: 61` (or however many are in the repo)

**Step 6: Commit**

```bash
git add src/agents/
git commit -m "feat: agent manifest loader and router (61 agents)"
```

---

## Task 5: Discord bot — client + message handler

**Files:**
- Create: `src/discord/channels.ts`
- Create: `src/discord/handlers.ts`
- Create: `src/discord/client.ts`
- Modify: `src/index.ts`

**Step 1: Create src/discord/channels.ts**

```typescript
export const CHANNELS = {
  JARVIS: process.env.DISCORD_CHANNEL_JARVIS!,
  MORNING_BRIEF: process.env.DISCORD_CHANNEL_MORNING_BRIEF!,
  RESEARCH: process.env.DISCORD_CHANNEL_RESEARCH!,
  ENGINEERING: process.env.DISCORD_CHANNEL_ENGINEERING!,
  MARKETING: process.env.DISCORD_CHANNEL_MARKETING!,
  OVERNIGHT_LOG: process.env.DISCORD_CHANNEL_OVERNIGHT_LOG!,
};

/** Split long messages for Discord's 2000 char limit */
export function splitMessage(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}
```

**Step 2: Create src/discord/handlers.ts**

```typescript
import { Message as DiscordMessage } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase';
import { think } from '../brain';
import { routeToAgent } from '../agents/router';
import { CHANNELS, splitMessage } from './channels';

export async function handleMessage(msg: DiscordMessage) {
  // Only respond in #jarvis channel, ignore bots
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNELS.JARVIS) return;

  await msg.channel.sendTyping();

  try {
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', msg.content);

    // Try routing to a specialist agent first
    const agentResponse = await routeToAgent(msg.content);

    let reply: string;
    if (agentResponse) {
      reply = agentResponse;
    } else {
      const systemPrompt = await getSystemPrompt();
      reply = await think(systemPrompt, history, msg.content);
    }

    await saveMessage(msg.channelId, 'assistant', reply);

    // Send reply, splitting if needed
    for (const chunk of splitMessage(reply)) {
      await msg.channel.send(chunk);
    }
  } catch (err) {
    console.error('Error handling message:', err);
    await msg.channel.send('⚠️ Something went wrong. Check the logs.');
  }
}
```

**Step 3: Create src/discord/client.ts**

```typescript
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleMessage } from './handlers';

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, handleMessage);

  return client;
}
```

**Step 4: Update src/index.ts**

```typescript
import 'dotenv/config';
import { createDiscordClient } from './discord/client';

async function main() {
  console.log('Jarvis starting...');

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  console.log('Jarvis online.');
}

main().catch(console.error);
```

**Step 5: Test locally**

```bash
npm run dev
```
Expected: `Discord connected as Jarvis#XXXX` then `Jarvis online.`
Test: Send a message in #jarvis channel → Jarvis should respond.

**Step 6: Commit**

```bash
git add src/discord/ src/index.ts
git commit -m "feat: discord bot with message handling + agent routing"
```

---

## Task 6: Research loop — scraper + scorer

**Files:**
- Create: `src/research/scraper.ts`
- Create: `src/research/scorer.ts`
- Create: `src/research/loop.ts`

**Step 1: Create src/research/scraper.ts**

```typescript
import axios from 'axios';

export interface RawPost {
  source: 'reddit' | 'hn' | 'indie_hackers';
  title: string;
  body: string;
  url: string;
  score: number;
}

/** Scrape Reddit for pain points and product discussions */
export async function scrapeReddit(): Promise<RawPost[]> {
  const subreddits = ['Entrepreneur', 'SideProject', 'smallbusiness', 'startups'];
  const posts: RawPost[] = [];

  for (const sub of subreddits) {
    try {
      const res = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, {
        headers: { 'User-Agent': 'Jarvis/1.0 research-bot' },
      });

      for (const child of res.data.data.children) {
        const post = child.data;
        posts.push({
          source: 'reddit',
          title: post.title,
          body: post.selftext ?? '',
          url: `https://reddit.com${post.permalink}`,
          score: post.score,
        });
      }
    } catch (err) {
      console.error(`Reddit scrape failed for r/${sub}:`, err);
    }
  }

  return posts;
}

/** Scrape Hacker News "Ask HN" for pain points */
export async function scrapeHN(): Promise<RawPost[]> {
  try {
    const res = await axios.get('https://hn.algolia.com/api/v1/search?query=ask+hn+how+do+you&tags=ask_hn&hitsPerPage=30');

    return res.data.hits.map((hit: {title?: string; story_text?: string; url?: string; points?: number; objectID?: string}) => ({
      source: 'hn' as const,
      title: hit.title ?? '',
      body: hit.story_text ?? '',
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points ?? 0,
    }));
  } catch (err) {
    console.error('HN scrape failed:', err);
    return [];
  }
}
```

**Step 2: Create src/research/scorer.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { RawPost } from './scraper';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ScoredOpportunity {
  source: string;
  title: string;
  summary: string;
  score: number;
  raw: RawPost;
}

const SCORING_PROMPT = `You are a B2B SaaS opportunity evaluator. Given a post, score it 0-100 based on:
- Pain clarity: Is there a clear, recurring business pain? (0-40 pts)
- Payment signal: Do people say they'd pay, or mention budget/current spend? (0-40 pts)
- Market gap: No dominant solution under $100/mo? (0-20 pts)

Respond with JSON only:
{"score": 0-100, "summary": "one sentence describing the opportunity"}

If score < 40, the opportunity is not worth tracking.`;

export async function scorePost(post: RawPost): Promise<ScoredOpportunity | null> {
  const content = `Title: ${post.title}\n\nBody: ${post.body.slice(0, 1000)}`;

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: SCORING_PROMPT,
      messages: [{ role: 'user', content }],
    });

    const block = res.content[0];
    if (block.type !== 'text') return null;

    const parsed = JSON.parse(block.text);
    if (parsed.score < 40) return null;

    return {
      source: post.source,
      title: post.title,
      summary: parsed.summary,
      score: parsed.score,
      raw: post,
    };
  } catch {
    return null;
  }
}
```

**Step 3: Create src/research/loop.ts**

```typescript
import { scrapeReddit, scrapeHN } from './scraper';
import { scorePost, ScoredOpportunity } from './scorer';
import { saveOpportunity, getUnpostedOpportunities, markOpportunityPosted } from '../memory/supabase';
import { Client, TextChannel } from 'discord.js';
import { CHANNELS } from '../discord/channels';

export async function runResearchLoop(discord: Client) {
  console.log('Research loop: starting scrape...');

  const [redditPosts, hnPosts] = await Promise.all([scrapeReddit(), scrapeHN()]);
  const allPosts = [...redditPosts, ...hnPosts];

  console.log(`Research loop: scoring ${allPosts.length} posts...`);

  const scored: ScoredOpportunity[] = [];
  for (const post of allPosts) {
    const result = await scorePost(post);
    if (result) scored.push(result);
  }

  console.log(`Research loop: ${scored.length} opportunities found`);

  // Save to Supabase
  for (const opp of scored) {
    await saveOpportunity(opp);
  }

  // Post unposted opportunities to Discord
  const unposted = await getUnpostedOpportunities();
  const channel = discord.channels.cache.get(CHANNELS.RESEARCH) as TextChannel;

  if (!channel) {
    console.error('Research channel not found');
    return;
  }

  for (const opp of unposted) {
    const msg = `**[${opp.score}/100] ${opp.title}**\n${opp.summary}\nSource: ${opp.source}`;
    await channel.send(msg);
    await markOpportunityPosted(opp.id);
  }
}
```

**Step 4: Wire into index.ts**

```typescript
import 'dotenv/config';
import cron from 'node-cron';
import { createDiscordClient } from './discord/client';
import { runResearchLoop } from './research/loop';

async function main() {
  console.log('Jarvis starting...');

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  // Research loop: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    runResearchLoop(discord).catch(console.error);
  });

  console.log('Jarvis online.');
}

main().catch(console.error);
```

**Step 5: Test**

```bash
# Trigger manually to verify
npx tsx -e "
import 'dotenv/config';
import { scrapeReddit, scrapeHN } from './src/research/scraper';
Promise.all([scrapeReddit(), scrapeHN()]).then(([r, h]) => console.log('Posts:', r.length + h.length));
"
```
Expected: `Posts: 55` (or similar number)

**Step 6: Commit**

```bash
git add src/research/ src/index.ts
git commit -m "feat: research loop with Reddit/HN scraping and Claude scoring"
```

---

## Task 7: GitHub integration

**Files:**
- Create: `src/github/client.ts`

**Step 1: Create src/github/client.ts**

```typescript
import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;

/** List repos for the owner */
export async function listRepos() {
  const { data } = await octokit.rest.repos.listForAuthenticatedUser({ per_page: 30 });
  return data.map(r => ({ name: r.name, url: r.html_url, private: r.private }));
}

/** Create or update a file in a repo */
export async function upsertFile(repo: string, filePath: string, content: string, message: string) {
  // Check if file exists to get SHA for update
  let sha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: filePath });
    if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
  } catch {
    // File doesn't exist yet, that's fine
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    sha,
  });
}

/** Create a pull request */
export async function createPR(repo: string, title: string, body: string, head: string, base = 'main') {
  const { data } = await octokit.rest.pulls.create({
    owner: OWNER,
    repo,
    title,
    body,
    head,
    base,
  });
  return data.html_url;
}
```

**Step 2: Verify**

```bash
npx tsx -e "
import 'dotenv/config';
import { listRepos } from './src/github/client';
listRepos().then(repos => console.log('Repos:', repos.map(r => r.name)));
"
```
Expected: list of Jake's repos

**Step 3: Commit**

```bash
git add src/github/
git commit -m "feat: github integration via octokit"
```

---

## Task 8: Overnight training loop + morning briefing

**Files:**
- Create: `src/overnight/trainer.ts`
- Create: `src/overnight/briefing.ts`
- Modify: `src/index.ts`

**Step 1: Create src/overnight/trainer.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { getRecentMessages, getSystemPrompt, saveSystemPrompt } from '../memory/supabase';
import { CHANNELS } from '../discord/channels';
import { Client, TextChannel } from 'discord.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function runOvernightTraining(discord: Client) {
  console.log('Overnight training: starting...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 100);
  const currentPrompt = await getSystemPrompt();

  if (history.length < 10) {
    console.log('Not enough conversation data yet, skipping training');
    return;
  }

  const conversation = history.map(m => `${m.role}: ${m.content}`).join('\n');

  const analysisPrompt = `You are a prompt engineer. Review this conversation between Jarvis (AI co-CEO) and Jake, then rewrite Jarvis's system prompt to be more effective.

Current system prompt:
${currentPrompt}

Recent conversations:
${conversation.slice(0, 8000)}

Analyze: What was routed correctly? What produced bad outputs? What confused Jarvis?
Then rewrite the system prompt to address these issues. Keep it under 500 words.

Respond with JSON:
{"analysis": "what you found", "new_prompt": "the improved system prompt"}`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: analysisPrompt }],
  });

  const block = res.content[0];
  if (block.type !== 'text') return;

  const parsed = JSON.parse(block.text);
  await saveSystemPrompt(parsed.new_prompt);

  const logChannel = discord.channels.cache.get(CHANNELS.OVERNIGHT_LOG) as TextChannel;
  if (logChannel) {
    await logChannel.send(`**Overnight Training Complete**\n\n**Analysis:** ${parsed.analysis}\n\n**New prompt version saved.**`);
  }

  console.log('Overnight training: complete');
}
```

**Step 2: Create src/overnight/briefing.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { getRecentMessages, getUnpostedOpportunities } from '../memory/supabase';
import { CHANNELS } from '../discord/channels';
import { Client, TextChannel } from 'discord.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function postMorningBriefing(discord: Client) {
  const history = await getRecentMessages(CHANNELS.JARVIS, 50);
  const opportunities = await getUnpostedOpportunities();

  const context = `
Recent conversations: ${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000)}
Top opportunities found: ${opportunities.slice(0, 3).map(o => `${o.title} (score: ${o.score})`).join(', ')}
`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: 'You are Jarvis. Write a concise morning briefing for Jake. Include: what happened overnight, top 3 priorities for today, any opportunities to review. Be direct, no fluff. Format with headers.',
    messages: [{ role: 'user', content: context }],
  });

  const block = res.content[0];
  if (block.type !== 'text') return;

  const channel = discord.channels.cache.get(CHANNELS.MORNING_BRIEF) as TextChannel;
  if (channel) {
    await channel.send(`**Good morning, Jake.** Here's your briefing:\n\n${block.text}`);
  }
}
```

**Step 3: Update src/index.ts (final version)**

```typescript
import 'dotenv/config';
import cron from 'node-cron';
import { createDiscordClient } from './discord/client';
import { runResearchLoop } from './research/loop';
import { runOvernightTraining } from './overnight/trainer';
import { postMorningBriefing } from './overnight/briefing';

async function main() {
  console.log('Jarvis starting...');

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  // Research loop: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    runResearchLoop(discord).catch(console.error);
  });

  // Overnight training: 2am
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
  });

  // Morning briefing: 7am
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
  });

  console.log('Jarvis online.');
}

main().catch(console.error);
```

**Step 4: Full local test**

```bash
npm run dev
```
Expected: Discord connected, crons scheduled, bot responds in #jarvis

**Step 5: Commit**

```bash
git add src/overnight/ src/index.ts
git commit -m "feat: overnight training loop + morning briefing"
```

---

## Task 9: Railway deployment

**Files:**
- Create: `railway.json`
- Create: `Procfile`

**Step 1: Create railway.json**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run build && npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

**Step 2: Create Procfile (fallback)**

```
web: npm run build && npm start
```

**Step 3: Push to GitHub**

```bash
git remote add origin https://github.com/jvogter25/jarvis.git
git push -u origin main
```

**Step 4: Deploy on Railway**

- Go to railway.app → New Project → Deploy from GitHub Repo
- Select the jarvis repo
- Add all environment variables from `.env` (except don't commit `.env` itself)
- Railway auto-deploys on push

**Step 5: Verify in Railway logs**

Expected: `Jarvis starting...` → `Discord connected as Jarvis#XXXX` → `Jarvis online.`

**Step 6: Final commit**

```bash
git add railway.json Procfile
git commit -m "chore: railway deployment config"
```

---

## Done

All 5 items from the CLAUDE.md build order are complete:
- [x] Jarvis bot skeleton — Discord + Claude + Supabase memory
- [x] Agent manifest — 61 agents loaded, routing
- [x] Research loop — Reddit/HN scraper + Claude scorer + Discord posts
- [x] GitHub integration — file upsert + PR creation
- [x] Overnight training loop + morning briefing

Jarvis is now live on Railway. Talk to him in #jarvis.
