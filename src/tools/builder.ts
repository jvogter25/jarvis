import { createRepoFromTemplate, createBranch, upsertFile, mergeBranch } from '../github/client.js';
import { readDesignTokens, scanDesignLibrary, generateCssVars } from './design.js';
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
  await new Promise(r => setTimeout(r, 4000));

  // Create Vercel project
  const vercelProjectId = await createVercelProject(plan.slug);
  await updateProject(plan.slug, { github_repo: plan.slug, vercel_project_id: vercelProjectId });

  // Create staging branch
  await createBranch(plan.slug, 'staging');

  // Push design tokens CSS to main (template base)
  const tokens = await readDesignTokens();
  await upsertFile(
    plan.slug,
    'app/design-tokens.css',
    generateCssVars(tokens),
    `feat: inject design tokens for ${plan.slug}`
  );

  // Push all generated files
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
