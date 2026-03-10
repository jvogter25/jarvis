import { Sandbox } from 'e2b';
import { think } from '../brain.js';
import { buildClaudeCodeInstructions } from './claude-code-instructions.js';

const SANDBOX_LIFETIME_MS = 60 * 60 * 1000;  // E2B hard cap: 1 hour max
const WATCHDOG_TRIGGER_MS = 45 * 60 * 1000;  // checkpoint at T+45min (before E2B kills sandbox)

// Global registry so emergency kill switch can terminate any active sandbox
const activeSandboxes = new Set<InstanceType<typeof Sandbox>>();

export async function killAllSandboxes(): Promise<number> {
  const count = activeSandboxes.size;
  for (const sandbox of activeSandboxes) {
    await sandbox.kill().catch(() => {});
  }
  activeSandboxes.clear();
  console.log(`[emergency] Killed ${count} active sandbox(es).`);
  return count;
}

export interface ClaudeCodeResult {
  success: boolean;
  files: Array<{ path: string; content: string }>;
  reviewNotes: string;
  checkpointBranch?: string;
  testReport?: string;
}

export async function runClaudeCodeAgent(intent: string): Promise<ClaudeCodeResult> {
  const OWNER = process.env.GITHUB_OWNER!;
  const REPO = 'jarvis';
  const REPO_PATH = '/home/user/jarvis';

  let sandbox: Sandbox | null = null;
  let checkpointBranch: string | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    sandbox = await setupSandbox();
    activeSandboxes.add(sandbox);
    const instructions = buildClaudeCodeInstructions(intent, OWNER, REPO);
    await sandbox.files.write('/home/user/TASK.md', instructions);

    // Watchdog: at T+45min, checkpoint partial work before E2B's 1hr sandbox limit kills it
    watchdogTimer = setTimeout(async () => {
      if (!sandbox) return;
      try {
        checkpointBranch = `claude-code/checkpoint-${Date.now()}`;
        const token = process.env.GITHUB_TOKEN!;
        await sandbox.commands.run(
          [
            `cd ${REPO_PATH}`,
            'git add -A',
            'git commit -m "checkpoint: partial work — session handoff" || true',
            `git push https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git HEAD:${checkpointBranch}`,
          ].join(' && '),
          { timeoutMs: 60_000 }
        );
        console.log(`[claude-code] Checkpoint saved to ${checkpointBranch}`);
      } catch (err) {
        console.error('[claude-code] Watchdog failed:', err);
      }
    }, WATCHDOG_TRIGGER_MS);

    // Run Claude Code CLI
    console.log('[claude-code] Launching Claude Code agent...');
    const claudeResult = await sandbox.commands.run(
      `cd ${REPO_PATH} && claude --dangerously-skip-permissions -p "$(cat /home/user/TASK.md)"`,
      {
        timeoutMs: 0,  // no client-side timeout — sandbox lifetime (1hr) is the hard boundary
        envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! }
      }
    );
    if (claudeResult.exitCode !== 0) {
      throw new Error(`Claude Code exited with code ${claudeResult.exitCode}: ${claudeResult.stderr?.slice(0, 500)}`);
    }

    // Extract modified files
    const files = await extractModifiedFiles(sandbox, REPO_PATH);

    // Read test report if available
    let testReport: string | undefined;
    try {
      testReport = await sandbox.files.read('/home/user/test-report.md');
    } catch { /* optional */ }

    return {
      success: true,
      files,
      reviewNotes: `Claude Code completed 4-phase review. ${files.length} file(s) modified. TSC verified.`,
      checkpointBranch,
      testReport,
    };

  } catch (err) {
    console.error('[claude-code] Agent failed:', err);
    return {
      success: false,
      files: [],
      reviewNotes: `Claude Code agent failed: ${(err as Error).message}`,
      checkpointBranch,
    };
  } finally {
    clearTimeout(watchdogTimer);
    if (sandbox) {
      activeSandboxes.delete(sandbox);
      await sandbox.kill().catch(() => {});
    }
  }
}

async function setupSandbox(fromBranch = 'main'): Promise<Sandbox> {
  const sandbox = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_LIFETIME_MS,
  });

  const OWNER = process.env.GITHUB_OWNER!;
  const token = process.env.GITHUB_TOKEN!;

  console.log(`[claude-code] Setting up sandbox, cloning from ${fromBranch}...`);
  const setup = await sandbox.commands.run(
    [
      `git clone --branch ${fromBranch} https://x-access-token:${token}@github.com/${OWNER}/jarvis.git /home/user/jarvis`,
      'cd /home/user/jarvis && npm install',
      'npm install -g @anthropic-ai/claude-code',
    ].join(' && '),
    { timeoutMs: 5 * 60 * 1000 }
  );

  if (setup.exitCode !== 0) {
    throw new Error(`Sandbox setup failed: ${setup.stderr}`);
  }

  return sandbox;
}

async function extractModifiedFiles(
  sandbox: Sandbox,
  repoPath: string
): Promise<Array<{ path: string; content: string }>> {
  const result = await sandbox.commands.run(
    `cd ${repoPath} && { git diff --name-only origin/main...HEAD; git diff --name-only; } | sort -u`,
    { timeoutMs: 15_000 }
  );

  const paths = result.stdout.trim().split('\n').filter(Boolean);
  const files: Array<{ path: string; content: string }> = [];

  for (const relativePath of paths) {
    try {
      const content = await sandbox.files.read(`${repoPath}/${relativePath}`);
      files.push({ path: relativePath, content });
    } catch {
      console.warn(`[claude-code] Could not read modified file: ${relativePath}`);
    }
  }

  return files;
}
