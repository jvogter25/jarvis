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
  const REPO_CONTEXT = `Jarvis repo structure:
- src/brain.ts — Claude API loop, tool schemas and executors
- src/discord/handlers.ts — Discord message routing and approval flows
- src/tools/ — individual tool files (shell.ts, browser.ts, search.ts, builder.ts, slack.ts, self-modify.ts, etc.)
- src/memory/supabase.ts — Supabase queries
- src/overnight/ — cron tasks (trainer.ts, briefing.ts, product-pulse.ts, tool-discovery.ts)
- src/github/client.ts — GitHub API helpers
- src/index.ts — main entry, cron schedule
- src/tools/registry.ts — tool definitions list

CRITICAL: All local imports must use .js extensions (ESM). Use process.env.X for all secrets. No hardcoded values.`;

  // Step 1: Generate a manifest — paths + plans, no content (keeps response small)
  const manifestPrompt = `You are a TypeScript/Node.js expert planning production code for Jarvis, an AI orchestrator running on Railway (Node.js ESM).

${REPO_CONTEXT}

Task: ${intent}

Plan all files you need to create or modify. Return a manifest with paths and a brief plan per file. Do NOT write file content yet.

Return JSON only, no markdown:
{
  "files": [{"path": "src/tools/resend.ts", "plan": "Wraps the Resend API. Exports sendEmail(to, subject, body). Uses process.env.RESEND_API_KEY."}],
  "npmPackage": "resend",
  "envVarName": "RESEND_API_KEY",
  "summary": "plain-English 1-sentence summary of what will be built"
}
If no npm package is needed, omit "npmPackage". If no env var is needed, omit "envVarName".`;

  const manifestResult = await think(
    'You are a TypeScript expert planning production tools for an AI orchestrator.',
    [],
    manifestPrompt,
    { model: 'sonnet', noTools: true }
  );

  let manifest: {
    files: Array<{ path: string; plan: string }>;
    npmPackage?: string;
    envVarName?: string;
    summary: string;
  };
  try {
    manifest = JSON.parse(manifestResult.text);
  } catch {
    throw new Error(`Manifest generation failed. Raw: ${manifestResult.text.slice(0, 300)}`);
  }

  console.log(`[self-modify] Manifest: ${manifest.files.length} file(s) planned`);

  // Step 2: Generate each file's content in a separate call (no truncation risk)
  const generatedFiles: Array<{ path: string; content: string }> = [];

  for (const fileSpec of manifest.files) {
    console.log(`[self-modify] Generating: ${fileSpec.path}`);

    const contentPrompt = `You are a TypeScript/Node.js expert writing a production file for Jarvis, an AI orchestrator running on Railway (Node.js ESM).

${REPO_CONTEXT}

Overall task: ${intent}

Write the complete content for this specific file:
Path: ${fileSpec.path}
Plan: ${fileSpec.plan}

Return ONLY the complete file content — raw TypeScript/JavaScript, no JSON wrapper, no markdown fences, no explanation. Just the code.`;

    const contentResult = await think(
      'You are a TypeScript expert writing production code for an AI orchestrator. Return only the file content, no explanations.',
      [],
      contentPrompt,
      { model: 'sonnet', noTools: true, maxTokens: 16000 }
    );

    // Strip any accidental markdown fences
    const content = contentResult.text
      .replace(/^```(?:typescript|javascript|ts|js)?\n/m, '')
      .replace(/\n```$/m, '')
      .trim();

    generatedFiles.push({ path: fileSpec.path, content });
  }

  const generated = {
    files: generatedFiles,
    npmPackage: manifest.npmPackage,
    envVarName: manifest.envVarName,
    summary: manifest.summary,
  };

  // Step 3: Opus reviews the generated code
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
    { model: 'opus', noTools: true, maxTokens: 32000 }
  );

  let review: { approved: boolean; notes: string; fixes?: Array<{ path: string; content: string }> };
  try {
    review = JSON.parse(reviewResult.text);
  } catch {
    review = { approved: true, notes: 'Review parse failed — proceeding with generated code.' };
  }

  // Log a warning if reviewer flagged issues but provided no fixes
  if (!review.approved && (!review.fixes || review.fixes.length === 0)) {
    console.warn('[self-modify] Opus reviewer flagged issues but provided no fixes — proceeding with generated code. Review notes:', review.notes);
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
  const { getFileContent } = await import('../github/client.js');
  const raw = await getFileContent('jarvis', 'package.json');
  if (!raw) throw new Error('package.json not found in jarvis repo');

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
