import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { rm, readFile } from 'fs/promises';
import path from 'path';
import { planCodingTask } from './task-planner.js';

const execAsync = promisify(exec);

const SDK_TIMEOUT_MS = 20 * 60 * 1000;  // 20 min abort threshold

export interface ClaudeCodeResult {
  success: boolean;
  files: Array<{ path: string; content: string }>;
  reviewNotes: string;
  checkpointBranch?: string;
  testReport?: string;
}

export type NotifyFn = (msg: string) => Promise<void>;

/** No-op: E2B sandboxes no longer used. Kept for compatibility with emergency.ts */
export async function killAllSandboxes(): Promise<number> {
  console.log('[claude-code] killAllSandboxes: SDK mode — no sandboxes to kill');
  return 0;
}

export async function runClaudeCodeAgent(intent: string, notify?: NotifyFn): Promise<ClaudeCodeResult> {
  const OWNER = process.env.GITHUB_OWNER!;
  const REPO = 'jarvis';
  const ts = Date.now();
  const workDir = `/tmp/jarvis-work-${ts}`;
  const checkpointBranch = `claude-code/output-${ts}`;

  try {
    // Plan: get relevant file paths (no content embedding)
    console.log('[claude-code] Planning task...');
    const subtasks = await planCodingTask(intent);
    const relevantPaths = subtasks[0]?.relevantFiles ?? [];
    console.log(`[claude-code] Relevant file hints: ${relevantPaths.join(', ') || '(none)'}`);

    // Clone repo to /tmp — much faster than E2B spin-up
    await notify?.('⚙️ **Claude Code starting** — cloning repo...').catch(() => {});
    console.log(`[claude-code] Cloning to ${workDir}...`);
    const token = process.env.GITHUB_TOKEN!;
    await execAsync(
      `git clone --depth 1 https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git ${workDir}`,
      { timeout: 90_000 }
    );
    await execAsync('git config user.email "jarvis@jarvis.local"', { cwd: workDir });
    await execAsync('git config user.name "Jarvis"', { cwd: workDir });
    console.log('[claude-code] Clone complete');

    // Lean prompt: file path hints only, no embedded content (~200 bytes vs 32KB)
    const fileHints = relevantPaths.length > 0
      ? `\nRelevant files to look at first (read them yourself):\n${relevantPaths.map(p => `- ${p}`).join('\n')}\n`
      : '';
    const prompt =
      `Task: ${intent}${fileHints}\n` +
      `Repo is at: ${workDir}\n` +
      `When done, commit all changes with message: "claude-code: ${intent.slice(0, 72)}"`;

    console.log('[claude-code] SDK query starting...');
    console.log('[claude-code] Prompt length:', prompt.length, 'bytes');
    await notify?.(`🔍 **Prompt ready** (${prompt.length} bytes). Starting SDK query...`).catch(() => {});

    // Run Claude Code SDK in-process with AbortController timeout
    const { query } = await import('@anthropic-ai/claude-code');
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
      console.error('[claude-code] SDK timed out after 20 minutes — aborting');
    }, SDK_TIMEOUT_MS);

    try {
      for await (const msg of query({
        prompt,
        abortController,
        options: {
          cwd: workDir,
          allowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'],
        },
      })) {
        await handleSdkMessage(msg, notify);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Push checkpoint branch to GitHub
    console.log(`[claude-code] Pushing branch ${checkpointBranch}...`);
    await execAsync(
      `git push https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git HEAD:${checkpointBranch}`,
      { cwd: workDir, timeout: 60_000 }
    ).catch(err => console.warn('[claude-code] Push failed:', (err as Error).message));

    // Extract modified files for self-modify PR flow
    const files = await extractModifiedFiles(workDir);
    console.log(`[claude-code] Done — ${files.length} file(s) modified`);
    await notify?.(
      `✅ **Claude Code done** — ${files.length} file(s) modified.\nBranch: \`${checkpointBranch}\``
    ).catch(() => {});

    return {
      success: true,
      files,
      reviewNotes: `Claude Code completed. ${files.length} file(s) modified.`,
      checkpointBranch,
    };

  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error('[claude-code] Failed:', message);
    await notify?.(`❌ **Claude Code failed**: ${message.slice(0, 200)}`).catch(() => {});
    return {
      success: false,
      files: [],
      reviewNotes: `Claude Code agent failed: ${message}`,
      checkpointBranch,
    };

  } finally {
    // Always clean up /tmp workdir
    if (existsSync(workDir)) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      console.log(`[claude-code] Cleaned up ${workDir}`);
    }
  }
}

async function handleSdkMessage(msg: any, notify?: NotifyFn): Promise<void> {
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        const text: string = block.text;
        console.log('[claude-code] text:', text.slice(0, 200));
        const truncated = text.length > 1500 ? text.slice(0, 1500) + '...' : text;
        await notify?.(`\`\`\`\n${truncated}\n\`\`\``).catch(() => {});
      } else if (block.type === 'tool_use') {
        const inputStr = JSON.stringify(block.input ?? {});
        const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr;
        console.log(`[claude-code] tool:${block.name} ${preview}`);
        await notify?.(`\`[tool:${block.name}]\` ${preview}`).catch(() => {});
      }
    }
  } else if (msg.type === 'result') {
    const result: string = msg.result ?? '';
    console.log('[claude-code] result:', result.slice(0, 200));
  } else if (msg.type === 'system') {
    console.log('[claude-code] system:', JSON.stringify(msg).slice(0, 200));
  }
}

async function extractModifiedFiles(workDir: string): Promise<Array<{ path: string; content: string }>> {
  let changedPaths: string[] = [];
  try {
    const { stdout } = await execAsync('git diff --name-only origin/main HEAD', { cwd: workDir });
    changedPaths = stdout.trim().split('\n').filter(Boolean);
  } catch {
    try {
      // Fallback: any uncommitted changes
      const { stdout } = await execAsync('git status --porcelain', { cwd: workDir });
      changedPaths = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).trim());
    } catch { /* ignore */ }
  }

  const files: Array<{ path: string; content: string }> = [];
  for (const relativePath of changedPaths) {
    try {
      const content = await readFile(path.join(workDir, relativePath), 'utf-8');
      files.push({ path: relativePath, content });
    } catch {
      console.warn(`[claude-code] Could not read modified file: ${relativePath}`);
    }
  }
  return files;
}
