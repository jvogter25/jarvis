# Jarvis Tools Expansion: Playwright + Shell Executor + Self-Expand

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Jarvis explicit tool-calling capabilities (browser automation, shell execution, self-expansion) by migrating the brain from freeform text output to a proper Claude tool_use agentic loop.

**Architecture:** Replace the fragile "regex-detect HTML in response" pattern with a proper Claude tool_use loop: Claude explicitly calls `deploy_html`, `run_shell`, `browse_web`, or `request_tool_install` tools. The handler executes each tool call and feeds results back to Claude. For tools not yet installed, Jarvis asks Jake's permission via Discord, then self-modifies by pushing code to GitHub (triggering a Railway auto-deploy).

**Tech Stack:** @anthropic-ai/sdk tool_use API, E2B v1.0.7 (sandboxed Playwright + shell), octokit (GitHub push for self-modify), Supabase (pending approval state), discord.js v14

---

## Existing Code Context

Key files to understand before touching anything:

- `src/brain.ts` — calls Claude API, currently text-only, `max_tokens: 2048`, no tools
- `src/discord/handlers.ts` — receives Discord messages, calls `routeToAgent()` then `think()`, then tries regex to find HTML (this is what we're replacing)
- `src/agents/router.ts` — routes to specialist agent or returns null for general chat
- `src/sandbox/client.ts` — E2B integration: `runInSandbox(files, startCommand, port)` and `serveHtml(html)`
- `src/github/client.ts` — `upsertFile(repo, path, content, message)` for GitHub pushes
- `src/memory/supabase.ts` — Supabase client, message CRUD, system prompt CRUD

The GitHub repo name is `jarvis` and owner is from `process.env.GITHUB_OWNER` (value: `jvogter25`).

---

## Task 1: E2B Shell Executor

**What:** A tool that runs arbitrary shell commands inside an E2B sandbox and returns stdout/stderr. This is the foundation for Playwright (which runs inside E2B).

**Files:**
- Create: `src/tools/shell.ts`

**Step 1: Create `src/tools/shell.ts`**

```typescript
import { Sandbox } from 'e2b';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run shell commands sequentially inside an E2B sandbox.
 * Optional files are written before commands run.
 * Timeout: 5 minutes.
 */
export async function runShell(
  commands: string[],
  inputFiles: { path: string; content: string }[] = []
): Promise<ShellResult> {
  const sandbox = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 5 * 60 * 1000,
  });

  // Write input files if any
  for (const file of inputFiles) {
    await sandbox.files.write(file.path, file.content);
  }

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let lastExitCode = 0;

  for (const cmd of commands) {
    const result = await sandbox.commands.run(cmd);
    if (result.stdout) stdoutParts.push(result.stdout);
    if (result.stderr) stderrParts.push(result.stderr);
    lastExitCode = result.exitCode ?? 0;
  }

  await sandbox.kill();

  return {
    stdout: stdoutParts.join('\n').trim(),
    stderr: stderrParts.join('\n').trim(),
    exitCode: lastExitCode,
  };
}
```

**Step 2: Verify it compiles**

```bash
cd /Users/JakeLaylo/jarvis
npx tsc --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tools/shell.ts
git commit -m "feat: add E2B shell executor tool"
```

---

## Task 2: Playwright Browser Tool (runs inside E2B)

**What:** Jarvis can navigate to a URL, scrape text content, and extract structured data — all running inside an E2B sandbox so no local browser binaries are needed on Railway.

**Files:**
- Create: `src/tools/browser.ts`

**Step 1: Create `src/tools/browser.ts`**

```typescript
import { runShell } from './shell.js';

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  error?: string;
}

/**
 * Navigate to a URL and extract text content using Playwright inside E2B.
 * `task` is a natural-language description of what to extract (passed to the script as context).
 */
export async function browseUrl(url: string, task: string): Promise<BrowseResult> {
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const content = await page.evaluate(() => document.body.innerText);
  console.log(JSON.stringify({ title, content: content.slice(0, 8000) }));
  await browser.close();
})().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
`;

  const result = await runShell(
    [
      'npm install playwright --save-quiet 2>/dev/null',
      'npx playwright install chromium --with-deps 2>/dev/null',
      'node script.js',
    ],
    [{ path: 'script.js', content: script }]
  );

  if (result.exitCode !== 0 || result.stderr.includes('"error"')) {
    let errMsg = result.stderr;
    try { errMsg = JSON.parse(result.stderr).error; } catch {}
    return { url, title: '', content: '', error: errMsg };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return { url, title: parsed.title ?? '', content: parsed.content ?? '' };
  } catch {
    return { url, title: '', content: result.stdout };
  }
}
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/tools/browser.ts
git commit -m "feat: add Playwright browser tool via E2B sandbox"
```

---

## Task 3: Tool Registry

**What:** A single source of truth for what tools Jarvis currently has (installed) vs what it knows about but hasn't installed yet (installable). Claude uses this to decide what to offer.

**Files:**
- Create: `src/tools/registry.ts`

**Step 1: Create `src/tools/registry.ts`**

```typescript
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  requiresEnv?: string[];   // env vars that must be set
}

export const TOOLS: ToolDefinition[] = [
  {
    id: 'deploy_html',
    name: 'Deploy HTML',
    description: 'Deploy a complete HTML page to a live public URL via E2B sandbox',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'run_shell',
    name: 'Run Shell Commands',
    description: 'Execute arbitrary shell commands in a sandboxed environment and return output',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'browse_web',
    name: 'Browse Web',
    description: 'Navigate to any URL and extract text content, titles, and page data using a real browser',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Push files to GitHub repos, create PRs, list repositories',
    installed: true,
    requiresEnv: ['GITHUB_TOKEN'],
  },
];

export function getInstalledTools(): ToolDefinition[] {
  return TOOLS.filter(t => {
    if (!t.installed) return false;
    if (t.requiresEnv) {
      return t.requiresEnv.every(v => !!process.env[v]);
    }
    return true;
  });
}

export function getTool(id: string): ToolDefinition | undefined {
  return TOOLS.find(t => t.id === id);
}
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat: add tool registry"
```

---

## Task 4: Agentic Brain with Tool Loop

**What:** Refactor `src/brain.ts` from text-only → Claude tool_use. Claude can now explicitly call `deploy_html`, `run_shell`, `browse_web`, and `request_tool_install`. The brain loops until Claude stops requesting tool calls. This replaces the fragile regex-based HTML detection.

**Files:**
- Modify: `src/brain.ts`

**Step 1: Replace `src/brain.ts` entirely**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase.js';
import { serveHtml } from './sandbox/client.js';
import { runShell } from './tools/shell.js';
import { browseUrl } from './tools/browser.js';
import { getInstalledTools } from './tools/registry.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Claude tool definitions (subset of installed tools that have Claude-facing APIs)
const TOOL_SCHEMAS: Record<string, Anthropic.Tool> = {
  deploy_html: {
    name: 'deploy_html',
    description: 'Deploy a complete HTML page to a live public sandbox URL. Use this whenever you produce a finished HTML page — never paste raw HTML in the chat.',
    input_schema: {
      type: 'object' as const,
      properties: {
        html: { type: 'string', description: 'The complete HTML document to deploy' },
        title: { type: 'string', description: 'Short title for the page (for confirmation message)' },
      },
      required: ['html'],
    },
  },
  run_shell: {
    name: 'run_shell',
    description: 'Run shell commands in a sandboxed environment. Use for code execution, package installs, file processing, data transforms, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'Shell commands to run sequentially' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          description: 'Optional files to write before running commands',
        },
      },
      required: ['commands'],
    },
  },
  browse_web: {
    name: 'browse_web',
    description: 'Navigate to a URL with a real browser and extract page content, text, titles. Use for research, competitor analysis, audits.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to visit' },
        task: { type: 'string', description: 'What to extract or analyze from the page' },
      },
      required: ['url', 'task'],
    },
  },
  request_tool_install: {
    name: 'request_tool_install',
    description: 'Request installation of a capability you need but do not currently have. This will ask Jake for permission before installing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        capability: { type: 'string', description: 'What capability you need (e.g. "Stripe API", "Twilio SMS")' },
        reason: { type: 'string', description: 'Why you need it for this specific task' },
      },
      required: ['capability', 'reason'],
    },
  },
};

export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;  // set when deploy_html succeeds
  installRequest?: { capability: string; reason: string }; // set when install requested
}

export interface ThinkResult {
  text: string;
  toolResults: ToolCallResult[];
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
  switch (name) {
    case 'deploy_html': {
      const html = input.html as string;
      const title = (input.title as string) ?? 'page';
      try {
        const { url } = await serveHtml(html);
        return { toolName: name, output: `Deployed successfully to ${url}`, deployedUrl: url };
      } catch (err) {
        return { toolName: name, output: `Deploy failed: ${(err as Error).message}` };
      }
    }

    case 'run_shell': {
      const commands = input.commands as string[];
      const files = (input.files as { path: string; content: string }[]) ?? [];
      const result = await runShell(commands, files);
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
        `exit code: ${result.exitCode}`,
      ].filter(Boolean).join('\n\n');
      return { toolName: name, output };
    }

    case 'browse_web': {
      const url = input.url as string;
      const task = input.task as string;
      const result = await browseUrl(url, task);
      if (result.error) {
        return { toolName: name, output: `Browse failed: ${result.error}` };
      }
      return { toolName: name, output: `Title: ${result.title}\n\nContent:\n${result.content}` };
    }

    case 'request_tool_install': {
      const capability = input.capability as string;
      const reason = input.reason as string;
      return {
        toolName: name,
        output: `Install request noted for: ${capability}`,
        installRequest: { capability, reason },
      };
    }

    default:
      return { toolName: name, output: `Unknown tool: ${name}` };
  }
}

/**
 * Run Claude with tool support. Loops until Claude stops requesting tool calls.
 * Returns final text response + list of all tool results (for handler to act on).
 */
export async function think(
  systemPrompt: string,
  history: Message[],
  userMessage: string
): Promise<ThinkResult> {
  const installedToolIds = new Set(getInstalledTools().map(t => t.id));
  // Always include request_tool_install; add others only if installed + have env
  const activeToolSchemas: Anthropic.Tool[] = [
    TOOL_SCHEMAS.request_tool_install,
    ...Object.values(TOOL_SCHEMAS).filter(
      t => t.name !== 'request_tool_install' && installedToolIds.has(t.name)
    ),
  ];

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const allToolResults: ToolCallResult[] = [];
  let iterations = 0;
  const MAX_ITERATIONS = 10; // prevent infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools: activeToolSchemas,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      // Done — extract text response
      const textBlock = response.content.find(b => b.type === 'text');
      return {
        text: textBlock?.type === 'text' ? textBlock.text : '',
        toolResults: allToolResults,
      };
    }

    // Execute all tool calls in this response
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input as Record<string, unknown>);
      allToolResults.push(result);
      toolResultContent.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.output,
      });
    }

    // Feed results back to Claude
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultContent });
  }

  return { text: 'Tool execution limit reached.', toolResults: allToolResults };
}
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. If there are type errors on `Anthropic.Tool` or `ToolResultBlockParam`, check the SDK version in package.json — it should be `^0.39.0`.

**Step 3: Commit**

```bash
git add src/brain.ts
git commit -m "feat: agentic brain with tool_use loop (deploy_html, run_shell, browse_web, request_tool_install)"
```

---

## Task 5: Update Handler for ThinkResult + Install Approval Flow

**What:** The handler now receives a `ThinkResult` instead of a plain string. It:
1. Posts Claude's text response (if any)
2. Posts deployed URLs from `deploy_html` tool results
3. Detects `request_tool_install` results and posts a permission request to Discord
4. On next message, checks if Jake approved (yes/yeah/do it/sure) and confirms installation

**Note on self-modify:** We are NOT doing full automated self-modify yet (that's Task 6). For now, when Jake approves a tool install, Jarvis tells him to ask here in Claude Code to wire it in. The infrastructure is in place; the self-modify loop is a follow-on.

**Files:**
- Modify: `src/discord/handlers.ts`

**Step 1: Replace `src/discord/handlers.ts` entirely**

```typescript
import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

/** Keep sending typing indicator every 8s until done */
function keepTyping(channel: SendableChannel): () => void {
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

// In-memory: track if we're waiting for install approval
// Maps channelId → { capability, reason }
const pendingInstallRequest = new Map<string, { capability: string; reason: string }>();

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'install it', 'ok', 'okay', 'absolutely', 'y']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'cancel', 'nevermind', 'never mind', 'skip', 'n']);

function isAffirmative(text: string): boolean {
  return YES_WORDS.has(text.toLowerCase().trim());
}

function isNegative(text: string): boolean {
  return NO_WORDS.has(text.toLowerCase().trim());
}

export async function handleMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNELS.JARVIS) return;
  if (!isSendable(msg.channel)) return;

  console.log(`Message received: "${msg.content.slice(0, 60)}"`);

  // Check if we're waiting for install approval
  const pending = pendingInstallRequest.get(msg.channelId);
  if (pending) {
    if (isAffirmative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(
        `Got it. To add **${pending.capability}** to my capabilities, ask in Claude Code: "Add ${pending.capability} to Jarvis". It takes a few minutes to build and deploy. I'll be ready after.`
      );
      return;
    } else if (isNegative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(`No problem — skipping the ${pending.capability} install. What else can I help with?`);
      return;
    }
    // Not a yes/no — fall through to normal handling (clear the pending request)
    pendingInstallRequest.delete(msg.channelId);
  }

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    console.log('Fetching history...');
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', msg.content);

    console.log('Routing to agent...');
    const agentResponse = await routeToAgent(msg.content);

    let replyText: string;
    if (agentResponse) {
      console.log('Agent responded');
      replyText = agentResponse;
      stopTyping();
      await saveMessage(msg.channelId, 'assistant', replyText);
      for (const chunk of splitMessage(replyText)) {
        await msg.channel.send(chunk);
      }
      return;
    }

    console.log('Using brain...');
    const systemPrompt = await getSystemPrompt();
    const result = await think(systemPrompt, history, msg.content);
    stopTyping();

    replyText = result.text;
    await saveMessage(msg.channelId, 'assistant', replyText);

    // Post text response (if any)
    if (replyText.trim()) {
      for (const chunk of splitMessage(replyText)) {
        await msg.channel.send(chunk);
      }
    }

    // Handle tool results
    for (const toolResult of result.toolResults) {
      if (toolResult.deployedUrl) {
        await msg.channel.send(`✅ Live preview: ${toolResult.deployedUrl}`);
      }
      if (toolResult.installRequest) {
        const { capability, reason } = toolResult.installRequest;
        pendingInstallRequest.set(msg.channelId, { capability, reason });
        await msg.channel.send(
          `To do that I need **${capability}** — which I don't have yet.\n\n**Reason:** ${reason}\n\nWant me to get that installed? (yes/no)`
        );
      }
    }

    // Fallback: if no text and no tool results produced output
    if (!replyText.trim() && result.toolResults.length === 0) {
      await msg.channel.send('Done.');
    }

  } catch (err) {
    stopTyping();
    console.error('Error handling message:', err);
    await msg.channel.send('⚠️ Something went wrong. Check the logs.');
  }
}
```

**Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. Common error: `think()` now returns `ThinkResult` not `string` — router.ts still uses old `think()` call, fix if needed (see Task 4 note below).

**IMPORTANT:** `routeToAgent()` in `router.ts` calls `think()` directly. After Task 4, `think()` returns `ThinkResult`, not `string`. Update `router.ts` to call `.text` on the result:

```typescript
// In src/agents/router.ts — update these two lines:
const agentId = (await think(routingSystemPrompt, [], userMessage)).text.trim();
// ...
return (await think(agent.systemPrompt, [], userMessage)).text;
```

**Step 3: Update router.ts**

Open `src/agents/router.ts` and change:
```typescript
const agentId = (await think(routingSystemPrompt, [], userMessage)).trim();
```
to:
```typescript
const agentId = (await think(routingSystemPrompt, [], userMessage)).text.trim();
```

And change:
```typescript
return think(agent.systemPrompt, [], userMessage);
```
to:
```typescript
return (await think(agent.systemPrompt, [], userMessage)).text;
```

**Step 4: Verify everything compiles clean**

```bash
npx tsc --noEmit
```

Expected: No errors at all.

**Step 5: Commit**

```bash
git add src/discord/handlers.ts src/agents/router.ts
git commit -m "feat: handler uses ThinkResult, tool install approval flow, deploy_html posts URL directly"
```

---

## Task 6: Deploy and Verify

**Step 1: Push to GitHub to trigger Railway deploy**

```bash
git push
```

**Step 2: Wait ~2 min, then watch logs**

```bash
RAILWAY_TOKEN=e3f04af9-a910-48ad-8706-199244820638 railway logs --service jarvis
```

Expected startup sequence:
```
Jarvis starting...
Loaded 61 agents
Jarvis online.
Discord connected as Jarvis#7662
```

**Step 3: Test deploy_html**

In Discord `#jarvis` channel, send:
```
Build me a simple landing page for South Bay Digital
```

Expected behavior:
1. Typing indicator appears immediately
2. Jarvis responds with a short text message (no raw HTML in chat)
3. A "✅ Live preview: https://..." message appears

**Step 4: Test browse_web**

In Discord:
```
What's the title and main headline on apple.com?
```

Expected: Jarvis visits apple.com via E2B Playwright, returns the actual page content.

**Step 5: Test request_tool_install**

In Discord:
```
Can you send me an SMS with the South Bay Digital pricing?
```

Expected: Jarvis replies "To do that I need **Twilio SMS** — which I don't have yet. Want me to get that installed? (yes/no)"

Say "yes" → Jarvis tells you to ask Claude Code to wire it in.

**Step 6: Commit nothing — deploy was the step**

---

## What This Unlocks

After this plan is complete, Jarvis can:
- **Deploy any HTML to a live URL** — explicitly, no regex guessing
- **Run arbitrary code/scripts** — data processing, file transforms, package installs
- **Browse any website** — competitor research, audits, scraping, GHL flow testing
- **Ask permission to expand** — self-aware about what it can't do, asks before acting
- **Handle 8192 token responses** — long pages, complex HTML, no truncation

The next step after this is the full self-modify loop (Jarvis pushes its own code to GitHub), but the install approval conversation is already wired — just need the installer code.
