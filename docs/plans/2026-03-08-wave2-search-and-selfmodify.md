# Wave 2: Brave Search + Self-Modify Loop

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Jarvis real web search capability and the ability to install new tools autonomously by pushing its own code to GitHub and redeploying.

**Architecture:** Two independent additions. (1) Brave Search API gives Jarvis a `search_web` tool that queries the internet by topic — not just visiting known URLs. (2) The self-modify loop gives Jarvis a `self_modify` tool that writes new integration files, updates `package.json`, pushes to GitHub, and notifies Jake — turning "Want me to install X?" from a suggestion into an actual action.

**Tech Stack:** Brave Search API (REST, free tier), existing octokit GitHub client (`src/github/client.ts`), existing brain tool_use loop (`src/brain.ts`), existing tool registry (`src/tools/registry.ts`)

**Pre-requisite (human step, ~5 min):**
1. Go to https://api.search.brave.com/register → create free account → get API key
2. Add to Railway: Settings → Variables → `BRAVE_SEARCH_API_KEY=your_key`
3. Then run this plan

---

## Existing Code Context

- `src/brain.ts` — agentic tool_use loop. `TOOL_SCHEMAS` is a `Record<string, Anthropic.Tool>`. `executeTool()` dispatches by tool name. `activeToolSchemas` built from `getInstalledTools()` + always includes `request_tool_install`.
- `src/tools/registry.ts` — `TOOLS` array, `getInstalledTools()` filters by `installed: true` + env vars present
- `src/github/client.ts` — `upsertFile(repo, path, content, message)` pushes a file to GitHub. `OWNER` from `process.env.GITHUB_OWNER` (= `jvogter25`), repo = `jarvis`
- `src/tools/shell.ts` — `runShell(commands, files?)` — already built
- `src/tools/browser.ts` — `browseUrl(url, task)` via Jina.ai — already built
- `package.json` — `"build": "tsc && cp src/agents/agents.json dist/agents/agents.json"`. Adding a new npm package requires updating dependencies here and pushing to GitHub to trigger rebuild.

---

## Task 1: Brave Search Tool

**What:** A `searchWeb(query, count?)` function that hits the Brave Search API and returns structured results (title, url, description). This becomes the `search_web` Claude tool.

**Files:**
- Create: `src/tools/search.ts`
- Modify: `src/tools/registry.ts` — add `search_web` entry
- Modify: `src/brain.ts` — add `search_web` tool schema + executor

### Step 1: Create `src/tools/search.ts`

```typescript
export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

/**
 * Search the web using Brave Search API.
 * Returns up to `count` results (default 5, max 20).
 * Requires BRAVE_SEARCH_API_KEY env var.
 */
export async function searchWeb(query: string, count = 5): Promise<SearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { results: [], error: 'BRAVE_SEARCH_API_KEY not set' };
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
    });

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { results: [], error: `Brave API error: ${res.status} ${res.statusText}` };
    }

    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description?: string }> };
    };

    const results: SearchResult[] = (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description ?? '',
    }));

    return { results };
  } catch (err) {
    return { results: [], error: (err as Error).message };
  }
}
```

### Step 2: Add `search_web` to `src/tools/registry.ts`

Add this entry to the `TOOLS` array (after the `github` entry):

```typescript
  {
    id: 'search_web',
    name: 'Web Search',
    description: 'Search the web by query using Brave Search. Returns titles, URLs, and descriptions.',
    installed: true,
    requiresEnv: ['BRAVE_SEARCH_API_KEY'],
  },
```

### Step 3: Add `search_web` tool schema + executor to `src/brain.ts`

**Add to `TOOL_SCHEMAS`** (after `browse_web`):

```typescript
  search_web: {
    name: 'search_web',
    description: 'Search the web for any topic. Returns titles, URLs, and descriptions. Use this to discover relevant pages, then use browse_web to read specific pages in depth.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
```

**Add import** at top of `src/brain.ts`:
```typescript
import { searchWeb } from './tools/search.js';
```

**Add case to `executeTool()`** (after `browse_web` case):

```typescript
    case 'search_web': {
      const query = input.query as string;
      const count = (input.count as number | undefined) ?? 5;
      const response = await searchWeb(query, count);
      if (response.error) {
        return { toolName: name, output: `Search failed: ${response.error}` };
      }
      const formatted = response.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join('\n\n');
      return { toolName: name, output: formatted || 'No results found.' };
    }
```

### Step 4: Verify

```bash
cd /Users/JakeLaylo/jarvis
npx tsc --noEmit
```

Expected: Zero errors.

### Step 5: Commit

```bash
git add src/tools/search.ts src/tools/registry.ts src/brain.ts
git commit -m "feat: add Brave Search web search tool"
```

---

## Task 2: Self-Modify Loop

**What:** When Jake says "yes" to a tool install request, Jarvis actually does it — writes the integration code, updates `package.json` if needed, pushes to the `jarvis` GitHub repo, and notifies Jake that redeploy is in progress. After Railway redeploys (~2 min), the new tool is live.

**Architecture:** A `SelfModifyPlan` describes everything needed to install a tool: new files to create, `package.json` dependency to add (optional), env var needed. The `executeSelfModify()` function pushes all files to GitHub via `upsertFile`, then updates `package.json`. Railway's GitHub integration auto-deploys on push.

**Files:**
- Create: `src/tools/self-modify.ts`
- Modify: `src/discord/handlers.ts` — when Jake approves install, call `executeSelfModify` instead of telling him to come to Claude Code
- Modify: `src/brain.ts` — update `request_tool_install` executor to look up a plan and include it in the install request result

### Step 1: Create `src/tools/self-modify.ts`

```typescript
import { upsertFile } from '../github/client.js';

export interface FileToWrite {
  path: string;       // relative to repo root, e.g. "src/tools/stripe.ts"
  content: string;
}

export interface SelfModifyPlan {
  toolId: string;
  description: string;
  files: FileToWrite[];
  npmPackage?: string;   // e.g. "stripe" — added to package.json dependencies
  envVarName?: string;   // e.g. "STRIPE_API_KEY"
}

/**
 * Push new tool files to GitHub. Railway auto-deploys on push.
 * Returns the GitHub commit URL (from the last file pushed).
 */
export async function executeSelfModify(plan: SelfModifyPlan): Promise<{ success: boolean; message: string }> {
  try {
    // Push each new file to GitHub
    for (const file of plan.files) {
      await upsertFile(
        'jarvis',
        file.path,
        file.content,
        `feat: auto-install ${plan.toolId} tool`
      );
    }

    // If an npm package is needed, update package.json
    if (plan.npmPackage) {
      await addNpmDependency(plan.npmPackage);
    }

    const envNote = plan.envVarName
      ? ` Add \`${plan.envVarName}\` to Railway env vars to activate it.`
      : '';

    return {
      success: true,
      message: `Pushed ${plan.files.length} file(s) to GitHub. Railway is rebuilding now (~2 min).${envNote} I'll be ready after the deploy.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Self-modify failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Read package.json from GitHub, add the npm package to dependencies, push back.
 */
async function addNpmDependency(packageName: string): Promise<void> {
  const { Octokit } = await import('octokit');
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const owner = process.env.GITHUB_OWNER!;

  // Read current package.json
  const { data } = await octokit.rest.repos.getContent({ owner, repo: 'jarvis', path: 'package.json' });
  if (Array.isArray(data) || data.type !== 'file') throw new Error('package.json not found');

  const raw = Buffer.from(data.content, 'base64').toString('utf-8');
  const pkg = JSON.parse(raw);

  // Add with a permissive version range — exact version will be resolved on install
  pkg.dependencies[packageName] = `latest`;

  await upsertFile(
    'jarvis',
    'package.json',
    JSON.stringify(pkg, null, 2) + '\n',
    `feat: add ${packageName} dependency for auto-install`
  );
}
```

### Step 2: Define installable tool plans

Add a plans registry to `src/tools/self-modify.ts` (append after the functions above):

```typescript
/**
 * Pre-defined plans for tools Jarvis knows how to install.
 * When Jake approves an install, look up the plan here.
 * If no plan exists, Jarvis tells Jake to ask in Claude Code.
 */
export const INSTALL_PLANS: Record<string, SelfModifyPlan> = {
  stripe: {
    toolId: 'stripe',
    description: 'Stripe payments — check revenue, list charges, manage subscriptions',
    envVarName: 'STRIPE_SECRET_KEY',
    npmPackage: 'stripe',
    files: [
      {
        path: 'src/tools/stripe.ts',
        content: `import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function getRevenueSummary(): Promise<string> {
  const charges = await stripe.charges.list({ limit: 10 });
  const total = charges.data.reduce((sum, c) => sum + (c.amount_captured ?? 0), 0);
  return \`Last 10 charges: $\${(total / 100).toFixed(2)} total. \${charges.data.length} transactions.\`;
}
`,
      },
    ],
  },
  twilio: {
    toolId: 'twilio',
    description: 'Twilio — send SMS messages',
    envVarName: 'TWILIO_AUTH_TOKEN',
    npmPackage: 'twilio',
    files: [
      {
        path: 'src/tools/twilio.ts',
        content: `import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export async function sendSms(to: string, body: string): Promise<string> {
  const msg = await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER!, to });
  return \`SMS sent: \${msg.sid}\`;
}
`,
      },
    ],
  },
};
```

### Step 3: Update `src/discord/handlers.ts` — call `executeSelfModify` on approval

Find the affirmative install approval block (around line 44-49):

```typescript
    if (isAffirmative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(
        `Got it. To add **${pending.capability}** to my capabilities, ask in Claude Code: "Add ${pending.capability} to Jarvis". It takes a few minutes to build and deploy. I'll be ready after.`
      );
      return;
    }
```

Replace with:

```typescript
    if (isAffirmative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      const toolId = pending.capability.toLowerCase().replace(/\s+/g, '_');
      const plan = INSTALL_PLANS[toolId];
      if (plan) {
        await msg.channel.send(`On it — installing **${pending.capability}** now...`);
        const result = await executeSelfModify(plan);
        await msg.channel.send(result.message);
      } else {
        await msg.channel.send(
          `I don't have an auto-install recipe for **${pending.capability}** yet. Ask in Claude Code: "Add ${pending.capability} to Jarvis" and it'll be wired up.`
        );
      }
      return;
    }
```

Add the imports at the top of `handlers.ts`:

```typescript
import { executeSelfModify, INSTALL_PLANS } from '../tools/self-modify.js';
```

### Step 4: Verify

```bash
cd /Users/JakeLaylo/jarvis
npx tsc --noEmit
```

Expected: Zero errors.

### Step 5: Commit

```bash
git add src/tools/self-modify.ts src/discord/handlers.ts
git commit -m "feat: self-modify loop — Jarvis pushes own code to GitHub on tool install approval"
```

---

## Task 3: Push and Verify

### Step 1: Push to GitHub

```bash
git push
```

### Step 2: Wait ~2 min, confirm deploy

```bash
RAILWAY_TOKEN=e3f04af9-a910-48ad-8706-199244820638 railway logs --service jarvis 2>&1 | tail -20
```

Expected: `Jarvis online. Discord connected as Jarvis#7662`

### Step 3: Test search_web

In Discord `#jarvis`:
```
What are the top trends in AI automation for small businesses right now?
```

Expected: Jarvis calls `search_web`, returns a list of results with titles and URLs. No "Something went wrong."

### Step 4: Test browse_web (already fixed with Jina.ai)

```
What's on the front page of news.ycombinator.com right now?
```

Expected: Jarvis visits HN via Jina.ai, returns actual headlines.

### Step 5: Test request_tool_install → self-modify

```
Can you send me a text message?
```

Expected flow:
1. Jarvis: "To do that I need **Twilio** — want me to install it? (yes/no)"
2. You say: "yes"
3. Jarvis: "On it — installing **Twilio** now..."
4. Jarvis: "Pushed 1 file(s) to GitHub. Railway is rebuilding now (~2 min). Add `TWILIO_AUTH_TOKEN` to Railway env vars to activate it."

---

## How to Run This Plan Overnight (Autonomous Mode)

**Before bed (~10 min):**

1. Sign up for Brave Search API: https://api.search.brave.com/register (free)
2. Get API key from dashboard
3. Add to Railway: Dashboard → jarvis service → Variables → `BRAVE_SEARCH_API_KEY=your_key`
4. Open a new terminal in `/Users/JakeLaylo/jarvis`
5. Run: `claude --dangerously-skip-permissions`
6. Say: `Execute the plan at docs/plans/2026-03-08-wave2-search-and-selfmodify.md using the superpowers:executing-plans skill`
7. Leave it running — it will implement both tasks, push to GitHub, and deploy

**Risk:** If the session times out or hits an unrecoverable error, it stops. Check in the morning — worst case is a partial implementation that needs a small fix.

**Wave 3 (after this):** Gmail + Calendar integration, GHL webhook, Stripe revenue tracking
