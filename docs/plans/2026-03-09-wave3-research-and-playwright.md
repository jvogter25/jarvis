# Wave 3: Research Expansion + Real Playwright

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix duplicate research results, massively expand research sources (more subreddits + Brave Search + Dev.to), tune the scorer for Jake's market, and add real interactive browser automation via Browserbase (no E2B install time).

**Architecture:** Research loop gets deduplication via URL fingerprinting in Supabase, more sources, and Brave Search integration. Playwright becomes a real tool backed by Browserbase (managed cloud browser) so Jarvis can click, fill forms, inspect CSS, and interact with live pages — not just read text.

**Tech Stack:** Existing axios/scraper pattern, Brave Search API (already wired), Browserbase API (https://www.browserbase.com — free tier, no install), existing Supabase memory layer

---

## Pre-requisites (human steps)

1. **Browserbase account** — sign up at https://www.browserbase.com (free tier: 1000 sessions/mo)
   - Get API key → add to Railway as `BROWSERBASE_API_KEY`
   - Get project ID → add to Railway as `BROWSERBASE_PROJECT_ID`

---

## Task 1: Fix Research Duplicates

**Problem:** Research loop runs every 6hrs and re-scores posts that are still "hot" — posts same opportunities multiple times.

**Fix:** Before saving an opportunity, check if its URL already exists in the `opportunities` table. Skip if already seen.

**Files:**
- Modify: `src/memory/supabase.ts` — add `hasOpportunity(url: string): Promise<boolean>`
- Modify: `src/research/loop.ts` — check `hasOpportunity` before scoring

**Step 1: Add `hasOpportunity` to `src/memory/supabase.ts`**

```typescript
export async function hasOpportunity(url: string): Promise<boolean> {
  const { count } = await supabase
    .from('opportunities')
    .select('id', { count: 'exact', head: true })
    .eq('source', url);
  return (count ?? 0) > 0;
}
```

Note: the `opportunities` table uses `source` to store the URL. Verify this against the existing schema before implementing — read `src/memory/schema.sql` and `src/memory/supabase.ts` first.

**Step 2: Update `src/research/loop.ts`** — before calling `scorePost`, skip if URL already seen:

```typescript
import { hasOpportunity } from '../memory/supabase.js';

// Inside the scoring loop:
for (const post of allPosts) {
  if (await hasOpportunity(post.url)) continue;  // already seen
  const result = await scorePost(post);
  if (result) scored.push(result);
}
```

**Verify:** `npx tsc --noEmit` — zero errors.

**Commit:** `git commit -m "fix: deduplicate research results by URL"`

---

## Task 2: Expand Research Sources

**What:** Add 15+ targeted subreddits covering Jake's market (local service businesses, contractors, B2B SaaS buyers), add Brave Search for trending pain points, add Dev.to API.

**Files:**
- Modify: `src/research/scraper.ts` — expand subreddits, add Brave Search scraper, add Dev.to scraper

**Step 1: Expand Reddit subreddits**

Replace the current subreddits array with:
```typescript
const subreddits = [
  // Existing
  'Entrepreneur', 'SideProject', 'smallbusiness', 'startups',
  // Jake's market — local service businesses & contractors
  'hvacr', 'Plumbing', 'Construction', 'realestateinvesting',
  'HomeImprovement', 'electricians', 'handyman',
  // B2B SaaS buyers
  'agency', 'freelance', 'msp', 'sysadmin',
  // Opportunity signals
  'indiehackers', 'SaaS', 'microsaas',
];
```

**Step 2: Add Brave Search scraper**

Add a new function `scrapeBraveSearch()` that uses the existing `BRAVE_SEARCH_API_KEY` to search for fresh pain-point discussions:

```typescript
export async function scrapeBraveSearch(): Promise<RawPost[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  const queries = [
    'small business owner struggling with',
    'wish there was a tool that could',
    'I pay too much for',
    'looking for software that does',
    'contractor business problem',
  ];

  const posts: RawPost[] = [];

  for (const query of queries) {
    try {
      const params = new URLSearchParams({ q: query, count: '5' });
      const res = await axios.get(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } }
      );
      const results = res.data.web?.results ?? [];
      for (const r of results) {
        posts.push({
          source: 'hn', // reuse type, treat as generic web
          title: r.title ?? '',
          body: r.description ?? '',
          url: r.url ?? '',
          score: 0,
        });
      }
    } catch (err) {
      console.error(`Brave search failed for query "${query}":`, err);
    }
  }

  return posts;
}
```

Note: `RawPost.source` is typed as `'reddit' | 'hn'` — either extend the union type to include `'web'` or keep using `'hn'` as a catch-all. Extending is preferred — update the type and any switch statements that use it.

**Step 3: Add Dev.to scraper**

```typescript
export async function scrapeDevTo(): Promise<RawPost[]> {
  try {
    const res = await axios.get(
      'https://dev.to/api/articles?tag=business&per_page=20&top=7',
      { headers: { 'User-Agent': 'Jarvis/1.0 research-bot' } }
    );
    return res.data.map((a: { title: string; description?: string; url: string; positive_reactions_count: number }) => ({
      source: 'hn' as const,
      title: a.title,
      body: a.description ?? '',
      url: a.url,
      score: a.positive_reactions_count,
    }));
  } catch (err) {
    console.error('Dev.to scrape failed:', err);
    return [];
  }
}
```

**Step 4: Update `src/research/loop.ts` to include new sources**

```typescript
const [redditPosts, hnPosts, bravePosts, devtoPosts] = await Promise.all([
  scrapeReddit(), scrapeHN(), scrapeBraveSearch(), scrapeDevTo()
]);
const allPosts = [...redditPosts, ...hnPosts, ...bravePosts, ...devtoPosts];
```

**Verify:** `npx tsc --noEmit` — zero errors.
**Commit:** `git commit -m "feat: expand research sources — 15 subreddits, Brave Search, Dev.to"`

---

## Task 3: Tune Scorer for Jake's Market

**What:** The scorer is currently generic B2B SaaS. Tune it to focus on local service businesses and AI automation opportunities relevant to Jake.

**Files:**
- Modify: `src/research/scorer.ts` — update `SCORING_SYSTEM_PROMPT`

Replace `SCORING_SYSTEM_PROMPT` with:

```typescript
const SCORING_SYSTEM_PROMPT = `You are an opportunity evaluator for a solo founder focused on B2B SaaS for local service businesses (HVAC, plumbing, electrical, construction, home services) and AI automation tools for small business owners.

Score each post 0-100 based on:
- Pain clarity: Is there a clear, recurring business pain expressed? (0-35 pts)
- Payment signal: Do people mention paying for something, mention a budget, or say they'd pay? (0-35 pts)
- Market fit: Is this relevant to local service businesses, contractors, or small B2B SaaS? (0-20 pts)
- Market gap: No obvious dominant solution under $100/mo already solving this? (0-10 pts)

Respond with JSON only, no markdown:
{"score": 0, "summary": "one sentence describing the opportunity and why it scores this way"}

Score < 40 = not worth pursuing. Still return valid JSON.`;
```

**Verify:** `npx tsc --noEmit` — zero errors.
**Commit:** `git commit -m "feat: tune research scorer for local service business market"`

---

## Task 4: Real Playwright via Browserbase

**What:** Replace the current `browse_web` Jina.ai implementation with Browserbase — a managed cloud browser. Playwright connects to a remote browser session. No install, no timeout, supports clicking, form filling, CSS inspection, screenshots.

**Files:**
- Modify: `src/tools/browser.ts` — add `interactWithPage()` for Playwright-level tasks
- Modify: `src/brain.ts` — add `playwright` tool schema + executor
- Modify: `src/tools/registry.ts` — add `playwright` entry

**Step 1: Update `src/tools/browser.ts`**

Keep `browseUrl` (Jina.ai) for fast text extraction. Add `interactWithPage` for interactive tasks:

```typescript
export interface InteractResult {
  url: string;
  result: string;
  error?: string;
}

/**
 * Run a Playwright script against a live browser via Browserbase.
 * Use for: clicking, form filling, CSS inspection, screenshots, JS execution.
 * `instructions` is what to do on the page (Claude generates the Playwright code).
 * `playwrightCode` is the actual Playwright JS to run (Claude writes this).
 */
export async function interactWithPage(url: string, playwrightCode: string): Promise<InteractResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    return { url, result: '', error: 'BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set' };
  }

  // Create a Browserbase session
  const sessionRes = await fetch('https://www.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BB-API-Key': apiKey,
    },
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(15000),
  });

  if (!sessionRes.ok) {
    return { url, result: '', error: `Browserbase session failed: ${sessionRes.status}` };
  }

  const session = await sessionRes.json() as { id: string; connectUrl: string };

  // Run the Playwright code in E2B with the remote browser URL
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP(${JSON.stringify(session.connectUrl)});
  const page = await browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });

  // User-provided Playwright code runs here
  ${playwrightCode}

  await browser.close();
})().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
`;

  const { runShell } = await import('./shell.js');
  const result = await runShell(
    ['npm install playwright --quiet', 'node script.js'],
    [{ path: 'script.js', content: script }]
  );

  const lastStderr = result.stderr.split('\n').filter(l => l.trim()).at(-1) ?? '';
  if (result.exitCode !== 0 || lastStderr.includes('"error"')) {
    let errMsg = lastStderr;
    try { errMsg = JSON.parse(lastStderr).error ?? lastStderr; } catch {}
    return { url, result: '', error: errMsg };
  }

  return { url, result: result.stdout || 'Done.' };
}
```

Note: Playwright connected over CDP doesn't need Chromium installed — it connects to the remote browser. Only the `playwright` npm package is needed (much faster install, no browser binary download).

**Step 2: Add `playwright` tool to `src/brain.ts`**

Add to `TOOL_SCHEMAS`:
```typescript
  playwright: {
    name: 'playwright',
    description: 'Run interactive Playwright browser automation on a live page. Use for: clicking buttons, filling forms, inspecting CSS/computed styles, taking screenshots, executing JavaScript, testing flows. Write the Playwright code to run after page.goto().',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        playwright_code: { type: 'string', description: 'Playwright JS code to run after page.goto(). Use page.* methods. console.log() results — they will be returned.' },
      },
      required: ['url', 'playwright_code'],
    },
  },
```

Add import:
```typescript
import { browseUrl, interactWithPage } from './tools/browser.js';
```

Add case to `executeTool()`:
```typescript
    case 'playwright': {
      const url = input.url as string;
      const playwrightCode = input.playwright_code as string;
      const result = await interactWithPage(url, playwrightCode);
      if (result.error) {
        return { toolName: name, output: `Playwright failed: ${result.error}` };
      }
      return { toolName: name, output: result.result };
    }
```

**Step 3: Add `playwright` to `src/tools/registry.ts`**

```typescript
  {
    id: 'playwright',
    name: 'Playwright Browser Automation',
    description: 'Interactive browser automation — click, fill forms, inspect CSS, run JS on live pages',
    installed: true,
    requiresEnv: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  },
```

**Verify:** `npx tsc --noEmit` — zero errors.
**Commit:** `git commit -m "feat: add Playwright tool via Browserbase (interactive browser automation)"`

---

## Task 5: Push and Verify

```bash
git push
```

Wait ~2 min for Railway deploy, then test in Discord:

1. **Dedup test** — run the research loop twice, confirm no duplicates in `#research`
2. **New sources test** — check `#research` for posts from r/hvacr, r/Plumbing, etc.
3. **Playwright test** — say "check the CSS color of the main button on apple.com" — Jarvis should use the `playwright` tool and return actual computed styles
4. **browse_web test** — say "summarize the front page of news.ycombinator.com" — Jarvis should use Jina.ai (fast, text only)

---

## Why Browserbase Instead of Raw E2B+Playwright

| Approach | Install time | Cost | Interactive |
|----------|-------------|------|-------------|
| E2B + playwright install | 3-5 min (timeout) | E2B credits | Yes |
| Jina.ai (current browse_web) | Instant | Free | No (text only) |
| Browserbase | ~10s (just npm package) | Free tier: 1000 sessions/mo | Yes — full Playwright |
