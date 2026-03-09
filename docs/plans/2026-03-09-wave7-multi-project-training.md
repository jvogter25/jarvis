# Wave 7: Multi-Project Workspace + Training System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Jarvis operates isolated per-project Discord workspaces, learns continuously from training material Jake feeds it, and previews builds in E2B sandbox before consuming Vercel deployment slots.

**Architecture:** Per-project system prompts stored in `project_configs` Supabase table; project channels route to project-specific prompts + histories. A `knowledge_base` table stores training material extracted from `#training` channel posts; the overnight trainer folds insights into the global prompt nightly; a `search_knowledge` tool enables on-demand retrieval. Builder splits into Phase 1 (E2B Next.js preview) and Phase 2 (Vercel deploy, only after approval).

**Tech Stack:** Discord.js v14 Guild API (create categories/channels), E2B Sandbox (Node.js/Next.js preview), Supabase (two new tables), Anthropic SDK (haiku for insight extraction, sonnet for routing), Octokit (GitHub repo creation)

---

## Context for the implementer

This is `/Users/JakeLaylo/jarvis` — a TypeScript ESM Node.js Discord bot on Railway. **All local imports must use `.js` extensions.** Key files:

- `src/brain.ts` — Claude API loop. `think()`, `TOOL_SCHEMAS`, `executeTool()`, `ToolCallResult`
- `src/discord/handlers.ts` — message routing. `handleMessage()` currently gatekeeps on `CHANNELS.JARVIS` only
- `src/discord/client.ts` — event router. Currently routes `CHANNELS.DESIGN_ELEMENTS` to `handleDesignMessage`, everything else to `handleMessage`
- `src/discord/channels.ts` — `CHANNELS` object from env vars, `splitMessage()` util
- `src/memory/supabase.ts` — all Supabase queries. Pattern: `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`
- `src/tools/builder.ts` — `buildProject()` currently creates Vercel project immediately. Needs splitting.
- `src/sandbox/client.ts` — `runInSandbox(files, startCommand, port)` and `serveHtml()`. E2B sandbox. Timeout is 5min by default.
- `src/overnight/briefing.ts` — global morning brief, posts to `CHANNELS.MORNING_BRIEF`
- `src/overnight/product-pulse.ts` — posts to `CHANNELS.ENGINEERING` (global). Needs to post to project channel instead.
- `src/research/loop.ts` — global research loop
- `src/tools/registry.ts` — tool definitions for `getInstalledTools()`
- `src/index.ts` — cron schedule

**New env vars needed in Railway:**
- `DISCORD_CHANNEL_TRAINING` — the `#training` channel ID (Jake creates this manually)
- `DISCORD_GUILD_ID` — the Jarvis HQ guild ID (needed to create channels/categories via API)

No test suite — verify with `npx tsc --noEmit` and manual Discord testing.

---

### Task 1: Supabase schema — `knowledge_base` and `project_configs` tables

**Files:**
- Modify: `src/memory/schema.sql`
- Modify: `src/memory/supabase.ts`

**Step 1: Add SQL to schema.sql**

Append to `src/memory/schema.sql`:

```sql
-- Knowledge base: training material Jake feeds Jarvis
CREATE TABLE IF NOT EXISTS knowledge_base (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  domain text NOT NULL, -- 'sales', 'marketing', 'design', 'engineering', 'general'
  source_url text,
  title text NOT NULL,
  content text NOT NULL,
  key_insights jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

-- Project configs: per-project system prompts + Discord channel map
CREATE TABLE IF NOT EXISTS project_configs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  system_prompt text NOT NULL,
  last_synced_at timestamptz DEFAULT now(),
  discord_category_id text NOT NULL,
  channels jsonb NOT NULL DEFAULT '{}',
  github_repo text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

**Step 2: Run in Supabase SQL Editor**

Copy the SQL above and run it in the Supabase dashboard SQL Editor. Also run:
```sql
ALTER TABLE knowledge_base DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_configs DISABLE ROW LEVEL SECURITY;
```

**Step 3: Add helpers to `src/memory/supabase.ts`**

Append these exports to the end of the file:

```typescript
// ─── Knowledge Base ───────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  domain: string;
  source_url?: string;
  title: string;
  content: string;
  key_insights: string[];
  created_at: string;
}

export async function saveKnowledge(entry: {
  domain: string;
  source_url?: string;
  title: string;
  content: string;
  key_insights: string[];
}): Promise<void> {
  const { error } = await supabase.from('knowledge_base').insert(entry);
  if (error) throw error;
}

export async function searchKnowledge(domain: string, limit = 5): Promise<KnowledgeEntry[]> {
  const query = supabase
    .from('knowledge_base')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const { data, error } = domain === 'all'
    ? await query
    : await query.eq('domain', domain);

  if (error) throw error;
  return (data ?? []) as KnowledgeEntry[];
}

export async function getRecentKnowledge(limit = 20): Promise<KnowledgeEntry[]> {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as KnowledgeEntry[];
}

// ─── Project Configs ──────────────────────────────────────────────────────────

export interface ProjectChannels {
  general: string;
  research: string;
  engineering: string;
  marketing: string;
  design: string;
  morning_brief: string;
  overnight_log: string;
}

export interface ProjectConfig {
  id: string;
  slug: string;
  system_prompt: string;
  last_synced_at: string;
  discord_category_id: string;
  channels: ProjectChannels;
  github_repo?: string;
  created_at: string;
  updated_at: string;
}

export async function createProjectConfig(input: {
  slug: string;
  system_prompt: string;
  discord_category_id: string;
  channels: ProjectChannels;
  github_repo?: string;
}): Promise<ProjectConfig> {
  const { data, error } = await supabase
    .from('project_configs')
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as ProjectConfig;
}

export async function getProjectConfig(slug: string): Promise<ProjectConfig | null> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) return null;
  return data as ProjectConfig;
}

export async function getAllProjectConfigs(): Promise<ProjectConfig[]> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectConfig[];
}

export async function getProjectConfigByChannelId(channelId: string): Promise<ProjectConfig | null> {
  const { data, error } = await supabase
    .from('project_configs')
    .select('*');
  if (error) return null;
  return (data ?? []).find((p: ProjectConfig) => Object.values(p.channels).includes(channelId)) ?? null;
}

export async function updateProjectConfig(slug: string, updates: Partial<Pick<ProjectConfig, 'system_prompt' | 'last_synced_at' | 'github_repo'>>): Promise<void> {
  const { error } = await supabase
    .from('project_configs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('slug', slug);
  if (error) throw error;
}
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/memory/schema.sql src/memory/supabase.ts
git commit -m "feat: add knowledge_base and project_configs schema + helpers (Wave 7)"
```

---

### Task 2: Knowledge tool — `src/tools/knowledge.ts`

**Files:**
- Create: `src/tools/knowledge.ts`

**Step 1: Create the file**

```typescript
import { think } from '../brain.js';
import { saveKnowledge, searchKnowledge, KnowledgeEntry } from '../memory/supabase.js';
import { browseUrl } from './browser.js';

/**
 * Extract insights from content and save to knowledge base.
 * Called when Jake posts to #training channel.
 */
export async function processTrainingMaterial(
  domain: string,
  rawContent: string,
  sourceUrl?: string
): Promise<string> {
  // If URL provided, fetch the content
  let content = rawContent;
  let title = sourceUrl ?? 'Untitled';

  if (sourceUrl) {
    const browsed = await browseUrl(sourceUrl, 'Extract the main content, key points, and title');
    if (!browsed.error) {
      content = browsed.content ?? rawContent;
      title = browsed.title ?? sourceUrl;
    }
  }

  // Use haiku to extract key insights
  const extractPrompt = `Extract 3-7 key insights from this ${domain} content that would be useful for a solo founder building B2B SaaS products.

Content:
${content.slice(0, 8000)}

Return JSON only:
{
  "title": "short descriptive title",
  "key_insights": ["insight 1", "insight 2", "insight 3"]
}`;

  let title2 = title;
  let insights: string[] = [];

  try {
    const result = await think(
      'You are extracting actionable insights from business content.',
      [],
      extractPrompt,
      { model: 'haiku', noTools: true }
    );
    const parsed = JSON.parse(result.text);
    title2 = parsed.title ?? title;
    insights = parsed.key_insights ?? [];
  } catch {
    // If extraction fails, store the raw content with no insights
    insights = [];
  }

  await saveKnowledge({
    domain,
    source_url: sourceUrl,
    title: title2,
    content: content.slice(0, 10000),
    key_insights: insights,
  });

  const insightList = insights.length > 0
    ? `\n\nKey insights extracted:\n${insights.map(i => `• ${i}`).join('\n')}`
    : '';

  return `Saved to **${domain}** knowledge base: *${title2}*${insightList}`;
}

/**
 * Search the knowledge base for relevant material.
 * Used by the search_knowledge tool in brain.ts.
 */
export async function queryKnowledge(domain: string, context: string): Promise<string> {
  const entries = await searchKnowledge(domain === 'any' ? 'all' : domain, 8);

  if (entries.length === 0) {
    return `No knowledge base entries found for domain: ${domain}`;
  }

  // Ask Claude to select and summarize the most relevant insights
  const selectPrompt = `You are selecting the most relevant knowledge base entries for a specific task.

Task context: ${context}

Available knowledge (${entries.length} entries):
${entries.map((e, i) => `${i + 1}. [${e.domain}] ${e.title}\nInsights: ${e.key_insights.join('; ')}`).join('\n\n')}

Return the 3-5 most relevant insights as a concise summary (2-3 sentences max). Only include insights directly applicable to the task context.`;

  try {
    const result = await think(
      'You are a knowledge retrieval assistant.',
      [],
      selectPrompt,
      { model: 'haiku', noTools: true }
    );
    return result.text;
  } catch {
    // Fallback: return raw insights
    return entries.slice(0, 3).map(e =>
      `**${e.title}** (${e.domain}): ${e.key_insights.slice(0, 2).join('; ')}`
    ).join('\n\n');
  }
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/tools/knowledge.ts
git commit -m "feat: add knowledge base tool with insight extraction (Wave 7)"
```

---

### Task 3: Training channel handler

**Files:**
- Modify: `src/discord/channels.ts`
- Modify: `src/discord/handlers.ts`
- Modify: `src/discord/client.ts`

**Step 1: Add TRAINING to CHANNELS in `src/discord/channels.ts`**

In the `CHANNELS` object, add:
```typescript
  TRAINING: process.env.DISCORD_CHANNEL_TRAINING!,
```

**Step 2: Add `handleTrainingMessage` to `src/discord/handlers.ts`**

Add this import at the top (after the existing imports):
```typescript
import { processTrainingMaterial } from '../tools/knowledge.js';
```

Add this function after `handleDesignMessage` and before `handleMessage`:

```typescript
export async function handleTrainingMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    const content = msg.content.trim();

    // Parse domain from message: "sales: [content]", "marketing: [url]", etc.
    const DOMAINS = ['sales', 'marketing', 'design', 'engineering', 'general', 'product', 'growth'];
    const domainMatch = content.match(new RegExp(`^(${DOMAINS.join('|')})[:\\s]+(.+)`, 'is'));

    if (!domainMatch) {
      stopTyping();
      await msg.channel.send(
        `Tag the domain first — e.g. \`sales: [url or text]\`, \`marketing: [url]\`, \`design: [text]\`\n\nDomains: ${DOMAINS.join(', ')}`
      );
      return;
    }

    const domain = domainMatch[1].toLowerCase();
    const rawContent = domainMatch[2].trim();

    // Check if it's a URL
    const urlMatch = rawContent.match(/https?:\/\/[^\s]+/);
    const sourceUrl = urlMatch ? urlMatch[0] : undefined;

    await msg.channel.send(`Reading and extracting insights from this ${domain} material...`);

    const result = await processTrainingMaterial(domain, rawContent, sourceUrl);

    stopTyping();
    await msg.channel.send(result);
  } catch (err) {
    stopTyping();
    console.error('Error handling training message:', err);
    await msg.channel.send('⚠️ Failed to process training material. Check the logs.');
  }
}
```

**Step 3: Route `#training` in `src/discord/client.ts`**

Add `handleTrainingMessage` to the import from `./handlers.js`:
```typescript
import { handleMessage, handleDesignMessage, handleTrainingMessage } from './handlers.js';
```

In the `Events.MessageCreate` handler, add the training channel route:
```typescript
  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === CHANNELS.DESIGN_ELEMENTS) {
      handleDesignMessage(msg).catch(console.error);
    } else if (msg.channelId === CHANNELS.TRAINING) {
      handleTrainingMessage(msg).catch(console.error);
    } else {
      handleMessage(msg).catch(console.error);
    }
  });
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/discord/channels.ts src/discord/handlers.ts src/discord/client.ts
git commit -m "feat: add #training channel handler with domain-tagged knowledge extraction (Wave 7)"
```

---

### Task 4: `search_knowledge` tool in `brain.ts` and `registry.ts`

**Files:**
- Modify: `src/brain.ts`
- Modify: `src/tools/registry.ts`

**Step 1: Add tool schema to `TOOL_SCHEMAS` in `src/brain.ts`**

After the `self_modify_request` schema, add:

```typescript
  search_knowledge: {
    name: 'search_knowledge',
    description: 'Search the knowledge base for relevant training material Jake has fed Jarvis. Use before writing copy (search marketing/sales), making design decisions (search design), or planning technical architecture (search engineering). Returns the most relevant insights for the current task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        domain: {
          type: 'string',
          enum: ['sales', 'marketing', 'design', 'engineering', 'product', 'growth', 'general', 'any'],
          description: 'Knowledge domain to search. Use "any" to search all domains.',
        },
        context: {
          type: 'string',
          description: 'What you are working on — used to select the most relevant insights',
        },
      },
      required: ['domain', 'context'],
    },
  },
```

**Step 2: Add `search_knowledge` to the always-available pool**

The current active schemas builder pins `self_modify_request` and filters the rest by registry. `search_knowledge` should also always be available. Change the builder to pin both:

Find (around line 318):
```typescript
    return [
      TOOL_SCHEMAS.self_modify_request,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => t.name !== 'self_modify_request' && installedToolIds.has(t.name)
      ),
    ];
```

Replace with:
```typescript
    const alwaysAvailable = ['self_modify_request', 'search_knowledge'];
    return [
      TOOL_SCHEMAS.self_modify_request,
      TOOL_SCHEMAS.search_knowledge,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => !alwaysAvailable.includes(t.name) && installedToolIds.has(t.name)
      ),
    ];
```

**Step 3: Add executor case in `executeTool()`**

After the `self_modify_request` case, add:

```typescript
    case 'search_knowledge': {
      const { queryKnowledge } = await import('./tools/knowledge.js');
      const result = await queryKnowledge(
        input.domain as string,
        input.context as string
      );
      return { toolName: name, output: result };
    }
```

**Step 4: Add to registry in `src/tools/registry.ts`**

After `self_modify_request` entry, add:

```typescript
  {
    id: 'search_knowledge',
    name: 'Search Knowledge Base',
    description: 'Search training material Jake has fed Jarvis by domain',
    installed: true,
  },
```

**Step 5: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**

```bash
git add src/brain.ts src/tools/registry.ts
git commit -m "feat: add search_knowledge tool to brain + registry (Wave 7)"
```

---

### Task 5: Project setup tool — `src/tools/project-setup.ts`

**Files:**
- Create: `src/tools/project-setup.ts`

**Step 1: Create the file**

```typescript
import { Client, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createProjectConfig, getSystemPrompt, ProjectChannels } from '../memory/supabase.js';
import { octokit } from '../github/client.js';

const OWNER = process.env.GITHUB_OWNER!;

const PROJECT_CHANNELS: Array<{ key: keyof ProjectChannels; name: string; topic: string }> = [
  { key: 'general',       name: 'general',       topic: 'Main chat with Jarvis about this project' },
  { key: 'research',      name: 'research',       topic: 'Competitor tracking, market validation' },
  { key: 'engineering',   name: 'engineering',    topic: 'Build updates, PRs, deploys' },
  { key: 'marketing',     name: 'marketing',      topic: 'Copy, campaigns, launch plans' },
  { key: 'design',        name: 'design',         topic: 'Design decisions, components' },
  { key: 'morning-brief', name: 'morning-brief',  topic: 'Daily project status from Jarvis' },
  { key: 'overnight-log', name: 'overnight-log',  topic: 'What Jarvis worked on overnight' },
];

export interface ProjectSetupResult {
  slug: string;
  discordCategoryId: string;
  channels: ProjectChannels;
  githubRepo: string;
  generalChannelId: string;
}

export async function setupProject(
  discord: Client,
  projectName: string,
  slug: string,
  description: string
): Promise<ProjectSetupResult> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error('DISCORD_GUILD_ID not set in Railway env vars');

  const guild = discord.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found in cache — bot may not be in server`);

  console.log(`[project-setup] Creating Discord category for ${slug}...`);

  // Create category
  const category = await guild.channels.create({
    name: projectName.toUpperCase(),
    type: ChannelType.GuildCategory,
  });

  // Create all 7 channels inside the category
  const channelIds: Partial<ProjectChannels> = {};
  for (const ch of PROJECT_CHANNELS) {
    const created = await guild.channels.create({
      name: ch.name,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: ch.topic,
    });
    channelIds[ch.key] = created.id;
    console.log(`[project-setup] Created #${ch.name}: ${created.id}`);
  }

  const channels = channelIds as ProjectChannels;

  // Create GitHub repo
  console.log(`[project-setup] Creating GitHub repo ${slug}...`);
  await octokit.rest.repos.createForAuthenticatedUser({
    name: slug,
    description,
    private: false,
    auto_init: true,
  });

  // Fork global system prompt as project's system prompt
  const globalPrompt = await getSystemPrompt();
  const projectPrompt = `${globalPrompt}\n\n---\nPROJECT CONTEXT: ${projectName}\n${description}\n\nYou are currently working in the ${projectName} project workspace. Focus all responses, research, and execution on this project.`;

  // Save project config to Supabase
  await createProjectConfig({
    slug,
    system_prompt: projectPrompt,
    discord_category_id: category.id,
    channels,
    github_repo: slug,
  });

  console.log(`[project-setup] Project ${slug} setup complete`);

  return {
    slug,
    discordCategoryId: category.id,
    channels,
    githubRepo: `https://github.com/${OWNER}/${slug}`,
    generalChannelId: channels.general,
  };
}
```

**Note on `octokit` export:** `src/github/client.ts` currently creates an Octokit instance but doesn't export it. You need to add one line to `src/github/client.ts` — export the octokit instance:

Find line 3:
```typescript
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
```

Change to:
```typescript
export const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/tools/project-setup.ts src/github/client.ts
git commit -m "feat: add project-setup tool — Discord category + GitHub repo + project config (Wave 7)"
```

---

### Task 6: `create_project` tool in `brain.ts` and `registry.ts`

**Files:**
- Modify: `src/brain.ts`
- Modify: `src/tools/registry.ts`

**Step 1: Add `createProjectResult` to `ToolCallResult` interface in `src/brain.ts`**

Add field:
```typescript
  createProjectResult?: { slug: string; generalChannelId: string; githubRepo: string };
```

**Step 2: Add tool schema to `TOOL_SCHEMAS`**

After `search_knowledge`, add:

```typescript
  create_project: {
    name: 'create_project',
    description: 'Create a new project workspace — Discord category with 7 channels, GitHub repo, and isolated system prompt. Use when Jake says "create project" or approves a research opportunity for building. Ask for project name, description, and build type if not provided.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Human-readable project name, e.g. "South Bay Digital"' },
        slug: { type: 'string', description: 'URL-safe slug, lowercase hyphens only, e.g. "south-bay-digital"' },
        description: { type: 'string', description: 'One sentence describing what this project is and who it is for' },
      },
      required: ['project_name', 'slug', 'description'],
    },
  },
```

**Step 3: Add `create_project` to always-available pool**

Find the `alwaysAvailable` array added in Task 4:
```typescript
    const alwaysAvailable = ['self_modify_request', 'search_knowledge'];
```

Replace with:
```typescript
    const alwaysAvailable = ['self_modify_request', 'search_knowledge', 'create_project'];
```

And add it to the returned array:
```typescript
    return [
      TOOL_SCHEMAS.self_modify_request,
      TOOL_SCHEMAS.search_knowledge,
      TOOL_SCHEMAS.create_project,
      ...Object.values(TOOL_SCHEMAS).filter(
        t => !alwaysAvailable.includes(t.name) && installedToolIds.has(t.name)
      ),
    ];
```

**Step 4: Add executor case**

After the `search_knowledge` case, add:

```typescript
    case 'create_project': {
      const { setupProject } = await import('./tools/project-setup.js');
      // discord client is not available in executeTool — we need to pass it
      // Use global discord client stored at startup
      const { getDiscordClient } = await import('./discord/client.js');
      const discord = getDiscordClient();
      if (!discord) {
        return { toolName: name, output: 'Discord client not available — project setup failed.' };
      }
      try {
        const result = await setupProject(
          discord,
          input.project_name as string,
          (input.slug as string).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          input.description as string
        );
        return {
          toolName: name,
          output: `Project **${input.project_name}** created!\nDiscord category ready with 7 channels.\nGitHub: ${result.githubRepo}\nStart building in <#${result.generalChannelId}>`,
          createProjectResult: {
            slug: result.slug,
            generalChannelId: result.generalChannelId,
            githubRepo: result.githubRepo,
          },
        };
      } catch (err) {
        return { toolName: name, output: `Project setup failed: ${(err as Error).message}` };
      }
    }
```

**Step 5: Export Discord client from `src/discord/client.ts`**

The executor needs access to the Discord client. Add a module-level variable and getter to `src/discord/client.ts`:

```typescript
let _client: Client | null = null;

export function getDiscordClient(): Client | null {
  return _client;
}

export function createDiscordClient(): Client {
  const client = new Client({ ... }); // existing code

  client.once(Events.ClientReady, (c) => {
    _client = client; // store reference
    console.log(`Discord connected as ${c.user.tag}`);
  });

  // ... rest of existing code
}
```

**Step 6: Add to registry**

```typescript
  {
    id: 'create_project',
    name: 'Create Project',
    description: 'Create Discord workspace + GitHub repo + project system prompt',
    installed: true,
    requiresEnv: ['DISCORD_GUILD_ID', 'GITHUB_TOKEN'],
  },
```

**Step 7: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 8: Commit**

```bash
git add src/brain.ts src/tools/registry.ts src/discord/client.ts
git commit -m "feat: add create_project tool — wires Discord + GitHub + Supabase (Wave 7)"
```

---

### Task 7: Project-aware message routing

**Files:**
- Modify: `src/discord/handlers.ts`

**Step 1: Add import for `getProjectConfigByChannelId`**

Add to the imports from supabase.js:
```typescript
import { getRecentMessages, saveMessage, getSystemPrompt, updateProject, getProjectConfigByChannelId } from '../memory/supabase.js';
```

**Step 2: Change the channel gate in `handleMessage`**

Find (around line 132):
```typescript
  if (msg.channelId !== CHANNELS.JARVIS) return;
```

Replace with:
```typescript
  // Allow messages from global #jarvis channel OR any project channel
  const isGlobalJarvis = msg.channelId === CHANNELS.JARVIS;
  if (!isGlobalJarvis) {
    // Check if this is a project channel — if not, ignore
    const projectConfig = await getProjectConfigByChannelId(msg.channelId);
    if (!projectConfig) return;
  }
```

**Step 3: Load project system prompt when in a project channel**

Find (around line 233):
```typescript
    const systemPrompt = await getSystemPrompt();
    const result = await think(systemPrompt, history, msg.content);
```

Replace with:
```typescript
    // Use project system prompt if message is from a project channel
    let systemPrompt: string;
    if (!isGlobalJarvis) {
      const projectCfg = await getProjectConfigByChannelId(msg.channelId);
      systemPrompt = projectCfg?.system_prompt ?? await getSystemPrompt();
    } else {
      systemPrompt = await getSystemPrompt();
    }
    const result = await think(systemPrompt, history, msg.content);
```

**Note:** `isGlobalJarvis` is declared earlier (Step 2) but the `think()` call is inside the `try` block further down. You may need to move the `isGlobalJarvis` variable to a higher scope, or re-query the project config. The simplest approach: declare `let isGlobalJarvis = true` and `let projectChannelConfig: ProjectConfig | null = null` before the try block, and set them in the channel gate check.

Import `ProjectConfig` at the top:
```typescript
import { ..., getProjectConfigByChannelId, ProjectConfig } from '../memory/supabase.js';
```

Update the channel gate to store the project config:
```typescript
  let isGlobalJarvis = msg.channelId === CHANNELS.JARVIS;
  let projectChannelConfig: ProjectConfig | null = null;

  if (!isGlobalJarvis) {
    projectChannelConfig = await getProjectConfigByChannelId(msg.channelId);
    if (!projectChannelConfig) return;
  }
```

Then in the think call:
```typescript
    const systemPrompt = projectChannelConfig?.system_prompt ?? await getSystemPrompt();
    const result = await think(systemPrompt, history, msg.content);
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/discord/handlers.ts
git commit -m "feat: project-aware message routing — load per-project system prompt (Wave 7)"
```

---

### Task 8: Overnight trainer folds knowledge + syncs project prompts

**Files:**
- Modify: `src/overnight/trainer.ts`

**Step 1: Add imports**

Add at the top:
```typescript
import { getRecentKnowledge, getAllProjectConfigs, updateProjectConfig } from '../memory/supabase.js';
```

**Step 2: After saving the new global system prompt, fold knowledge and sync projects**

After `await saveSystemPrompt(parsed.new_prompt);` (around line 48), add:

```typescript
    // Fold recent knowledge base insights into the new prompt
    const recentKnowledge = await getRecentKnowledge(15);
    if (recentKnowledge.length > 0) {
      const knowledgeSummary = recentKnowledge
        .map(k => `[${k.domain}] ${k.title}: ${k.key_insights.slice(0, 2).join('; ')}`)
        .join('\n');

      const knowledgePrompt = `You are updating a system prompt to incorporate recent training material.

Current prompt:
${parsed.new_prompt}

Recent training material (${recentKnowledge.length} entries):
${knowledgeSummary}

Incorporate the key insights naturally into the relevant sections of the prompt. Keep it under 700 words. Return the updated prompt only, no markdown.`;

      try {
        const withKnowledge = (await think(
          'You are a prompt engineer incorporating domain knowledge.',
          [],
          knowledgePrompt,
          { model: 'sonnet', noTools: true }
        )).text;
        await saveSystemPrompt(withKnowledge);
        parsed.new_prompt = withKnowledge;
      } catch (err) {
        console.error('Knowledge fold failed (non-fatal):', err);
      }
    }

    // Sync updated global prompt to all project configs (weekly: check last_synced_at)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const projects = await getAllProjectConfigs();
    for (const project of projects) {
      if (project.last_synced_at < oneWeekAgo) {
        await syncProjectPrompt(project.slug, parsed.new_prompt);
      }
    }
```

**Step 3: Add `syncProjectPrompt` helper function**

Add after the imports:

```typescript
async function syncProjectPrompt(slug: string, globalPrompt: string): Promise<void> {
  const { getProjectConfig } = await import('../memory/supabase.js');
  const project = await getProjectConfig(slug);
  if (!project) return;

  // Preserve the project-specific context block appended at creation
  const contextMatch = project.system_prompt.match(/---\nPROJECT CONTEXT:[\s\S]+$/);
  const projectContext = contextMatch ? '\n\n' + contextMatch[0] : '';

  await updateProjectConfig(slug, {
    system_prompt: globalPrompt + projectContext,
    last_synced_at: new Date().toISOString(),
  });
  console.log(`[trainer] Synced project prompt: ${slug}`);
}
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/overnight/trainer.ts
git commit -m "feat: trainer folds knowledge base into global prompt + syncs project prompts (Wave 7)"
```

---

### Task 9: Per-project morning brief + overnight log

**Files:**
- Modify: `src/overnight/briefing.ts`

**Step 1: Add imports**

```typescript
import { getAllProjectConfigs, ProjectConfig, ProjectChannels } from '../memory/supabase.js';
```

**Step 2: Add `postProjectMorningBriefings` function**

After `postMorningBriefing`, add:

```typescript
export async function postProjectMorningBriefings(discord: Client) {
  const projects = await getAllProjectConfigs();
  if (projects.length === 0) return;

  console.log(`Project morning briefs: ${projects.length} active projects`);

  for (const project of projects) {
    try {
      const morningBriefChannelId = project.channels.morning_brief;
      const channel = discord.channels.cache.get(morningBriefChannelId) as TextChannel | undefined;
      if (!channel) continue;

      // Get recent messages from project's general channel for context
      const history = await getRecentMessages(project.channels.general, 30);

      const context = `Project: ${project.slug}
Recent activity (last 30 messages in #general):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)}`;

      const briefing = (await think(
        `You are Jarvis writing a morning brief for the ${project.slug} project. Be specific to this project only. Include: what was worked on, current status, today's priorities. 3-5 bullet points max. Direct, no fluff.`,
        [],
        context,
        { model: 'haiku', noTools: true }
      )).text;

      await channel.send(`**Good morning — ${project.slug} update**\n\n${briefing}`);
      console.log(`Project morning brief posted: ${project.slug}`);
    } catch (err) {
      console.error(`Project morning brief failed for ${project.slug}:`, err);
    }
  }
}

export async function postProjectOvernightLogs(discord: Client) {
  const projects = await getAllProjectConfigs();
  if (projects.length === 0) return;

  for (const project of projects) {
    try {
      const overnightChannelId = project.channels.overnight_log;
      const channel = discord.channels.cache.get(overnightChannelId) as TextChannel | undefined;
      if (!channel) continue;

      // Get last 20 messages from engineering channel as proxy for overnight activity
      const recentEngineering = await getRecentMessages(project.channels.engineering, 20);
      if (recentEngineering.length === 0) continue;

      const summary = (await think(
        `Summarize overnight activity for the ${project.slug} project in 2-3 sentences. Focus on what changed, what was shipped, what's pending.`,
        [],
        recentEngineering.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000),
        { model: 'haiku', noTools: true }
      )).text;

      await channel.send(`**Overnight log — ${new Date().toLocaleDateString()}**\n\n${summary}`);
    } catch (err) {
      console.error(`Overnight log failed for ${project.slug}:`, err);
    }
  }
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/overnight/briefing.ts
git commit -m "feat: per-project morning briefs and overnight logs (Wave 7)"
```

---

### Task 10: Product pulse posts to project channels

**Files:**
- Modify: `src/overnight/product-pulse.ts`

**Step 1: Add import**

```typescript
import { getProjectConfigByChannelId, getAllProjectConfigs } from '../memory/supabase.js';
```

**Step 2: Change where the pulse posts**

Currently `runProductPulse` gets `CHANNELS.ENGINEERING` (global). Each project's live build should post to that project's `#engineering` channel.

Find:
```typescript
  const channel = discord.channels.cache.get(CHANNELS.ENGINEERING) as TextChannel | undefined;
  if (!channel) return;
```

Replace with logic that posts per-project. Change the function to look up each project's engineering channel from `project_configs`:

After `const liveProjects = await getProjects('live');`, add:
```typescript
  const projectConfigs = await getAllProjectConfigs();
  const projectChannelMap = new Map(
    projectConfigs.map(p => [p.slug, p.channels.engineering])
  );
```

Then in the per-project loop, replace the final send block to post to the project's channel instead of the global one. For each project, find its engineering channel:

```typescript
  for (const project of liveProjects) {
    // ... existing analytics + analysis code ...

    // Post to project's #engineering channel if available, else fall back to global
    const projectEngineeringId = projectChannelMap.get(project.slug) ?? CHANNELS.ENGINEERING;
    const projectChannel = discord.channels.cache.get(projectEngineeringId) as TextChannel | undefined;
    if (!projectChannel) continue;

    const summary = /* existing summary string */;
    if (summary.length <= 1900) {
      await projectChannel.send(summary);
    } else {
      await projectChannel.send(summary.slice(0, 1900) + '…');
    }
  }
```

Note: this requires refactoring the existing loop slightly — the current code collects all summaries then sends them together. Split it so each project's summary is sent to its own channel immediately in the loop.

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/overnight/product-pulse.ts
git commit -m "feat: product pulse posts to per-project engineering channels (Wave 7)"
```

---

### Task 11: E2B Next.js preview (builder Phase 1)

**Files:**
- Modify: `src/tools/builder.ts`
- Modify: `src/sandbox/client.ts`

**Step 1: Add `runNextjsPreview` to `src/sandbox/client.ts`**

Append to the file:

```typescript
/**
 * Run a Next.js app in E2B sandbox for preview. Returns a live URL (valid ~1hr).
 * files: all Next.js project files including package.json
 */
export async function runNextjsPreview(
  files: { path: string; content: string }[]
): Promise<SandboxResult> {
  const sandbox = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 60 * 60 * 1000, // 1 hour for preview
  });

  // Write all files
  for (const file of files) {
    await sandbox.files.write(file.path, file.content);
  }

  // Install deps and start Next.js dev server
  await sandbox.commands.run('npm install --legacy-peer-deps 2>&1 | tail -5', { timeoutMs: 120000 });
  await sandbox.commands.run('npx next dev --port 3000 2>&1 &', { background: true });

  // Wait for Next.js to start (it takes a few seconds)
  await new Promise(r => setTimeout(r, 8000));

  const url = `https://${sandbox.getHost(3000)}`;
  return { url, sandboxId: sandbox.sandboxId };
}
```

**Step 2: Split `buildProject` in `src/tools/builder.ts`**

Add a new export `previewProject` that runs Phase 1 only (E2B preview, no Vercel):

Add after the imports:
```typescript
import { runNextjsPreview } from '../sandbox/client.js';
```

Add new function before `buildProject`:

```typescript
export interface PreviewResult {
  slug: string;
  previewUrl: string;
  sandboxId: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * Phase 1: Generate and preview in E2B sandbox. Does NOT create Vercel project.
 * Call this first. If Jake approves, call buildProject() with the same files.
 */
export async function previewProject(
  plan: BuildPlan,
  generatedFiles: Array<{ path: string; content: string }>
): Promise<PreviewResult> {
  plan.slug = plan.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const { getProject } = await import('../memory/supabase.js');
  let uniqueSlug = plan.slug;
  let attempt = 2;
  while (await getProject(uniqueSlug)) {
    uniqueSlug = `${plan.slug}-${attempt++}`;
  }
  plan.slug = uniqueSlug;

  console.log(`[preview] Starting E2B preview for ${plan.slug}...`);

  // For full_app builds: run TypeScript validation first
  let filesToPreview = generatedFiles;
  if (plan.buildType === 'full_app') {
    console.log(`[preview] Running TypeScript validation...`);
    filesToPreview = await runTypeScriptCheck(generatedFiles);
  }

  // Add design tokens
  const tokens = await readDesignTokens();
  const allFiles = [
    { path: 'app/design-tokens.css', content: generateCssVars(tokens) },
    ...filesToPreview,
  ];

  console.log(`[preview] Spinning up E2B Next.js preview (${allFiles.length} files)...`);
  const { url, sandboxId } = await runNextjsPreview(allFiles);
  console.log(`[preview] Preview URL: ${url}`);

  return { slug: plan.slug, previewUrl: url, sandboxId, files: allFiles };
}
```

**Step 3: Update `buildProject` to accept pre-validated files**

`buildProject` currently re-validates files with TypeScript. Since `previewProject` already did that, add an optional `skipValidation` param:

Find the signature:
```typescript
export async function buildProject(
  plan: BuildPlan,
  generatedFiles: Array<{ path: string; content: string }>
): Promise<BuildResult> {
```

Add optional param:
```typescript
export async function buildProject(
  plan: BuildPlan,
  generatedFiles: Array<{ path: string; content: string }>,
  skipValidation = false
): Promise<BuildResult> {
```

Then change the validation block:
```typescript
  let filesToPush = generatedFiles;
  if (plan.buildType === 'full_app' && !skipValidation) {
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/tools/builder.ts src/sandbox/client.ts
git commit -m "feat: add E2B Next.js preview (Phase 1 build) before Vercel deploy (Wave 7)"
```

---

### Task 12: Wire preview approval + `build_app` tool update in `brain.ts` and `handlers.ts`

**Files:**
- Modify: `src/brain.ts`
- Modify: `src/discord/handlers.ts`

**Step 1: Add `previewResult` to `ToolCallResult` in `src/brain.ts`**

Add field:
```typescript
  previewResult?: { slug: string; previewUrl: string; files: Array<{ path: string; content: string }>; plan: import('./tools/builder.js').BuildPlan };
```

**Step 2: Add `preview_app` tool schema**

Add after `build_app` in `TOOL_SCHEMAS`:

```typescript
  preview_app: {
    name: 'preview_app',
    description: 'Preview a web project in E2B sandbox BEFORE deploying to Vercel. Use this instead of build_app when Jake wants to review before deploying, or when building for a project with limited Vercel slots. Returns a live preview URL valid for 1hr. Jake says "ship it" to trigger the full Vercel deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        build_type: { type: 'string', enum: ['landing_page', 'full_app'] },
        target_audience: { type: 'string' },
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
        },
      },
      required: ['project_name', 'slug', 'description', 'build_type', 'target_audience', 'files'],
    },
  },
```

**Step 3: Add `preview_app` executor case**

After `build_app` case, add:

```typescript
    case 'preview_app': {
      const { previewProject } = await import('./tools/builder.js');
      try {
        const plan = {
          projectName: input.project_name as string,
          slug: input.slug as string,
          description: input.description as string,
          buildType: input.build_type as 'landing_page' | 'full_app',
          targetAudience: input.target_audience as string,
        };
        const result = await previewProject(plan, input.files as Array<{ path: string; content: string }>);
        return {
          toolName: name,
          output: `Preview live for **${result.slug}**: ${result.previewUrl}\n\nURL is valid for ~1hr. Say **"ship it"** to deploy to Vercel, or tell me what to change.`,
          previewResult: { ...result, plan },
        };
      } catch (err) {
        return { toolName: name, output: `Preview failed: ${(err as Error).message}` };
      }
    }
```

**Step 4: Add `pendingPreviewApproval` state in `src/discord/handlers.ts`**

After `pendingPRApproval` map, add:
```typescript
const pendingPreviewApproval = new Map<string, {
  slug: string;
  previewUrl: string;
  files: Array<{ path: string; content: string }>;
  plan: import('../tools/builder.js').BuildPlan;
}>();
```

**Step 5: Add preview approval check in `handleMessage`**

After the `pendingPRApproval` check block, add:

```typescript
  // Check if we're waiting for preview approval (ship it → full Vercel deploy)
  const pendingPreview = pendingPreviewApproval.get(msg.channelId);
  if (pendingPreview) {
    if (isShipApproval(msg.content)) {
      pendingPreviewApproval.delete(msg.channelId);
      await msg.channel.send(`Deploying **${pendingPreview.slug}** to Vercel...`);
      try {
        const { buildProject } = await import('../tools/builder.js');
        const result = await buildProject(pendingPreview.plan, pendingPreview.files, true);
        await updateProject(pendingPreview.slug, { status: 'staging' });
        await msg.channel.send(`Staging ready: ${result.stagingUrl}\n\nSay **"ship it"** again to promote to production.`);
        // Store as staging approval
        pendingStagingApproval.set(msg.channelId, {
          slug: result.slug,
          stagingUrl: result.stagingUrl,
          vercelProjectId: result.vercelProjectId,
        });
        await notifySlackEngineering(`🔧 Staging ready: *${result.slug}*\n${result.stagingUrl}`);
      } catch (err) {
        await msg.channel.send(`⚠️ Deploy failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingPreviewApproval.delete(msg.channelId);
      await msg.channel.send(`Preview cancelled. Let me know when you want to rebuild or try a different approach.`);
      return;
    }
    // Conversational — fall through with pending preserved
  }
```

**Step 6: Handle `previewResult` in the tool results loop**

After the `selfModifyProposal` block, add:
```typescript
      if (toolResult.previewResult) {
        pendingPreviewApproval.set(msg.channelId, toolResult.previewResult);
      }
```

**Step 7: Add `preview_app` to registry**

```typescript
  {
    id: 'preview_app',
    name: 'Preview App (E2B)',
    description: 'Preview a Next.js app in E2B sandbox before Vercel deploy',
    installed: true,
    requiresEnv: ['E2B_API_KEY'],
  },
```

**Step 8: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 9: Commit**

```bash
git add src/brain.ts src/discord/handlers.ts src/tools/registry.ts
git commit -m "feat: preview_app tool + preview approval gate before Vercel deploy (Wave 7)"
```

---

### Task 13: Index.ts — wire per-project crons + new env vars

**Files:**
- Modify: `src/index.ts`

**Step 1: Add new imports**

```typescript
import { postProjectMorningBriefings, postProjectOvernightLogs } from './overnight/briefing.js';
```

**Step 2: Update morning brief cron (7am) to also post project briefs**

Find:
```typescript
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
  });
```

Replace with:
```typescript
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
    postProjectMorningBriefings(discord).catch(console.error);
  });
```

**Step 3: Update overnight training cron (2am) to also post project overnight logs**

Find:
```typescript
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
  });
```

Replace with:
```typescript
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
    postProjectOvernightLogs(discord).catch(console.error);
  });
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire per-project morning briefs + overnight logs into cron schedule (Wave 7)"
```

---

### Task 14: Update system prompt v6 + add Railway env vars note

**Files:**
- No code changes — Supabase SQL + Railway env var setup

**Step 1: Run schema SQL in Supabase**

In Supabase SQL Editor, run the two CREATE TABLE statements from Task 1 (if not already done), plus:
```sql
ALTER TABLE knowledge_base DISABLE ROW LEVEL SECURITY;
ALTER TABLE project_configs DISABLE ROW LEVEL SECURITY;
```

**Step 2: Add new env vars to Railway**

Go to Railway → Jarvis service → Variables. Add:
- `DISCORD_CHANNEL_TRAINING` — ID of the `#training` channel Jake needs to create in Discord
- `DISCORD_GUILD_ID` — the Jarvis HQ server ID (right-click server name in Discord → Copy Server ID)

**Step 3: Insert system prompt v6 in Supabase**

Run this SQL (after fetching v5 to check current content):
```sql
-- First check v5
SELECT content FROM system_prompts WHERE version = 5;

-- Then insert v6 with training + project workspace additions
INSERT INTO system_prompts (version, content) VALUES (6, '<v5 content> + append below');
```

Append to v5 content:
```
PROJECT WORKSPACES
Each project has its own Discord folder with isolated channels and system prompt. When working in a project channel, stay focused on that project only. Do not cross-pollinate projects in conversation. Use create_project when Jake says "create project [name]" or approves a research opportunity for building.

KNOWLEDGE BASE
When writing copy, planning positioning, or making design/architecture decisions, call search_knowledge first to check what training material is relevant. Jake feeds material into #training with domain tags — this shapes how you think across all domains. The knowledge base is your accumulated expertise.

PREVIEW BEFORE DEPLOY
When building a new product, use preview_app instead of build_app. This spins up an E2B preview URL (~1hr) so Jake can review before a Vercel slot is consumed. Only call build_app for direct deploys when Jake explicitly bypasses preview.
```

**Step 4: Verify Railway deployment**

After pushing all commits and setting env vars, Railway will redeploy. Watch logs for `Jarvis online.` with no errors.

**Step 5: Smoke test**

1. Create `#training` channel in Discord, add ID to Railway
2. Post in `#training`: `marketing: https://[any marketing article URL]`
   - Expected: Jarvis reads it, posts extracted insights
3. Say in `#jarvis`: "create project: Test Project, slug: test-project-wave7, a test project for validating Wave 7"
   - Expected: Discord category + 7 channels created, GitHub repo created, welcome message in #general
4. Say in the new project's `#general`: "what is this project about?"
   - Expected: Jarvis responds with project context (uses project system prompt)
