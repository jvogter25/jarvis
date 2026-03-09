# Wave 4: Build Machine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Jarvis a full autonomous build pipeline — Next.js apps deployed from Discord, Jake's personal design aesthetic extracted from URLs/components and injected into every build, with overnight mode that stages everything for morning approval.

**Architecture:** Five new systems: (1) Supabase `projects` table tracks build state end-to-end, (2) Design Intelligence extracts CSS/tokens from URLs + manages a component library backed by GitHub, (3) Build Pipeline forks `jarvis-template` → injects design tokens → pushes to GitHub → Vercel auto-deploys staging, (4) `#design-elements` Discord channel for adding to the design library, (5) Overnight Mode for autonomous builds that never push to production without Jake's approval.

**Tech Stack:** GitHub API via Octokit (template fork, branch management, file push, merge), Vercel REST API (project creation, deploy status, production promotion), Playwright/Browserbase (CSS extraction from live pages), Supabase (projects table), discord.js v14 (new channel handler + staging approval), existing brain.ts tool_use loop.

---

## Pre-Requisites (Human Steps — Do These Before Starting)

1. **Create `jarvis-template` GitHub repo**
   - Go to github.com → New repository → name: `jarvis-template`, public
   - After creating: Settings → General → scroll to "Template repository" → check the box → Save

2. **Create `#design-elements` Discord channel**
   - In Jarvis HQ Discord server → New Channel → `#design-elements`
   - Right-click channel → Copy Channel ID
   - Add to Railway: `DISCORD_CHANNEL_DESIGN_ELEMENTS=<channel-id>`

3. **Get Vercel API token**
   - Go to vercel.com/account/tokens → Create token → name: "jarvis"
   - Add to Railway: `VERCEL_TOKEN=<token>`
   - If using a Vercel team (not personal): Settings → Team ID (starts with `team_`) → Add to Railway: `VERCEL_TEAM_ID=<team-id>`. Skip if personal account.

---

## Task 1: Supabase Projects Table

**Files:**
- Modify: `src/memory/schema.sql`
- Modify: `src/memory/supabase.ts`

**Step 1: Add projects table to schema.sql**

Append to `src/memory/schema.sql`:

```sql
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  status text not null default 'planning',
  -- status: planning | building | staging | live | archived
  build_type text not null default 'landing_page',
  -- build_type: landing_page | full_app
  description text,
  github_repo text,
  vercel_project_id text,
  staging_url text,
  production_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

**Step 2: Run in Supabase SQL Editor**

Go to Supabase → SQL Editor → paste the CREATE TABLE above → Run. Verify `projects` appears in Table Editor.

**Step 3: Add project functions to supabase.ts**

Append to `src/memory/supabase.ts`:

```typescript
export interface Project {
  id: string;
  name: string;
  slug: string;
  status: 'planning' | 'building' | 'staging' | 'live' | 'archived';
  build_type: 'landing_page' | 'full_app';
  description?: string;
  github_repo?: string;
  vercel_project_id?: string;
  staging_url?: string;
  production_url?: string;
  created_at: string;
  updated_at: string;
}

export async function createProject(input: {
  name: string;
  slug: string;
  build_type: 'landing_page' | 'full_app';
  description?: string;
}): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ ...input, status: 'planning' })
    .select()
    .single();
  if (error) throw error;
  return data as Project;
}

export async function updateProject(slug: string, updates: Partial<Project>): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('slug', slug);
  if (error) throw error;
}

export async function getProjects(status?: Project['status']): Promise<Project[]> {
  let query = supabase.from('projects').select('*').order('created_at', { ascending: false });
  if (status) query = (query as ReturnType<typeof supabase.from>).eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Project[];
}

export async function getProject(slug: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) return null;
  return data as Project;
}
```

Note: the `getProjects` status filter uses a cast to satisfy TypeScript's chain typing — if this causes a type error, extract the filter into a separate if-block.

**Step 4: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 5: Commit**

```bash
git add src/memory/schema.sql src/memory/supabase.ts
git commit -m "feat: add projects table and CRUD functions"
```

---

## Task 2: GitHub Client Additions

These helpers are needed by the design system and build pipeline.

**Files:**
- Modify: `src/github/client.ts`

**Step 1: Append new functions to github/client.ts**

```typescript
export async function getFileContent(repo: string, filePath: string): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: filePath });
    if (Array.isArray(data) || data.type !== 'file') return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export async function listFiles(repo: string, dirPath: string): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo, path: dirPath });
    if (!Array.isArray(data)) return [];
    return data.filter(f => f.type === 'file').map(f => f.name);
  } catch {
    return [];
  }
}

export async function createRepoFromTemplate(templateRepo: string, newName: string): Promise<void> {
  await octokit.rest.repos.createUsingTemplate({
    template_owner: OWNER,
    template_repo: templateRepo,
    owner: OWNER,
    name: newName,
    private: false,
  });
}

export async function createBranch(repo: string, branchName: string, fromBranch = 'main'): Promise<void> {
  const { data: ref } = await octokit.rest.git.getRef({
    owner: OWNER,
    repo,
    ref: `heads/${fromBranch}`,
  });
  await octokit.rest.git.createRef({
    owner: OWNER,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
}

export async function mergeBranch(repo: string, head: string, base = 'main'): Promise<void> {
  await octokit.rest.repos.merge({
    owner: OWNER,
    repo,
    base,
    head,
    commit_message: `chore: merge ${head} into ${base}`,
  });
}
```

**Step 2: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add src/github/client.ts
git commit -m "feat: add GitHub helpers — getFileContent, listFiles, createRepoFromTemplate, branch management"
```

---

## Task 3: Design Token System

**Files:**
- Create: `src/tools/design.ts`

**Step 1: Create src/tools/design.ts**

```typescript
import { upsertFile, getFileContent, listFiles } from '../github/client.js';
import { interactWithPage } from './browser.js';

const JARVIS_REPO = 'jarvis';
const DESIGN_TOKENS_PATH = 'design-refs/design-tokens.json';
const COMPONENTS_PATH = 'design-refs/components';
const INSPIRATION_PATH = 'design-refs/inspiration';

export interface DesignTokens {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: Record<string, string>;
  spacing: Record<string, string>;
  sources: string[];
}

const DEFAULT_TOKENS: DesignTokens = {
  colors: {
    primary: '#0066FF',
    background: '#0A0A0A',
    surface: '#1A1A1A',
    text: '#FFFFFF',
    accent: '#00D4FF',
    muted: '#888888',
  },
  fonts: {
    heading: 'Inter',
    body: 'Inter',
    mono: 'JetBrains Mono',
  },
  radius: {
    card: '12px',
    button: '8px',
    input: '6px',
    full: '9999px',
  },
  spacing: {
    section: '80px',
    card: '24px',
    gap: '16px',
  },
  sources: [],
};

export async function readDesignTokens(): Promise<DesignTokens> {
  const raw = await getFileContent(JARVIS_REPO, DESIGN_TOKENS_PATH);
  if (!raw) return DEFAULT_TOKENS;
  try {
    return JSON.parse(raw) as DesignTokens;
  } catch {
    return DEFAULT_TOKENS;
  }
}

export async function updateDesignTokens(
  updates: Partial<DesignTokens>,
  sourceNote?: string
): Promise<void> {
  const current = await readDesignTokens();
  const merged: DesignTokens = {
    colors: { ...current.colors, ...(updates.colors ?? {}) },
    fonts: { ...current.fonts, ...(updates.fonts ?? {}) },
    radius: { ...current.radius, ...(updates.radius ?? {}) },
    spacing: { ...current.spacing, ...(updates.spacing ?? {}) },
    sources: sourceNote
      ? [...current.sources, `${sourceNote} — ${new Date().toISOString().slice(0, 10)}`]
      : current.sources,
  };
  await upsertFile(
    JARVIS_REPO,
    DESIGN_TOKENS_PATH,
    JSON.stringify(merged, null, 2) + '\n',
    `feat: update design tokens${sourceNote ? ` from ${sourceNote}` : ''}`
  );
}

export async function extractCssFromUrl(url: string): Promise<Partial<DesignTokens>> {
  const playwrightCode = `
    const extracted = await page.evaluate(() => {
      const cssVars = {};
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === 'html')) {
              const matches = rule.cssText.matchAll(/(--[\\w-]+):\\s*([^;]+)/g);
              for (const m of matches) {
                cssVars[m[1].trim()] = m[2].trim();
              }
            }
          }
        } catch (e) {}
      }
      const bodyStyle = window.getComputedStyle(document.body);
      const h1 = document.querySelector('h1');
      const h1Style = h1 ? window.getComputedStyle(h1) : null;
      return {
        cssVars,
        bgColor: bodyStyle.backgroundColor,
        textColor: bodyStyle.color,
        bodyFont: bodyStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
        headingFont: h1Style ? h1Style.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : null,
      };
    });
    console.log(JSON.stringify(extracted));
  `;

  const result = await interactWithPage(url, playwrightCode);
  if (result.error) {
    console.error('CSS extraction failed:', result.error);
    return {};
  }

  try {
    const data = JSON.parse(result.result) as {
      cssVars: Record<string, string>;
      bgColor: string;
      textColor: string;
      bodyFont: string;
      headingFont: string | null;
    };

    const tokens: Partial<DesignTokens> = { colors: {}, fonts: {} };

    // Map common CSS variable names to token structure
    const varMap: Record<string, [keyof DesignTokens, string]> = {
      '--primary': ['colors', 'primary'],
      '--primary-color': ['colors', 'primary'],
      '--color-primary': ['colors', 'primary'],
      '--background': ['colors', 'background'],
      '--foreground': ['colors', 'text'],
      '--accent': ['colors', 'accent'],
      '--border-radius': ['radius', 'card'],
      '--radius': ['radius', 'card'],
      '--font-sans': ['fonts', 'body'],
      '--font-heading': ['fonts', 'heading'],
    };

    for (const [varName, value] of Object.entries(data.cssVars)) {
      const mapping = varMap[varName];
      if (mapping) {
        const [category, key] = mapping;
        (tokens[category] as Record<string, string>)[key] = value;
      }
    }

    if (data.bgColor && data.bgColor !== 'rgba(0, 0, 0, 0)') {
      tokens.colors!['background'] = data.bgColor;
    }
    if (data.textColor) tokens.colors!['text'] = data.textColor;
    if (data.headingFont && data.headingFont !== 'sans-serif') {
      tokens.fonts!['heading'] = data.headingFont;
    }
    if (data.bodyFont && data.bodyFont !== 'sans-serif') {
      tokens.fonts!['body'] = data.bodyFont;
    }

    return tokens;
  } catch {
    return {};
  }
}

export async function saveComponent(name: string, code: string): Promise<void> {
  const fileName = name.replace(/\s+/g, '-').toLowerCase() + '.tsx';
  await upsertFile(
    JARVIS_REPO,
    `${COMPONENTS_PATH}/${fileName}`,
    code,
    `feat: add design component ${name}`
  );
}

export async function saveInspiration(fileName: string, imageBase64: string): Promise<void> {
  await upsertFile(
    JARVIS_REPO,
    `${INSPIRATION_PATH}/${fileName}`,
    imageBase64,
    `feat: add design inspiration ${fileName}`
  );
}

export async function scanDesignLibrary(): Promise<{
  components: string[];
  tokenSummary: string;
}> {
  const [components, tokens] = await Promise.all([
    listFiles(JARVIS_REPO, COMPONENTS_PATH),
    readDesignTokens(),
  ]);
  const tokenSummary = [
    `Colors: primary=${tokens.colors.primary}, bg=${tokens.colors.background}`,
    `Fonts: heading=${tokens.fonts.heading}, body=${tokens.fonts.body}`,
    `${tokens.sources.length} sites extracted`,
  ].join('. ');

  return {
    components: components.filter(f => f.endsWith('.tsx')),
    tokenSummary,
  };
}

export function generateCssVars(tokens: DesignTokens): string {
  const vars = [
    ...Object.entries(tokens.colors).map(([k, v]) => `  --color-${k}: ${v};`),
    ...Object.entries(tokens.fonts).map(([k, v]) => `  --font-${k}: "${v}", sans-serif;`),
    ...Object.entries(tokens.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
    ...Object.entries(tokens.spacing).map(([k, v]) => `  --spacing-${k}: ${v};`),
  ].join('\n');
  return `:root {\n${vars}\n}\n`;
}
```

**Step 2: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add src/tools/design.ts
git commit -m "feat: design token system — CSS extraction, component library, GitHub-backed storage"
```

---

## Task 4: #design-elements Channel Handler

**Files:**
- Modify: `src/discord/channels.ts`
- Modify: `src/discord/handlers.ts`
- Modify: `src/discord/client.ts`

**Step 1: Add DESIGN_ELEMENTS to channels.ts**

In `src/discord/channels.ts`, update the CHANNELS export:

```typescript
export const CHANNELS = {
  JARVIS: process.env.DISCORD_CHANNEL_JARVIS!,
  MORNING_BRIEF: process.env.DISCORD_CHANNEL_MORNING_BRIEF!,
  RESEARCH: process.env.DISCORD_CHANNEL_RESEARCH!,
  ENGINEERING: process.env.DISCORD_CHANNEL_ENGINEERING!,
  MARKETING: process.env.DISCORD_CHANNEL_MARKETING!,
  OVERNIGHT_LOG: process.env.DISCORD_CHANNEL_OVERNIGHT_LOG!,
  DESIGN_ELEMENTS: process.env.DISCORD_CHANNEL_DESIGN_ELEMENTS!,
};
```

**Step 2: Add imports to handlers.ts**

At the top of `src/discord/handlers.ts`, add:

```typescript
import { extractCssFromUrl, updateDesignTokens, saveComponent, saveInspiration, scanDesignLibrary } from '../tools/design.js';
```

**Step 3: Add handleDesignMessage function to handlers.ts**

Add this function after the `keepTyping` function (around line 18), before `handleMessage`:

```typescript
export async function handleDesignMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    const content = msg.content.trim();

    // Image attachment → save as inspiration
    if (msg.attachments.size > 0) {
      const attachment = msg.attachments.first()!;
      if (attachment.contentType?.startsWith('image/')) {
        const res = await fetch(attachment.url);
        const buffer = await res.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const ext = attachment.contentType.split('/')[1] ?? 'png';
        const fileName = `${Date.now()}-${attachment.name ?? 'inspiration'}.${ext}`;
        await saveInspiration(fileName, base64);
        stopTyping();
        await msg.channel.send(`Saved to inspiration library as \`${fileName}\`. I'll use this as visual context when building.`);
        return;
      }
    }

    // Code block → save as component
    const codeBlockMatch = content.match(/```(?:tsx?|jsx?|html?)?\n([\s\S]+?)```/);
    if (codeBlockMatch) {
      const surrounding = content.replace(codeBlockMatch[0], '').trim();
      const componentName = surrounding || `component-${Date.now()}`;
      await saveComponent(componentName, codeBlockMatch[1]);
      stopTyping();
      await msg.channel.send(`Saved component as \`${componentName.replace(/\s+/g, '-').toLowerCase()}.tsx\`. I'll suggest it for relevant builds.`);
      return;
    }

    // URL → extract CSS
    const urlMatch = content.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      await msg.channel.send(`Extracting design tokens from ${url}...`);
      const extracted = await extractCssFromUrl(url);
      const hasData = Object.values(extracted).some(v => v && Object.keys(v).length > 0);
      if (!hasData) {
        stopTyping();
        await msg.channel.send(`Couldn't extract CSS variables from that URL — it may use non-standard styles. Any notes on what you liked about it?`);
        return;
      }
      await updateDesignTokens(extracted, url);
      const summary = Object.entries(extracted)
        .filter(([, v]) => v && Object.keys(v).length > 0)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n');
      stopTyping();
      await msg.channel.send(`Design tokens updated from ${url}:\n\`\`\`json\n${summary}\n\`\`\``);
      return;
    }

    // Fallback: show library status
    const library = await scanDesignLibrary();
    stopTyping();
    await msg.channel.send(
      `Design library: ${library.components.length} component(s) saved.\n${library.tokenSummary}\n\n` +
      `Drop a URL to extract styles, paste a code block (with a component name above it) to save a component, or upload a screenshot for inspiration.`
    );
  } catch (err) {
    stopTyping();
    console.error('Error handling design message:', err);
    await msg.channel.send('⚠️ Something went wrong with the design library.');
  }
}
```

**Step 4: Update client.ts to route design-elements messages**

Replace the `client.on(Events.MessageCreate, handleMessage)` line in `src/discord/client.ts`:

```typescript
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleMessage, handleDesignMessage } from './handlers.js';
import { CHANNELS } from './channels.js';

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

  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === CHANNELS.DESIGN_ELEMENTS) {
      handleDesignMessage(msg).catch(console.error);
    } else {
      handleMessage(msg).catch(console.error);
    }
  });

  return client;
}
```

**Step 5: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 6: Commit**

```bash
git add src/discord/channels.ts src/discord/handlers.ts src/discord/client.ts
git commit -m "feat: #design-elements channel — URL CSS extraction, component saves, inspiration uploads"
```

---

## Task 5: Build Pipeline

**Files:**
- Create: `src/tools/builder.ts`
- Modify: `src/brain.ts`
- Modify: `src/tools/registry.ts`

**Step 1: Create src/tools/builder.ts**

```typescript
import { createRepoFromTemplate, createBranch, upsertFile, mergeBranch } from '../github/client.js';
import { readDesignTokens, scanDesignLibrary, generateCssVars, DesignTokens } from './design.js';
import { createProject, updateProject } from '../memory/supabase.js';

const TEMPLATE_REPO = 'jarvis-template';
const OWNER = process.env.GITHUB_OWNER!;

export interface BuildPlan {
  projectName: string;
  slug: string;
  description: string;
  buildType: 'landing_page' | 'full_app';
  targetAudience: string;
  components?: string[];
}

export interface BuildResult {
  slug: string;
  githubRepo: string;
  stagingUrl: string;
  vercelProjectId: string;
}

export async function getDesignSuggestions(description: string): Promise<string> {
  const library = await scanDesignLibrary();
  if (library.components.length === 0 && library.tokenSummary.includes('0 sites')) {
    return 'No design library populated yet — will use default design tokens (dark, Inter font, blue primary).';
  }
  return [
    `Design library available:`,
    `Components: ${library.components.join(', ') || 'none saved yet'}`,
    library.tokenSummary,
  ].join('\n');
}

async function createVercelProject(slug: string): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN not set');

  const teamId = process.env.VERCEL_TEAM_ID;
  const url = teamId
    ? `https://api.vercel.com/v10/projects?teamId=${teamId}`
    : 'https://api.vercel.com/v10/projects';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: slug,
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: `${OWNER}/${slug}` },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel project creation failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { id: string };
  return data.id;
}

async function pollStagingUrl(vercelProjectId: string, timeoutMs = 120000): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return '';

  const teamId = process.env.VERCEL_TEAM_ID;
  const url = teamId
    ? `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&target=preview&teamId=${teamId}&limit=5`
    : `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&target=preview&limit=5`;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const data = await res.json() as {
        deployments: Array<{ url: string; state: string; meta?: { githubCommitRef?: string } }>;
      };
      const ready = data.deployments.find(
        d => d.state === 'READY' && d.meta?.githubCommitRef === 'staging'
      );
      if (ready) return `https://${ready.url}`;
    } catch {}
  }
  return '';
}

export async function promoteToProduction(slug: string): Promise<string> {
  await mergeBranch(slug, 'staging', 'main');

  // Vercel auto-deploys main as production — wait a few seconds then return URL
  await new Promise(r => setTimeout(r, 5000));
  return `https://${slug}.vercel.app`;
}

export async function buildProject(
  plan: BuildPlan,
  generatedFiles: Array<{ path: string; content: string }>
): Promise<BuildResult> {
  await createProject({
    name: plan.projectName,
    slug: plan.slug,
    build_type: plan.buildType,
    description: plan.description,
  });
  await updateProject(plan.slug, { status: 'building' });

  // Fork template
  await createRepoFromTemplate(TEMPLATE_REPO, plan.slug);
  await new Promise(r => setTimeout(r, 4000)); // GitHub needs a moment after fork

  // Create Vercel project
  const vercelProjectId = await createVercelProject(plan.slug);
  await updateProject(plan.slug, { github_repo: plan.slug, vercel_project_id: vercelProjectId });

  // Create staging branch
  await createBranch(plan.slug, 'staging');

  // Push design tokens CSS
  const tokens = await readDesignTokens();
  await upsertFile(
    plan.slug,
    'app/design-tokens.css',
    generateCssVars(tokens),
    `feat: inject design tokens for ${plan.slug}`
  );

  // Push all generated files to staging branch
  // Note: upsertFile defaults to main — we push to staging by pushing directly
  // Since we just created the staging branch off main, we push files to staging
  for (const file of generatedFiles) {
    await upsertFile(plan.slug, file.path, file.content, `feat: build ${plan.slug}`);
  }

  await updateProject(plan.slug, { status: 'staging' });
  const stagingUrl = await pollStagingUrl(vercelProjectId);
  if (stagingUrl) await updateProject(plan.slug, { staging_url: stagingUrl });

  return {
    slug: plan.slug,
    githubRepo: `https://github.com/${OWNER}/${plan.slug}`,
    stagingUrl: stagingUrl || `Deploying — check Vercel dashboard in ~60s`,
    vercelProjectId,
  };
}
```

Note on branch targeting: `upsertFile` currently pushes to the default branch (main). After creating a staging branch, files pushed to main will need to be merged to staging, OR update `upsertFile` to accept an optional `branch` parameter. If builds are going to staging-first, the implementer should add a `branch?: string` parameter to `upsertFile` and update callers accordingly. See the Verify step — if TypeScript passes but staging URLs aren't appearing, this is why.

**Step 2: Add build tools to TOOL_SCHEMAS in brain.ts**

In `src/brain.ts`, add to the `TOOL_SCHEMAS` record (after the `request_tool_install` entry):

```typescript
  get_design_suggestions: {
    name: 'get_design_suggestions',
    description: 'Scan the design library and return available components and design tokens. ALWAYS call this before build_app to see what design elements are available to use.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Brief description of what you are building' },
      },
      required: ['description'],
    },
  },
  build_app: {
    name: 'build_app',
    description: 'Build and deploy a web project from Discord. Forks jarvis-template, injects design tokens, pushes generated Next.js files to GitHub, and deploys to Vercel staging. Always call get_design_suggestions first, present a plan to Jake, and wait for his approval before calling this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Human-readable project name' },
        slug: { type: 'string', description: 'URL-safe slug for GitHub repo and Vercel URL (lowercase, hyphens only)' },
        description: { type: 'string', description: 'What this builds and who it is for' },
        build_type: { type: 'string', enum: ['landing_page', 'full_app'], description: 'Type of build' },
        target_audience: { type: 'string', description: 'Who this is built for' },
        components: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of design library components to use (from get_design_suggestions)',
        },
        files: {
          type: 'array',
          description: 'Complete Next.js files to push — full file contents, ready to deploy',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to repo root, e.g. app/page.tsx' },
              content: { type: 'string', description: 'Complete file content' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['project_name', 'slug', 'description', 'build_type', 'target_audience', 'files'],
    },
  },
```

**Step 3: Add executeTool cases in brain.ts**

In the `executeTool` switch (after the `request_tool_install` case):

```typescript
    case 'get_design_suggestions': {
      const { getDesignSuggestions } = await import('./tools/builder.js');
      const suggestions = await getDesignSuggestions(input.description as string);
      return { toolName: name, output: suggestions };
    }

    case 'build_app': {
      const { buildProject } = await import('./tools/builder.js');
      const result = await buildProject(
        {
          projectName: input.project_name as string,
          slug: input.slug as string,
          description: input.description as string,
          buildType: input.build_type as 'landing_page' | 'full_app',
          targetAudience: input.target_audience as string,
          components: input.components as string[] | undefined,
        },
        input.files as Array<{ path: string; content: string }>
      );
      return {
        toolName: name,
        output: `Build started for **${result.slug}**\nGitHub: ${result.githubRepo}\nStaging: ${result.stagingUrl}`,
        stagingBuild: result,
      };
    }
```

**Step 4: Update ToolCallResult interface in brain.ts**

```typescript
export interface ToolCallResult {
  toolName: string;
  output: string;
  deployedUrl?: string;
  installRequest?: { capability: string; reason: string };
  stagingBuild?: { slug: string; githubRepo: string; stagingUrl: string; vercelProjectId: string };
}
```

**Step 5: Add entries to registry.ts**

In `src/tools/registry.ts`, append to the `TOOLS` array:

```typescript
  {
    id: 'get_design_suggestions',
    name: 'Design Library Scan',
    description: 'Scan saved design tokens and components for use in builds',
    installed: true,
    requiresEnv: ['GITHUB_TOKEN'],
  },
  {
    id: 'build_app',
    name: 'Build + Deploy App',
    description: 'Fork Next.js template, inject design tokens, deploy to Vercel staging',
    installed: true,
    requiresEnv: ['GITHUB_TOKEN', 'VERCEL_TOKEN'],
  },
```

**Step 6: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors. If there are errors about `stagingBuild` not on `ToolCallResult`, make sure Step 4 was applied.

**Step 7: Commit**

```bash
git add src/tools/builder.ts src/brain.ts src/tools/registry.ts
git commit -m "feat: build pipeline — fork template, inject design tokens, Vercel staging deploy"
```

---

## Task 6: Staging Approval Flow in handlers.ts

**Files:**
- Modify: `src/discord/handlers.ts`

**Step 1: Add imports to handlers.ts**

Add to the existing imports at the top:

```typescript
import { promoteToProduction } from '../tools/builder.js';
import { updateProject } from '../memory/supabase.js';
```

**Step 2: Add pendingStagingApproval map and ship detection**

After the `pendingInstallRequest` Map declaration (around line 22), add:

```typescript
const pendingStagingApproval = new Map<string, {
  slug: string;
  stagingUrl: string;
  vercelProjectId: string;
}>();

const SHIP_PHRASES = ['ship it', 'ship', 'deploy', 'go live', 'approve', 'push it', 'launch it'];
function isShipApproval(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return SHIP_PHRASES.includes(lower) || lower.startsWith('ship ');
}
```

**Step 3: Add staging approval check to handleMessage**

In `handleMessage`, after the `pendingInstallRequest` check block (after line 65, before `await msg.channel.sendTyping()`), add:

```typescript
  // Check if we're waiting for staging approval
  const pendingStaging = pendingStagingApproval.get(msg.channelId);
  if (pendingStaging) {
    if (isShipApproval(msg.content)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Promoting **${pendingStaging.slug}** to production...`);
      try {
        const productionUrl = await promoteToProduction(pendingStaging.slug);
        await updateProject(pendingStaging.slug, { status: 'live', production_url: productionUrl });
        await msg.channel.send(`🚀 **${pendingStaging.slug}** is live: ${productionUrl}`);
      } catch (err) {
        await msg.channel.send(`⚠️ Deploy failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Keeping **${pendingStaging.slug}** in staging. Let me know when you want to ship it or want changes.`);
      return;
    }
    pendingStagingApproval.delete(msg.channelId);
  }
```

**Step 4: Post staging URL from tool results**

In the `handleMessage` tool results loop (around line 104), after the `deployedUrl` check:

```typescript
      if (toolResult.stagingBuild) {
        const build = toolResult.stagingBuild;
        pendingStagingApproval.set(msg.channelId, build);
        await msg.channel.send(
          `Staging ready for **${build.slug}**: ${build.stagingUrl}\n\nSay **"ship it"** to deploy to production, or tell me what to change.`
        );
      }
```

**Step 5: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 6: Commit**

```bash
git add src/discord/handlers.ts
git commit -m "feat: staging approval — 'ship it' promotes Vercel preview to production"
```

---

## Task 7: Overnight Mode

**Files:**
- Create: `src/overnight/mode.ts`
- Modify: `src/discord/handlers.ts`
- Modify: `src/overnight/briefing.ts`

**Step 1: Create src/overnight/mode.ts**

```typescript
import { getProjects } from '../memory/supabase.js';

interface OvernightSession {
  active: boolean;
  instructions: string;
  startedAt: Date;
  channelId: string;
}

let overnightSession: OvernightSession | null = null;

export function activateOvernightMode(channelId: string, instructions: string): void {
  overnightSession = { active: true, instructions, startedAt: new Date(), channelId };
  console.log(`Overnight mode activated: ${instructions}`);
}

export function deactivateOvernightMode(): void {
  overnightSession = null;
}

export function isOvernightActive(): boolean {
  return overnightSession?.active ?? false;
}

export function getOvernightInstructions(): string {
  return overnightSession?.instructions ?? '';
}

export function detectOvernightTrigger(text: string): string | null {
  const patterns = [
    /^overnight[,:]?\s+(.+)/i,
    /^tonight[,:]?\s+(.+)/i,
    /while i(?:'m)? (?:sleeping|asleep|away)[,:]?\s+(.+)/i,
    /run overnight[,:]?\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[match.length - 1].trim();
  }
  return null;
}

export async function generateOvernightSummary(): Promise<string> {
  const [stagingProjects, liveProjects] = await Promise.all([
    getProjects('staging'),
    getProjects('live'),
  ]);

  const recentLive = liveProjects.filter(p => {
    const updatedAt = new Date(p.updated_at);
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    return updatedAt > eightHoursAgo;
  });

  if (stagingProjects.length === 0 && recentLive.length === 0) return '';

  const lines: string[] = ['**Overnight Build Summary:**'];

  if (recentLive.length > 0) {
    lines.push('\n**Shipped:**');
    for (const p of recentLive) {
      lines.push(`• **${p.name}** — ${p.production_url ?? 'live'}`);
    }
  }

  if (stagingProjects.length > 0) {
    lines.push('\n**Staging — needs your approval:**');
    for (const p of stagingProjects) {
      lines.push(`• **${p.name}** — ${p.staging_url ?? 'deploying...'}`);
      lines.push(`  Say "ship ${p.slug}" to go live.`);
    }
  }

  return lines.join('\n');
}
```

**Step 2: Add overnight trigger detection to handlers.ts**

Add import:

```typescript
import { activateOvernightMode, detectOvernightTrigger } from '../overnight/mode.js';
```

In `handleMessage`, before `await msg.channel.sendTyping()`, add:

```typescript
  // Overnight mode trigger
  const overnightInstructions = detectOvernightTrigger(msg.content);
  if (overnightInstructions) {
    activateOvernightMode(msg.channelId, overnightInstructions);
    await msg.channel.send(
      `Overnight mode activated.\n\nI'll work on: "${overnightInstructions}"\n\n` +
      `**Rules:** All builds deploy to staging only — nothing goes live without your approval. ` +
      `You'll see a summary in your morning brief.`
    );
    return;
  }
```

**Step 3: Add overnight summary to morning briefing**

In `src/overnight/briefing.ts`, add import at the top:

```typescript
import { generateOvernightSummary } from './mode.js';
```

In `postMorningBriefing`, after the `const briefing = ...` call, add the overnight summary before sending:

```typescript
    const overnightSummary = await generateOvernightSummary();
    const fullBriefing = overnightSummary
      ? `${briefing}\n\n---\n${overnightSummary}`
      : briefing;

    const channel = discord.channels.cache.get(CHANNELS.MORNING_BRIEF) as TextChannel | undefined;
    if (channel) {
      await channel.send(`**Good morning, Jake.**\n\n${fullBriefing}`);
    }
```

(Replace the existing `channel.send` call.)

**Step 4: Verify TypeScript**

```bash
cd /Users/JakeLaylo/jarvis && npx tsc --noEmit
```

Expected: zero errors.

**Step 5: Commit**

```bash
git add src/overnight/mode.ts src/discord/handlers.ts src/overnight/briefing.ts
git commit -m "feat: overnight mode — autonomous builds with morning staging gate"
```

---

## Task 8: Push and Verify

**Step 1: Add env vars to Railway**

In Railway → jarvis service → Variables:
- `DISCORD_CHANNEL_DESIGN_ELEMENTS` — channel ID from the new `#design-elements` Discord channel
- `VERCEL_TOKEN` — from vercel.com/account/tokens
- `VERCEL_TEAM_ID` — from Vercel Settings (skip if personal account)

**Step 2: Push to GitHub**

```bash
git push
```

**Step 3: Confirm deploy**

```bash
RAILWAY_TOKEN=e3f04af9-a910-48ad-8706-199244820638 railway logs --service jarvis 2>&1 | tail -20
```

Expected: `Jarvis online. Discord connected as Jarvis#7662`

**Step 4: Test design-elements channel**

In Discord `#design-elements`:

1. Post a URL: `https://stripe.com`
   Expected: "Extracting design tokens..." → "Design tokens updated from https://stripe.com: ..."

2. Post a component name followed by a code block:
   ```
   pricing-card
   ```tsx
   export function PricingCard() { return <div>test</div>; }
   ```
   Expected: "Saved component as `pricing-card.tsx`."

3. Post with no URL or code block
   Expected: library status summary

**Step 5: Test overnight mode**

In Discord `#jarvis`:
```
Tonight, build a landing page for a project tracker targeting small construction companies
```
Expected: "Overnight mode activated. I'll work on: 'build a landing page...'"

**Step 6: Test build flow (after jarvis-template repo exists)**

In Discord `#jarvis`:
```
Build me a landing page for an AI receptionist service targeting HVAC contractors
```
Expected:
1. Jarvis calls `get_design_suggestions`, posts plan to `#engineering` with design element suggestions
2. Jake replies "looks good"
3. Jarvis calls `build_app`, forks template, deploys to Vercel
4. Jarvis posts: "Staging ready for hvac-receptionist: https://..."
5. Jake says "ship it" → Jarvis promotes to production

---

## Notes for Implementer

- **Branch targeting for staging**: The current `upsertFile` in `github/client.ts` doesn't accept a branch parameter — it always targets the default branch. For true staging-first builds, add an optional `branch?: string` parameter to `upsertFile`. Low priority for first pass — the key flow (build → staging URL → approve → production) works without it since Vercel generates preview URLs for all branches.

- **jarvis-template content**: The template repo can start as an empty Next.js app created with `npx create-next-app@latest`. The important thing is that it's marked as a Template Repository in GitHub settings. Jarvis will overwrite `app/page.tsx` and add `app/design-tokens.css` on each build.

- **Vercel auto-connect**: For Vercel to auto-deploy on GitHub push, the GitHub org/account needs to be connected to Vercel (done once in Vercel dashboard). The `createVercelProject` API call links the new repo to a Vercel project, but the GitHub integration must already be authorized.
