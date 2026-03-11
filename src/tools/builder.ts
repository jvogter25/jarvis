import { createRepoFromTemplate, createBranch, upsertFile, mergeBranch } from '../github/client.js';
import { readDesignTokens, scanDesignLibrary, generateCssVars } from './design.js';
import { createProject, updateProject } from '../memory/supabase.js';
import { isOvernightActive } from '../overnight/mode.js';
import { think } from '../brain.js';
import { runNextjsPreview } from '../sandbox/client.js';
import { emitDashboardEvent } from '../dashboard/events.js';

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
  const tokens = await readDesignTokens();
  if (library.components.length === 0 && tokens.sources.length === 0) {
    return 'No design library populated yet — will use default design tokens (dark theme, Inter font, blue primary).';
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

async function pollStagingUrl(vercelProjectId: string, timeoutMs = 180000): Promise<string> {
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
    } catch (err) {
      console.error('pollStagingUrl error:', err);
    }
  }
  return '';
}

export async function promoteToProduction(slug: string): Promise<string> {
  if (isOvernightActive()) {
    throw new Error('Overnight mode is active — production deploys are blocked until you deactivate it. Say "deactivate overnight mode" to unlock.');
  }
  await mergeBranch(slug, 'staging', 'main');
  await new Promise(r => setTimeout(r, 5000));
  return `https://${slug}.vercel.app`;
}

/**
 * For full_app builds: run TypeScript compilation check in E2B against the generated files.
 * Returns list of errors (empty = clean). Up to 3 fix iterations.
 */
async function runTypeScriptCheck(
  files: Array<{ path: string; content: string }>
): Promise<Array<{ path: string; content: string }>> {
  const { runShell } = await import('./shell.js');

  const tsFiles = files.filter(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  if (tsFiles.length === 0) return files;

  let currentFiles = [...files];

  for (let attempt = 0; attempt < 3; attempt++) {
    // Write files to E2B and run tsc
    const shellFiles = currentFiles.map(f => ({ path: f.path, content: f.content }));
    // Write a minimal tsconfig if not already present
    if (!currentFiles.find(f => f.path === 'tsconfig.json')) {
      shellFiles.push({
        path: 'tsconfig.json',
        content: JSON.stringify({
          compilerOptions: {
            target: 'es2017', lib: ['es2017'], module: 'commonjs',
            jsx: 'react-jsx', strict: false, noEmit: true,
            skipLibCheck: true, moduleResolution: 'node',
          },
          include: ['**/*.ts', '**/*.tsx'],
          exclude: ['node_modules'],
        }, null, 2),
      });
    }

    const result = await runShell(
      ['npm install --save-dev typescript @types/react @types/node --quiet 2>/dev/null', 'npx tsc --noEmit 2>&1 || true'],
      shellFiles
    );

    const output = result.stdout + result.stderr;
    const errorLines = output.split('\n').filter(l => l.includes('error TS'));

    if (errorLines.length === 0) break; // clean

    console.log(`TypeScript check attempt ${attempt + 1}: ${errorLines.length} errors, asking Claude to fix...`);

    // Ask Claude to fix the errors
    const errorSummary = errorLines.slice(0, 30).join('\n');
    const fileContents = currentFiles
      .filter(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'))
      .map(f => `// ${f.path}\n${f.content}`)
      .join('\n\n---\n\n');

    const fixPrompt = `Fix these TypeScript compilation errors in the Next.js project files.

Errors:
${errorSummary}

Current files:
${fileContents.slice(0, 12000)}

Return the fixed files as a JSON array: [{"path": "...", "content": "..."}]
Only include files that changed. Return JSON only, no markdown.`;

    try {
      const fixResult = await think('You are a TypeScript expert fixing compilation errors.', [], fixPrompt, { model: 'sonnet', noTools: true });
      const fixedFiles = JSON.parse(fixResult.text) as Array<{ path: string; content: string }>;
      // Merge fixes back into currentFiles
      for (const fix of fixedFiles) {
        const idx = currentFiles.findIndex(f => f.path === fix.path);
        if (idx >= 0) currentFiles[idx] = fix;
        else currentFiles.push(fix);
      }
    } catch {
      break; // If Claude can't fix, proceed with what we have
    }
  }

  return currentFiles;
}

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

  // Dedup slug
  const { getProject } = await import('../memory/supabase.js');
  let uniqueSlug = plan.slug;
  let attempt = 2;
  while (await getProject(uniqueSlug)) {
    uniqueSlug = `${plan.slug}-${attempt++}`;
  }
  plan.slug = uniqueSlug;

  console.log(`[preview] Starting E2B preview for ${plan.slug}...`);

  // TypeScript validation (only for full_app builds)
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

export async function buildProject(
  plan: BuildPlan,
  generatedFiles: Array<{ path: string; content: string }>,
  skipValidation = false
): Promise<BuildResult> {
  // Sanitize slug: lowercase, hyphens only
  plan.slug = plan.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // If slug already exists in Supabase, append -2, -3, etc.
  const { getProject } = await import('../memory/supabase.js');
  let uniqueSlug = plan.slug;
  let attempt = 2;
  while (await getProject(uniqueSlug)) {
    uniqueSlug = `${plan.slug}-${attempt++}`;
  }
  plan.slug = uniqueSlug;

  console.log(`[build] Starting build for ${plan.slug} (${plan.buildType}), ${generatedFiles.length} files`);
  emitDashboardEvent({ type: 'build_step', room: 'engineering', agent: 'builder', task: `Starting build: ${plan.slug}`, data: { slug: plan.slug } });

  await createProject({
    name: plan.projectName,
    slug: plan.slug,
    build_type: plan.buildType,
    description: plan.description,
  });
  await updateProject(plan.slug, { status: 'building' });
  console.log(`[build] Project record created in Supabase`);

  // Fork template
  console.log(`[build] Forking template ${TEMPLATE_REPO}...`);
  emitDashboardEvent({ type: 'build_step', room: 'engineering', agent: 'builder', task: `Forking template → ${plan.slug}` });
  await createRepoFromTemplate(TEMPLATE_REPO, plan.slug);
  await new Promise(r => setTimeout(r, 4000));
  console.log(`[build] Repo forked: github.com/${OWNER}/${plan.slug}`);

  // Create Vercel project
  console.log(`[build] Creating Vercel project...`);
  emitDashboardEvent({ type: 'build_step', room: 'engineering', agent: 'builder', task: `Creating Vercel project: ${plan.slug}` });
  const vercelProjectId = await createVercelProject(plan.slug);
  await updateProject(plan.slug, { github_repo: plan.slug, vercel_project_id: vercelProjectId });
  console.log(`[build] Vercel project created: ${vercelProjectId}`);

  // Create staging branch
  console.log(`[build] Creating staging branch...`);
  await createBranch(plan.slug, 'staging');
  console.log(`[build] Staging branch created`);

  // For full_app builds: run TypeScript validation loop before pushing
  let filesToPush = generatedFiles;
  if (plan.buildType === 'full_app' && !skipValidation) {
    console.log(`[build] Running TypeScript validation...`);
    filesToPush = await runTypeScriptCheck(generatedFiles);
    console.log(`[build] TypeScript validation complete`);
  }

  // Push design tokens CSS and all generated files to staging branch
  console.log(`[build] Pushing ${filesToPush.length} files to staging branch...`);
  const tokens = await readDesignTokens();
  await upsertFile(
    plan.slug,
    'app/design-tokens.css',
    generateCssVars(tokens),
    `feat: inject design tokens for ${plan.slug}`,
    'staging'
  );

  for (const file of filesToPush) {
    console.log(`[build] Pushing ${file.path}`);
    await upsertFile(plan.slug, file.path, file.content, `feat: build ${plan.slug}`, 'staging');
  }
  console.log(`[build] All files pushed`);

  await updateProject(plan.slug, { status: 'staging' });
  console.log(`[build] Polling for staging URL (up to 2min)...`);
  emitDashboardEvent({ type: 'build_step', room: 'engineering', agent: 'builder', task: `Deploying to Vercel staging: ${plan.slug}` });
  const stagingUrl = await pollStagingUrl(vercelProjectId);
  if (stagingUrl) await updateProject(plan.slug, { staging_url: stagingUrl });
  console.log(`[build] Staging URL: ${stagingUrl || 'not ready yet'}`);

  emitDashboardEvent({
    type: 'build_complete',
    room: 'engineering',
    agent: 'builder',
    task: `Build complete: ${plan.slug}${stagingUrl ? ' → ' + stagingUrl : ''}`,
    data: { slug: plan.slug, stagingUrl },
  });

  return {
    slug: plan.slug,
    githubRepo: `https://github.com/${OWNER}/${plan.slug}`,
    stagingUrl: stagingUrl || `Deploying — check Vercel dashboard in ~60s`,
    vercelProjectId,
  };
}
