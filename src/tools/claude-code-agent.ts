import { Sandbox } from 'e2b';
import { buildClaudeCodeInstructions } from './claude-code-instructions.js';
import { planCodingTask } from './task-planner.js';

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

export type NotifyFn = (msg: string) => Promise<void>;

export async function runClaudeCodeAgent(intent: string, notify?: NotifyFn): Promise<ClaudeCodeResult> {
  const OWNER = process.env.GITHUB_OWNER!;
  const REPO = 'jarvis';

  // Plan the task before spinning up any sandbox
  console.log('[claude-code] Planning task...');
  const subtasks = await planCodingTask(intent);
  console.log(`[claude-code] Plan ready: ${subtasks.length} subtask(s)`);

  let allFiles: Array<{ path: string; content: string }> = [];
  let lastCheckpointBranch: string | undefined;
  let lastTestReport: string | undefined;
  let currentBranch = 'main';

  for (const subtask of subtasks) {
    subtask.fromBranch = currentBranch;

    if (subtasks.length > 1) {
      console.log(`[claude-code] Running subtask ${subtask.index + 1}/${subtask.total}: ${subtask.title}`);
    }

    const result = await runSingleSubtask(subtask, OWNER, REPO, notify);

    if (!result.success) {
      return {
        success: false,
        files: allFiles,
        reviewNotes: `Subtask ${subtask.index + 1} failed: ${result.reviewNotes}`,
        checkpointBranch: result.checkpointBranch ?? lastCheckpointBranch,
        testReport: result.testReport,
      };
    }

    // Merge files (later subtasks may modify same files — last write wins)
    for (const f of result.files) {
      const existing = allFiles.findIndex(e => e.path === f.path);
      if (existing >= 0) allFiles[existing] = f;
      else allFiles.push(f);
    }

    if (result.checkpointBranch) lastCheckpointBranch = result.checkpointBranch;
    if (result.testReport) lastTestReport = result.testReport;

    // Next subtask clones from the branch that was just written
    // The checkpoint branch is the output branch of this subtask
    if (result.checkpointBranch) {
      currentBranch = result.checkpointBranch;
    }
  }

  return {
    success: true,
    files: allFiles,
    reviewNotes: `Claude Code completed ${subtasks.length} subtask(s). ${allFiles.length} file(s) modified. TSC verified.`,
    checkpointBranch: lastCheckpointBranch,
    testReport: lastTestReport,
  };
}

async function runSingleSubtask(
  subtask: Parameters<typeof buildClaudeCodeInstructions>[0],
  OWNER: string,
  REPO: string,
  notify?: NotifyFn,
): Promise<ClaudeCodeResult> {
  const REPO_PATH = '/home/user/jarvis';
  let sandbox: Sandbox | null = null;
  let checkpointBranch: string | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  // Streaming: buffer stdout and flush to Discord every 10s
  const subtaskLabel = subtask.total > 1 ? ` (${subtask.index + 1}/${subtask.total}: ${subtask.title})` : '';
  let outputBuffer = '';
  let lastNotifyTime = 0;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const startTime = Date.now();

  async function flushToDiscord(force = false) {
    if (!notify || !outputBuffer.trim()) return;
    const now = Date.now();
    if (!force && now - lastNotifyTime < 10_000) return;
    lastNotifyTime = now;
    const elapsed = Math.floor((now - startTime) / 60_000);
    // Keep last 1800 chars to stay under Discord's 2000 limit
    const tail = outputBuffer.length > 1800 ? '...' + outputBuffer.slice(-1800) : outputBuffer;
    await notify(`\`\`\`\n[claude-code${subtaskLabel}] T+${elapsed}m\n${tail}\n\`\`\``).catch(() => {});
    outputBuffer = '';
  }

  function onOutput(chunk: string) {
    console.log('[claude-code]', chunk.trimEnd());
    outputBuffer += chunk;
    // Schedule a flush if one isn't already pending
    if (!notifyTimer) {
      notifyTimer = setTimeout(async () => {
        notifyTimer = undefined;
        await flushToDiscord();
      }, 10_000);
    }
  }

  try {
    sandbox = await setupSandbox(subtask.fromBranch);
    activeSandboxes.add(sandbox);
    const instructions = buildClaudeCodeInstructions(subtask, OWNER, REPO);
    await sandbox.files.write('/home/user/TASK.md', instructions);

    if (notify) {
      await notify(`⚙️ **Claude Code starting**${subtaskLabel} — pre-loaded ${subtask.relevantFiles.length} file(s). Updates every ~10s.`).catch(() => {});
    }

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
        await notify?.(`⚠️ **T+45min checkpoint** saved to \`${checkpointBranch}\` — sandbox approaching limit.`).catch(() => {});
      } catch (err) {
        console.error('[claude-code] Watchdog failed:', err);
      }
    }, WATCHDOG_TRIGGER_MS);

    // Preflight: verify claude CLI is installed and API key works
    console.log('[claude-code] Running preflight check...');
    const preflight = await sandbox.commands.run(
      'claude --version && echo "PREFLIGHT_OK"',
      {
        timeoutMs: 30_000,
        envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
      }
    );
    const preflightOut = (preflight.stdout ?? '') + (preflight.stderr ?? '');
    console.log('[claude-code] Preflight result (exit', preflight.exitCode, '):', preflightOut.slice(0, 200));
    await notify?.(`🔍 Preflight: exit=${preflight.exitCode} — ${preflightOut.slice(0, 300)}`).catch(() => {});
    if (!preflightOut.includes('PREFLIGHT_OK')) {
      throw new Error(`Claude Code preflight failed (exit ${preflight.exitCode}): ${preflightOut.slice(0, 300)}`);
    }

    // Network check: verify E2B sandbox can reach api.anthropic.com
    console.log('[claude-code] Checking network connectivity to api.anthropic.com...');
    const networkCheck = await sandbox.commands.run(
      'curl -sf --max-time 10 https://api.anthropic.com -o /dev/null && echo "NETWORK_OK"',
      { timeoutMs: 15_000 }
    );
    const networkOut = (networkCheck.stdout ?? '') + (networkCheck.stderr ?? '');
    if (!networkOut.includes('NETWORK_OK')) {
      throw new Error(`E2B sandbox cannot reach api.anthropic.com: ${networkOut.slice(0, 300)}`);
    }
    console.log('[claude-code] Network OK — api.anthropic.com reachable');
    await notify?.(`🌐 Network OK — api.anthropic.com reachable`).catch(() => {});

    // Log TASK.md size so we can detect if it's too large
    const taskSize = await sandbox.commands.run('wc -c /home/user/TASK.md', { timeoutMs: 5_000 });
    console.log('[claude-code] TASK.md size:', taskSize.stdout?.trim());

    // Run Claude Code CLI with stdout/stderr streaming
    // stdbuf -oL -eL forces line-buffered output so E2B onStdout callbacks fire
    // without PTY (non-TTY mode defaults to full-buffer which only flushes on exit)
    console.log('[claude-code] Launching Claude Code agent...');
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    try {
      pollTimer = setInterval(async () => {
        try {
          const elapsed = Math.floor((Date.now() - startTime) / 60_000);
          const tail = await sandbox!.commands.run(
            'tail -20 /home/user/claude-output.log 2>/dev/null || echo "(no output yet)"',
            { timeoutMs: 5_000 }
          );
          await notify?.(`⏱️ T+${elapsed}m poll:\n\`\`\`\n${tail.stdout?.slice(0, 400)}\n\`\`\``).catch(() => {});
        } catch { /* sandbox may be torn down */ }
      }, 60_000);

      const claudeResult = await sandbox.commands.run(
        `cd ${REPO_PATH} && stdbuf -oL -eL claude --dangerously-skip-permissions -p "Your full task instructions are in /home/user/TASK.md — read that file first, then execute exactly as specified." 2>&1 | tee /home/user/claude-output.log`,
        {
          timeoutMs: 0,  // 0 = no timeout (E2B default is 60s which kills Claude Code mid-run)
          envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
          onStdout: (data: string) => onOutput(data),
          onStderr: (data: string) => onOutput(data),
        }
      );
      clearInterval(pollTimer);
      pollTimer = undefined;
      clearTimeout(notifyTimer);
      await flushToDiscord(true);

      console.log(`[claude-code] Exited with code ${claudeResult.exitCode}`);
      if (claudeResult.stderr) console.log(`[claude-code] stderr: ${claudeResult.stderr.slice(0, 500)}`);

      if (claudeResult.exitCode !== 0) {
        throw new Error(`Claude Code exited with code ${claudeResult.exitCode}: ${claudeResult.stderr?.slice(0, 500)}`);
      }
    } finally {
      if (pollTimer) clearInterval(pollTimer);
    }

    // Push output to a checkpoint branch so next subtask (or PR flow) can pick it up
    checkpointBranch = `claude-code/output-${Date.now()}`;
    const token = process.env.GITHUB_TOKEN!;
    await sandbox.commands.run(
      [
        `cd ${REPO_PATH}`,
        'git add -A',
        'git commit -m "claude-code: task complete" || true',
        `git push https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git HEAD:${checkpointBranch}`,
      ].join(' && '),
      { timeoutMs: 60_000 }
    ).catch(err => console.warn('[claude-code] Output push failed:', err));

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
      reviewNotes: `Claude Code completed. ${files.length} file(s) modified. TSC verified.`,
      checkpointBranch,
      testReport,
    };

  } catch (err) {
    console.error('[claude-code] Subtask failed:', err);
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
      'git config --global user.email "jarvis@jarvis.local"',
      'git config --global user.name "Jarvis"',
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
