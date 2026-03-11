import { exec, spawn } from 'child_process';
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

    console.log('[claude-code] Spawning Claude Code CLI...');
    console.log('[claude-code] Prompt length:', prompt.length, 'bytes');
    await notify?.(`🔍 **Prompt ready** (${prompt.length} bytes). Starting Claude Code...`).catch(() => {});

    // Spawn Claude Code CLI directly on Railway — stdio:'pipe' eliminates TTY buffering,
    // setTimeout gives us a hard timeout we control (unlike E2B's black-box hang)
    const CLAUDE_BIN = '/app/node_modules/@anthropic-ai/claude-code/cli.js';
    await runClaudeCliSubprocess(CLAUDE_BIN, prompt, workDir, notify);

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

async function runClaudeCliSubprocess(
  cliBin: string,
  prompt: string,
  cwd: string,
  notify?: NotifyFn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [cliBin, '--dangerously-skip-permissions', '-p', prompt], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],  // pipe = no TTY, no buffering issues
    });

    const timeoutHandle = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude Code timed out after 20 minutes'));
    }, SDK_TIMEOUT_MS);

    let pendingNotify = Promise.resolve();
    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleFlush() {
      if (flushTimer || !notify) return;
      flushTimer = setTimeout(async () => {
        flushTimer = undefined;
        const chunk = buffer;
        buffer = '';
        if (!chunk.trim()) return;
        const truncated = chunk.length > 1800 ? chunk.slice(-1800) : chunk;
        pendingNotify = pendingNotify
          .then(() => notify(`\`\`\`\n${truncated}\n\`\`\``))
          .catch(() => {});
      }, 3_000);
    }

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      console.log('[claude-code]', text.trimEnd().slice(0, 300));
      buffer += text;
      scheduleFlush();
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      clearTimeout(flushTimer);
      // Flush any remaining buffer
      if (buffer.trim() && notify) {
        const truncated = buffer.length > 1800 ? buffer.slice(-1800) : buffer;
        pendingNotify = pendingNotify
          .then(() => notify(`\`\`\`\n${truncated}\n\`\`\``))
          .catch(() => {});
      }
      pendingNotify.finally(() => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`Claude Code exited with code ${code}`));
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      clearTimeout(flushTimer);
      reject(err);
    });
  });
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
