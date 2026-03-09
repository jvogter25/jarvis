# Wave 6: Jarvis Self-Modification + Tool Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Jarvis can modify its own codebase from Discord — Opus writes and reviews all code, Jake approves intent in plain English, never reviews diffs.

**Architecture:** A new `self_modify_request` tool in `brain.ts` triggers Opus to generate + review code. A smart gate routes safe changes (new files only) to direct push, and core changes (edits to existing files) through a GitHub PR. A weekly Friday cron scrapes for new tools and posts a digest to `#engineering`. Jake can also paste any URL into `#jarvis` and get an instant tool evaluation.

**Tech Stack:** TypeScript/ESM, Anthropic SDK (Opus for all codegen + review), Octokit (branch + PR creation), node-cron, Discord.js, Brave Search API

---

## Context for the implementer

This is a TypeScript ESM project. All local imports **must use `.js` extensions** (e.g. `import { think } from '../brain.js'`). The project runs on Railway — pushes to `main` trigger auto-redeploy.

Key files to understand before starting:
- `src/brain.ts` — Claude API loop. Has `think()`, `TOOL_SCHEMAS`, `executeTool()`, `ToolCallResult`. The `request_tool_install` tool is hardcoded as always-available at line 296.
- `src/tools/self-modify.ts` — **exists but needs a full rewrite**. Currently pushes directly to main with pre-defined INSTALL_PLANS. Wave 6 replaces this with Opus codegen + smart gate.
- `src/discord/handlers.ts` — message routing. Has `pendingInstallRequest` and `pendingStagingApproval` maps. We add a third: `pendingPRApproval`.
- `src/github/client.ts` — has `upsertFile`, `createPR`, `createBranch`, `getFileContent`. All already implemented.
- `src/overnight/product-pulse.ts` — example of a cron task to model `tool-discovery.ts` after.
- `src/index.ts` — cron schedule. Add Friday 9am tool discovery here.
- `src/tools/registry.ts` — tool definitions. Add `self_modify_request` here.

**CORE_FILES** (edits to these always require a PR, never direct push):
`src/brain.ts`, `src/discord/handlers.ts`, `src/index.ts`, `src/tools/builder.ts`, `src/memory/supabase.ts`, `src/overnight/trainer.ts`, `src/tools/registry.ts`, `src/discord/channels.ts`

No test suite exists — verify by running `npx tsc --noEmit` and checking for TypeScript errors.

---

### Task 1: Rewrite `src/tools/self-modify.ts`

**Files:**
- Modify: `src/tools/self-modify.ts` (full rewrite)

**Step 1: Replace the entire file with this implementation**

```typescript
import { upsertFile, createPR, createBranch } from '../github/client.js';
import { think } from '../brain.js';

// Files that must go through a PR — never direct push to main
const CORE_FILES = new Set([
  'src/brain.ts',
  'src/discord/handlers.ts',
  'src/index.ts',
  'src/tools/builder.ts',
  'src/memory/supabase.ts',
  'src/overnight/trainer.ts',
  'src/tools/registry.ts',
  'src/discord/channels.ts',
]);

export interface SelfModifyPlan {
  files: Array<{ path: string; content: string }>;
  npmPackage?: string;
  envVarName?: string;
  reviewNotes: string;
  isCoreChange: boolean;
  prBranch?: string;
}

export interface SelfModifyResult {
  success: boolean;
  message: string;
  plan?: SelfModifyPlan;
}

async function generateAndReviewCode(intent: string): Promise<SelfModifyPlan> {
  // Step 1: Opus writes the code
  const writePrompt = `You are a TypeScript/Node.js expert writing production code for Jarvis, an AI orchestrator running on Railway (Node.js ESM).

Jarvis repo structure:
- src/brain.ts — Claude API loop, tool schemas and executors
- src/discord/handlers.ts — Discord message routing and approval flows
- src/tools/ — individual tool files (shell.ts, browser.ts, search.ts, builder.ts, slack.ts, self-modify.ts, etc.)
- src/memory/supabase.ts — Supabase queries
- src/overnight/ — cron tasks (trainer.ts, briefing.ts, product-pulse.ts, tool-discovery.ts)
- src/github/client.ts — GitHub API helpers
- src/index.ts — main entry, cron schedule
- src/tools/registry.ts — tool definitions list

CRITICAL: All local imports must use .js extensions (ESM). Use process.env.X for all secrets. No hardcoded values.

Task: ${intent}

Write all necessary TypeScript files to implement this. Return JSON only, no markdown:
{
  "files": [{"path": "src/tools/resend.ts", "content": "...complete file content..."}],
  "npmPackage": "resend",
  "envVarName": "RESEND_API_KEY",
  "summary": "plain-English 1-sentence summary of what was built"
}
If no npm package is needed, omit "npmPackage". If no env var is needed, omit "envVarName".`;

  const writeResult = await think(
    'You are a TypeScript expert building production tools for an AI orchestrator.',
    [],
    writePrompt,
    { model: 'opus', noTools: true }
  );

  let generated: {
    files: Array<{ path: string; content: string }>;
    npmPackage?: string;
    envVarName?: string;
    summary: string;
  };
  try {
    generated = JSON.parse(writeResult.text);
  } catch {
    throw new Error(`Opus failed to return valid JSON. Raw: ${writeResult.text.slice(0, 200)}`);
  }

  // Step 2: Opus reviews the generated code
  const fileContents = generated.files
    .map(f => `// ${f.path}\n${f.content}`)
    .join('\n\n---\n\n');

  const reviewPrompt = `Review this TypeScript code that will be pushed to a production Railway server running an AI Discord bot.

Files to review:
${fileContents.slice(0, 15000)}

Check for:
1. TypeScript/ESM correctness (all local imports have .js extensions, proper async/await, no missing types)
2. Security issues (no hardcoded secrets, proper process.env usage)
3. Error handling (async functions wrapped in try/catch where appropriate)
4. Correct integration patterns (matches the Jarvis codebase style)

Return JSON only, no markdown:
{
  "approved": true,
  "notes": "one sentence summary of review outcome",
  "fixes": []
}
If fixes are needed, include corrected file objects in "fixes": [{"path": "...", "content": "...complete corrected content..."}]`;

  const reviewResult = await think(
    'You are a senior TypeScript engineer reviewing production code for correctness and safety.',
    [],
    reviewPrompt,
    { model: 'opus', noTools: true }
  );

  let review: { approved: boolean; notes: string; fixes?: Array<{ path: string; content: string }> };
  try {
    review = JSON.parse(reviewResult.text);
  } catch {
    // If review parsing fails, proceed with original files
    review = { approved: true, notes: 'Review parse failed — proceeding with generated code.' };
  }

  // Apply fixes if reviewer found issues
  let finalFiles = [...generated.files];
  if (review.fixes && review.fixes.length > 0) {
    for (const fix of review.fixes) {
      const idx = finalFiles.findIndex(f => f.path === fix.path);
      if (idx >= 0) finalFiles[idx] = fix;
      else finalFiles.push(fix);
    }
  }

  // Determine if any file is a protected core file
  const isCoreChange = finalFiles.some(f => CORE_FILES.has(f.path));

  return {
    files: finalFiles,
    npmPackage: generated.npmPackage,
    envVarName: generated.envVarName,
    reviewNotes: review.notes,
    isCoreChange,
    ...(isCoreChange ? { prBranch: `self-modify/${Date.now()}` } : {}),
  };
}

/**
 * Generate code for an intent and return a proposal for Jake to approve.
 * Does NOT push anything yet — caller stores the plan and waits for approval.
 */
export async function requestSelfModify(intent: string): Promise<SelfModifyResult> {
  try {
    console.log(`[self-modify] Generating code for: ${intent}`);
    const plan = await generateAndReviewCode(intent);

    const fileList = plan.files.map(f => `\`${f.path}\``).join(', ');
    const pkgNote = plan.npmPackage ? ` + add \`${plan.npmPackage}\` to package.json` : '';
    const envNote = plan.envVarName
      ? ` You'll need to add \`${plan.envVarName}\` to Railway env vars to activate it.`
      : '';

    let message: string;
    if (plan.isCoreChange) {
      message =
        `This requires editing core files. Opus reviewed it — ${plan.reviewNotes}.\n\n` +
        `Files: ${fileList}${pkgNote}.${envNote}\n\n` +
        `Say **ship it** and I'll open a PR — Railway redeploys on merge.`;
    } else {
      message =
        `I'll create ${fileList}${pkgNote}. Opus reviewed it — ${plan.reviewNotes}.${envNote}\n\n` +
        `Want me to ship it? (yes/no)`;
    }

    return { success: true, message, plan };
  } catch (err) {
    console.error('[self-modify] Failed:', err);
    return { success: false, message: `Failed to generate code: ${(err as Error).message}` };
  }
}

/**
 * Execute an approved SelfModifyPlan — push files to GitHub.
 * Safe changes push directly to main. Core changes open a PR on a branch.
 */
export async function executeSelfModifyPlan(
  plan: SelfModifyPlan
): Promise<{ success: boolean; message: string; prUrl?: string }> {
  try {
    if (plan.isCoreChange && plan.prBranch) {
      // Create branch from main
      await createBranch('jarvis', plan.prBranch);

      // Push all files to the branch
      for (const file of plan.files) {
        console.log(`[self-modify] Pushing ${file.path} to branch ${plan.prBranch}`);
        await upsertFile(
          'jarvis',
          file.path,
          file.content,
          `feat: ${plan.prBranch}`,
          plan.prBranch
        );
      }

      if (plan.npmPackage) {
        await addNpmDependency(plan.npmPackage, plan.prBranch);
      }

      const prUrl = await createPR(
        'jarvis',
        `feat: ${plan.prBranch.replace('self-modify/', 'auto-')}`,
        `Auto-generated by Jarvis self-modification pipeline.\n\nOpus review: ${plan.reviewNotes}`,
        plan.prBranch,
        'main'
      );

      const envNote = plan.envVarName
        ? ` Add \`${plan.envVarName}\` to Railway env vars after merging.`
        : '';
      return {
        success: true,
        message: `PR opened: ${prUrl}${envNote} Railway redeploys automatically on merge.`,
        prUrl,
      };
    } else {
      // Safe change — push directly to main
      for (const file of plan.files) {
        console.log(`[self-modify] Pushing ${file.path} to main`);
        await upsertFile(
          'jarvis',
          file.path,
          file.content,
          `feat: auto-install ${file.path}`
        );
      }

      if (plan.npmPackage) {
        await addNpmDependency(plan.npmPackage);
      }

      const envNote = plan.envVarName
        ? ` Add \`${plan.envVarName}\` to Railway env vars to activate it.`
        : '';
      return {
        success: true,
        message: `Pushed ${plan.files.length} file(s) to GitHub. Railway is rebuilding (~2 min).${envNote}`,
      };
    }
  } catch (err) {
    return { success: false, message: `Execution failed: ${(err as Error).message}` };
  }
}

async function addNpmDependency(packageName: string, branch?: string): Promise<void> {
  const { Octokit } = await import('octokit');
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const owner = process.env.GITHUB_OWNER!;

  const getParams = branch
    ? { owner, repo: 'jarvis', path: 'package.json', ref: branch }
    : { owner, repo: 'jarvis', path: 'package.json' };

  const { data } = await octokit.rest.repos.getContent(getParams);
  if (Array.isArray(data) || data.type !== 'file') throw new Error('package.json not found');

  const raw = Buffer.from(data.content, 'base64').toString('utf-8');
  const pkg = JSON.parse(raw);
  pkg.dependencies[packageName] = 'latest';

  await upsertFile(
    'jarvis',
    'package.json',
    JSON.stringify(pkg, null, 2) + '\n',
    `feat: add ${packageName} dependency`,
    branch
  );
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to self-modify.ts)

**Step 3: Commit**

```bash
git add src/tools/self-modify.ts
git commit -m "feat: rewrite self-modify with Opus codegen + smart gate (Wave 6)"
```

---

### Task 2: Add `self_modify_request` tool to `src/brain.ts`

**Files:**
- Modify: `src/brain.ts`

**Step 1: Add the tool schema**

In `TOOL_SCHEMAS` (after the `build_app` entry, around line 138), add:

```typescript
  self_modify_request: {
    name: 'self_modify_request',
    description: 'Generate and propose a code change to the Jarvis codebase. Use when Jake asks to add a new integration, change behavior, or install a new tool. Also use when Jake pastes a URL for a tool and wants to add it. Opus writes and reviews all code. Jake approves in plain English — never shows diffs. For safe changes (new files only) Jake says yes/no. For core changes (editing existing files) a GitHub PR is opened.',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          description: 'Plain-English description of what to build or change, e.g. "add Resend email integration" or "change research loop to run every 4 hours" or "add Stripe payments tool"',
        },
      },
      required: ['intent'],
    },
  },
```

**Step 2: Add `selfModifyProposal` to `ToolCallResult` interface**

Find the `ToolCallResult` interface (around line 141) and add one field:

```typescript
export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;
  installRequest?: { capability: string; reason: string };
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
  selfModifyProposal?: { plan: import('./tools/self-modify.js').SelfModifyPlan; message: string };
}
```

**Step 3: Add executor case in `executeTool()`**

After the `build_app` case (around line 251), before the `default` case, add:

```typescript
    case 'self_modify_request': {
      const { requestSelfModify } = await import('./tools/self-modify.js');
      const result = await requestSelfModify(input.intent as string);
      return {
        toolName: name,
        output: result.message,
        ...(result.plan ? { selfModifyProposal: { plan: result.plan, message: result.message } } : {}),
      };
    }
```

**Step 4: Replace `request_tool_install` as the always-available tool**

Find this block (around line 293):

```typescript
  const activeToolSchemas: Anthropic.Tool[] = noTools ? [] : (() => {
    const installedToolIds = new Set(getInstalledTools().map(t => t.id));
    return [
      TOOL_SCHEMAS.request_tool_install,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => t.name !== 'request_tool_install' && installedToolIds.has(t.name)
      ),
    ];
  })();
```

Replace with:

```typescript
  const activeToolSchemas: Anthropic.Tool[] = noTools ? [] : (() => {
    const installedToolIds = new Set(getInstalledTools().map(t => t.id));
    return [
      TOOL_SCHEMAS.self_modify_request,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => t.name !== 'self_modify_request' && installedToolIds.has(t.name)
      ),
    ];
  })();
```

**Step 5: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors

**Step 6: Commit**

```bash
git add src/brain.ts
git commit -m "feat: add self_modify_request tool to brain (Wave 6)"
```

---

### Task 3: Add `self_modify_request` to `src/tools/registry.ts`

**Files:**
- Modify: `src/tools/registry.ts`

**Step 1: Add the tool definition**

In the `TOOLS` array (after the `build_app` entry, around line 65), add:

```typescript
  {
    id: 'self_modify_request',
    name: 'Self-Modify',
    description: 'Generate and propose code changes to the Jarvis codebase using Opus',
    installed: true,
    requiresEnv: ['GITHUB_TOKEN'],
  },
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

**Step 3: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat: register self_modify_request in tool registry (Wave 6)"
```

---

### Task 4: Add `pendingPRApproval` state to `src/discord/handlers.ts`

**Files:**
- Modify: `src/discord/handlers.ts`

**Step 1: Add the import for `SelfModifyPlan` and `executeSelfModifyPlan`**

The file already imports `executeSelfModify` and `INSTALL_PLANS` from `self-modify.js`. Replace that import line (around line 6):

Old:
```typescript
import { executeSelfModify, INSTALL_PLANS } from '../tools/self-modify.js';
```

New:
```typescript
import { executeSelfModifyPlan, SelfModifyPlan } from '../tools/self-modify.js';
```

**Step 2: Add `pendingPRApproval` map**

After the `pendingStagingApproval` map declaration (around line 28), add:

```typescript
const pendingPRApproval = new Map<string, {
  plan: SelfModifyPlan;
}>();
```

**Step 3: Replace the `pendingInstallRequest` handler block**

The old handler (around lines 138–161) handled install approvals using `INSTALL_PLANS`. Replace the entire block that checks `pending` (the old `pendingInstallRequest`) with one that handles `pendingPRApproval` instead.

Find this block:
```typescript
  // Check if we're waiting for install approval
  const pending = pendingInstallRequest.get(msg.channelId);
  if (pending) {
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
    } else if (isNegative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(`No problem — skipping the ${pending.capability} install. What else can I help with?`);
      return;
    }
    // Not a yes/no — clear pending and fall through to normal handling
    pendingInstallRequest.delete(msg.channelId);
  }
```

Replace with:
```typescript
  // Check if we're waiting for self-modify approval (yes/no for safe changes, ship it for core PRs)
  const pendingModify = pendingPRApproval.get(msg.channelId);
  if (pendingModify) {
    const approveModify = isShipApproval(msg.content) || isAffirmative(msg.content);
    if (approveModify) {
      pendingPRApproval.delete(msg.channelId);
      await msg.channel.send('Executing the change...');
      try {
        const result = await executeSelfModifyPlan(pendingModify.plan);
        await msg.channel.send(result.message);
        if (result.prUrl) {
          await notifySlackEngineering(`🔧 Self-modify PR opened: ${result.prUrl}`);
        }
      } catch (err) {
        await msg.channel.send(`⚠️ Failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingPRApproval.delete(msg.channelId);
      await msg.channel.send('Cancelled. Let me know if you want to revisit this.');
      return;
    }
    // Conversational — fall through with pending preserved
  }
```

**Step 4: Also remove the now-unused `pendingInstallRequest` map declaration**

Find and remove (around line 26):
```typescript
const pendingInstallRequest = new Map<string, { capability: string; reason: string }>();
```

**Step 5: Handle `selfModifyProposal` in the tool results section**

In the `for (const toolResult of result.toolResults)` loop (around line 242), after the `stagingBuild` block, add:

```typescript
      if (toolResult.selfModifyProposal) {
        pendingPRApproval.set(msg.channelId, { plan: toolResult.selfModifyProposal.plan });
      }
```

**Step 6: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors. If `pendingInstallRequest` is referenced elsewhere in the file, those references also need to be removed.

**Step 7: Commit**

```bash
git add src/discord/handlers.ts
git commit -m "feat: add pendingPRApproval flow to Discord handler (Wave 6)"
```

---

### Task 5: Create `src/overnight/tool-discovery.ts`

**Files:**
- Create: `src/overnight/tool-discovery.ts`

**Step 1: Create the file**

```typescript
import { Client, TextChannel } from 'discord.js';
import { searchWeb } from '../tools/search.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';

const DISCOVERY_QUERIES = [
  '"new MCP server" Claude 2026',
  '"Model Context Protocol" new integration release',
  'new AI agent tool npm package 2026',
  'Claude MCP tool announcement site:twitter.com',
  'new developer API launch 2026 SaaS integration',
];

interface DiscoveredTool {
  name: string;
  url: string;
  whyUseful: string;
  securityNotes: string;
  installComplexity: 'simple' | 'moderate' | 'complex';
  installCommand: string;
}

export async function runToolDiscovery(discord: Client) {
  console.log('Tool discovery: starting...');

  const channel = discord.channels.cache.get(CHANNELS.ENGINEERING) as TextChannel | undefined;
  if (!channel) {
    console.log('Tool discovery: #engineering channel not found, skipping');
    return;
  }

  // Search all queries in parallel
  const searchPromises = DISCOVERY_QUERIES.map(q => searchWeb(q, 5));
  const searchResults = await Promise.all(searchPromises);

  const allResults: Array<{ title: string; url: string; description: string }> = [];
  for (const result of searchResults) {
    if (!result.error) allResults.push(...result.results);
  }

  if (allResults.length === 0) {
    console.log('Tool discovery: no search results');
    return;
  }

  // Deduplicate by URL
  const unique = allResults.filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i);
  console.log(`Tool discovery: ${unique.length} unique results, sending to Opus for evaluation`);

  const evalPrompt = `You are evaluating newly discovered tools and MCPs that Jarvis (an AI orchestrator running on Railway) could integrate.

Jarvis's mission: find, build, and operate B2B SaaS products. Current capabilities: web search, browser automation, GitHub API, Vercel deploy, Slack notifications, E2B code sandbox, Discord bot.

Evaluate these ${Math.min(unique.length, 20)} search results and select the 3-5 most useful and safe tools for Jarvis to add:

${unique.slice(0, 20).map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}`).join('\n\n')}

For each tool you select, return:
- name: short tool name (e.g. "Resend", "Exa", "Loops")
- url: source URL
- whyUseful: 1-2 sentences on what Jarvis could specifically DO with this (be concrete)
- securityNotes: what API access it requires, what data it can read/send
- installComplexity: "simple" (1 new file + API key), "moderate" (2-3 files), or "complex" (core file changes)
- installCommand: exact phrase Jake would say in Discord to install it, e.g. "install resend" or "add exa search"

Only include tools that are:
1. Actually useful for Jarvis's B2B SaaS mission
2. Available as npm packages or well-documented REST APIs
3. Safe (no broad data access, clear API key scope)

Return JSON only, no markdown:
{"tools": [...]}
If nothing is worth recommending this week, return {"tools": []}`;

  try {
    const evalResult = await think(
      'You are a senior engineer evaluating AI tools for safe production integration.',
      [],
      evalPrompt,
      { model: 'opus', noTools: true }
    );

    const { tools } = JSON.parse(evalResult.text) as { tools: DiscoveredTool[] };

    if (tools.length === 0) {
      console.log('Tool discovery: nothing useful found this week');
      return;
    }

    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const lines: string[] = [`**Weekly Tool Digest — ${date}**`, ''];

    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      lines.push(
        `**${i + 1}. ${t.name}**`,
        `Why: ${t.whyUseful}`,
        `Security: ${t.securityNotes}`,
        `Complexity: ${t.installComplexity}`,
        `→ Say \`${t.installCommand}\` in #jarvis to add it.`,
        ''
      );
    }

    await channel.send(lines.join('\n'));
    console.log(`Tool discovery: posted ${tools.length} tools to #engineering`);
  } catch (err) {
    console.error('Tool discovery failed:', err);
  }
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

**Step 3: Commit**

```bash
git add src/overnight/tool-discovery.ts
git commit -m "feat: add weekly tool discovery cron task (Wave 6)"
```

---

### Task 6: Wire up cron in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Step 1: Add the import**

After the `runProductPulse` import (around line 8), add:

```typescript
import { runToolDiscovery } from './overnight/tool-discovery.js';
```

**Step 2: Add the cron schedule**

After the weekly product pulse cron (around line 35), add:

```typescript
  // Weekly tool discovery: Fridays at 9am
  cron.schedule('0 9 * * 5', () => {
    runToolDiscovery(discord).catch(console.error);
  });
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Friday 9am tool discovery cron (Wave 6)"
```

---

### Task 7: Update system prompt in Supabase

**Files:**
- No file changes — update via Supabase SQL Editor

**Step 1: Get the current system prompt**

Run this in Supabase SQL Editor to see the current v4 prompt:
```sql
SELECT content FROM system_prompts ORDER BY version DESC LIMIT 1;
```

**Step 2: Insert new v5 system prompt**

Copy the current v4 content, then add these sections to it and insert as v5. The additions to append to the existing prompt:

```
SELF-MODIFICATION:
- When Jake asks to add a new integration, change Jarvis behavior, or install a tool, call self_modify_request with a clear intent description. Never try to write code in your response — always use the tool.
- When Jake pastes a URL into #jarvis (especially a tool, npm package, GitHub repo, or API), proactively: use browse_web to read it, then call self_modify_request if it looks useful — or describe what you found and ask "Want me to add this?".
- After self_modify_request returns, post the proposal message to Jake. Do not add extra commentary — the proposal message is self-contained.

TOOL DISCOVERY:
- The weekly tool digest is posted automatically to #engineering every Friday. Jake can say "install [tool]" in #jarvis to trigger the self-modify pipeline for any tool from the digest.
```

The SQL to insert v5:
```sql
INSERT INTO system_prompts (version, content)
VALUES (
  5,
  '<paste the full updated prompt here>'
);
```

**Step 3: Verify v5 is active**

```sql
SELECT version, LEFT(content, 100) FROM system_prompts ORDER BY version DESC LIMIT 3;
```

Expected: version 5 appears as the top row.

---

### Task 8: Push to Railway and smoke test

**Step 1: Push all commits**

All 6 commits should already be on `main`. Verify:

```bash
cd /Users/JakeLaylo/jarvis && git log --oneline -8
```

Expected: 6 new Wave 6 commits on top.

**Step 2: Check Railway deployment**

Monitor Railway logs for `Jarvis online.` — confirms clean startup with no TypeScript/import errors.

**Step 3: Smoke test in Discord**

Send in `#jarvis`:
> "Add a Resend email integration so you can send transactional emails from built products"

Expected flow:
1. Jarvis responds: "I'll create `src/tools/resend.ts` + add `resend` to package.json. Opus reviewed it — [review notes]. You'll need to add `RESEND_API_KEY` to Railway env vars. Want me to ship it? (yes/no)"
2. Reply "yes" → Jarvis says "Executing the change..." → "Pushed 2 file(s) to GitHub. Railway is rebuilding (~2 min). Add `RESEND_API_KEY` to Railway env vars to activate it."
3. Check GitHub: `src/tools/resend.ts` and updated `package.json` appear in `jvogter25/jarvis` on `main`.

**Step 4: Smoke test URL paste**

Send in `#jarvis`:
> "https://github.com/modelcontextprotocol/servers — what do you think?"

Expected: Jarvis browses the URL, describes what it found, and offers to add any useful integrations.
