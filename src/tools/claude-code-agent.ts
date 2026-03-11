import { Sandbox } from 'e2b';
import { buildClaudeCodeInstructions } from './claude-code-instructions.js';
import { planCodingTask } from './task-planner.js';

const SANDBOX_LIFETIME_MS = 60 * 60 * 1000;  // E2B hard cap: 1 hour max
const WATCHDOG_TRIGGER_MS = 45 * 60 * 1000;  // checkpoint at T+45min (before E2B kills sandbox)
const DIAGNOSTICS_ENABLED = true;

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

async function runDiag(
  sandbox: Sandbox,
  stageName: string,
  cmd: string,
  timeoutMs: number,
  envs?: Record<string, string>,
): Promise<string> {
  try {
    const r = await sandbox.commands.run(cmd, { timeoutMs, envs });
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
    console.log(`[DIAG:${stageName}]`, out.slice(0, 500));
    return out;
  } catch (err) {
    const msg = `FAILED: ${(err as Error).message}`;
    console.log(`[DIAG:${stageName}]`, msg);
    return msg;
  }
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
  const diagReport: Record<string, string> = {};

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

    // Stage 1 — OS/Tools Audit
    if (DIAGNOSTICS_ENABLED) {
      diagReport['os'] = await runDiag(sandbox, 'os', 'uname -a', 10_000);
      diagReport['tools'] = await runDiag(sandbox, 'tools', 'which curl git node npm stdbuf tee 2>&1 || true', 10_000);
      diagReport['versions'] = await runDiag(sandbox, 'versions', 'node --version 2>&1; npm --version 2>&1', 10_000);
      diagReport['disk'] = await runDiag(sandbox, 'disk', 'df -h /home/user 2>/dev/null | tail -1', 10_000);
    }

    // Stage 2 — Setup Verification
    if (DIAGNOSTICS_ENABLED) {
      diagReport['claude_path'] = await runDiag(sandbox, 'claude_path', 'which claude; echo "exit:$?"', 15_000);
      diagReport['claude_version'] = await runDiag(sandbox, 'claude_version', 'claude --version 2>&1', 20_000, { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! });
      diagReport['clone_ok'] = await runDiag(sandbox, 'clone_ok', `ls ${REPO_PATH}/package.json 2>&1 && echo "CLONE_OK"`, 10_000);
      diagReport['npm_install_ok'] = await runDiag(sandbox, 'npm_install_ok', `ls ${REPO_PATH}/node_modules/.bin/tsc 2>&1 && echo "TSC_BIN_OK"`, 10_000);
      diagReport['stdbuf_exists'] = await runDiag(sandbox, 'stdbuf_exists', 'stdbuf --version 2>&1 || stdbuf --help 2>&1 | head -2 || echo "STDBUF_MISSING"', 10_000);
    }

    // Stage 3 — API Key Validation (HTTP 200 = valid, 401 = bad key, 403 = no access)
    if (DIAGNOSTICS_ENABLED) {
      diagReport['api_key_len'] = await runDiag(sandbox, 'api_key_len', `echo "Key length: ${process.env.ANTHROPIC_API_KEY?.length ?? 0}"`, 5_000);
      diagReport['api_auth'] = await runDiag(
        sandbox, 'api_auth',
        `HTTP_STATUS=$(curl -s -o /tmp/api-resp.txt -w "%{http_code}" -H "x-api-key: ${process.env.ANTHROPIC_API_KEY}" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models) && echo "HTTP_STATUS:$HTTP_STATUS" && head -c 100 /tmp/api-resp.txt 2>/dev/null || echo "(no body)"`,
        20_000,
      );
    }

    // Stage 4 — E2B Streaming Callback Test (tests if onStdout ever fires at Node.js layer)
    if (DIAGNOSTICS_ENABLED) {
      let streamingCallbackFired = false;
      const streamTest = await sandbox.commands.run(
        'echo "STREAM_TEST_1" && sleep 0.5 && echo "STREAM_TEST_2"',
        {
          timeoutMs: 10_000,
          onStdout: (_chunk: string) => { streamingCallbackFired = true; },
          onStderr: (_chunk: string) => { streamingCallbackFired = true; },
        },
      ).catch((err: Error) => { console.log('[DIAG:stream_callback] FAILED:', err.message); return null; });
      const streamOut = streamTest ? ((streamTest.stdout ?? '') + (streamTest.stderr ?? '')).trim() : 'command failed';
      diagReport['stream_callback'] = `fired=${streamingCallbackFired} stdout="${streamOut.slice(0, 100)}"`;
      console.log('[DIAG:stream_callback]', diagReport['stream_callback']);
    }

    // Stage 5 — stdbuf + tee Functional Test (exact pattern used for Claude Code)
    if (DIAGNOSTICS_ENABLED) {
      diagReport['stdbuf_tee'] = await runDiag(sandbox, 'stdbuf_tee',
        'stdbuf -oL -eL echo "STDBUF_WORKS" | tee /tmp/stdbuf-test.txt && cat /tmp/stdbuf-test.txt',
        15_000,
      );
    }

    // Stage 6 — Claude Code Smoke Test (5s timeout, proves it can make API calls)
    if (DIAGNOSTICS_ENABLED) {
      const smokeStart = Date.now();
      diagReport['smoke_test'] = await runDiag(
        sandbox, 'smoke_test',
        `timeout 5 claude --dangerously-skip-permissions -p "Reply with just: OK" 2>&1 | head -3 || echo "SMOKE_TIMEOUT_OR_FAIL"`,
        20_000,
        { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
      );
      diagReport['smoke_test'] += ` (${Date.now() - smokeStart}ms)`;
    }

    // Consolidated Discord diagnostics summary (fires before Claude Code starts)
    if (DIAGNOSTICS_ENABLED && notify) {
      const toolsLine = diagReport['tools'] ?? '';
      const toolCheck = (t: string) => toolsLine.includes(`/${t}`) ? '✓' : '✗';
      const apiLine = diagReport['api_auth'] ?? '';
      const httpMatch = apiLine.match(/HTTP_STATUS:(\d+)/);
      const httpStatus = httpMatch ? httpMatch[1] : '???';
      const apiStatusEmoji = httpStatus === '200' ? '✓ valid' : httpStatus === '401' ? '✗ invalid key' : httpStatus === '403' ? '✗ no access' : httpStatus.startsWith('5') ? '✗ API down' : `? HTTP ${httpStatus}`;
      const streamOk = (diagReport['stream_callback'] ?? '').includes('fired=true') ? '✓ callbacks fire' : '✗ callbacks SILENT';
      const stdbufOk = (diagReport['stdbuf_tee'] ?? '').includes('STDBUF_WORKS') ? '✓ working' : '✗ BROKEN';
      const smokeRaw = diagReport['smoke_test'] ?? '';
      const smokeOk = smokeRaw.includes('SMOKE_TIMEOUT_OR_FAIL') ? '✗ timed out/failed' : smokeRaw.includes('FAILED:') ? `✗ ${smokeRaw.slice(0, 60)}` : '✓ responded';
      const cloneOk = (diagReport['clone_ok'] ?? '').includes('CLONE_OK') ? '✓' : '✗';
      const tscOk = (diagReport['npm_install_ok'] ?? '').includes('TSC_BIN_OK') ? '✓' : '✗';
      const claudePath = (diagReport['claude_path'] ?? '').includes('/') ? '✓' : '✗';

      await notify([
        `🔬 **Sandbox Diagnostics**${subtaskLabel}`,
        `**OS:** ${(diagReport['os'] ?? '').slice(0, 80)}`,
        `**Tools:** curl${toolCheck('curl')} git${toolCheck('git')} node${toolCheck('node')} npm${toolCheck('npm')} stdbuf${toolCheck('stdbuf')} tee${toolCheck('tee')} claude${claudePath}`,
        `**Versions:** ${(diagReport['versions'] ?? '').replace(/\n/g, ', ').slice(0, 80)}`,
        `**Clone:** ${cloneOk}  **npm install (tsc):** ${tscOk}`,
        `**API Key:** ${(diagReport['api_key_len'] ?? '').replace('Key length: ', '')} chars — HTTP ${httpStatus} ${apiStatusEmoji}`,
        `**E2B Streaming:** ${streamOk}`,
        `**stdbuf+tee:** ${stdbufOk}`,
        `**Smoke test:** ${smokeOk}`,
        `**Disk:** ${(diagReport['disk'] ?? '').slice(0, 80)}`,
      ].join('\n')).catch(() => {});
    }

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
      'curl -s --max-time 10 https://api.anthropic.com -o /dev/null && echo "NETWORK_OK"',
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
          const pollCmd = [
            'echo "=== PROCESS ==="',
            `ps aux | grep -E '[c]laude|[n]ode' | head -5 || echo "(no claude process)"`,
            'echo "=== LOG FILE ==="',
            'ls -la /home/user/claude-output.log 2>/dev/null || echo "(log not created yet)"',
            'wc -l /home/user/claude-output.log 2>/dev/null || echo "(no lines)"',
            'echo "=== TAIL ==="',
            'tail -15 /home/user/claude-output.log 2>/dev/null || echo "(empty)"',
            'echo "=== DISK ==="',
            'df -h /home/user 2>/dev/null | tail -1',
          ].join(' && ');
          const poll = await sandbox!.commands.run(pollCmd, { timeoutMs: 10_000 });
          const pollOut = ((poll.stdout ?? '') + (poll.stderr ?? '')).slice(0, 1200);
          console.log(`[claude-code] T+${elapsed}m poll:`, pollOut.slice(0, 400));
          await notify?.(`⏱️ T+${elapsed}m poll:\n\`\`\`\n${pollOut.slice(0, 1000)}\n\`\`\``).catch(() => {});
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

      if (DIAGNOSTICS_ENABLED) {
        const postBytes = await runDiag(sandbox!, 'post_bytes', 'cat /home/user/claude-output.log | wc -c 2>/dev/null || echo "0"', 10_000);
        const postDone = await runDiag(sandbox!, 'post_done_txt', 'cat /home/user/done.txt 2>/dev/null || echo "(done.txt not written)"', 5_000);
        const postGitLog = await runDiag(sandbox!, 'post_git_log', `git -C ${REPO_PATH} log --oneline -5 2>&1`, 15_000);
        const postGitDiff = await runDiag(sandbox!, 'post_git_diff', `git -C ${REPO_PATH} diff --name-only origin/main...HEAD 2>&1`, 15_000);

        if (notify) {
          await notify([
            `📋 **Post-run diagnostics** (exit code: ${claudeResult.exitCode})`,
            `**Output bytes:** ${postBytes}`,
            `**done.txt:** ${postDone.slice(0, 100)}`,
            `**Git log (last 5):**\n\`\`\`\n${postGitLog.slice(0, 400)}\n\`\`\``,
            `**Changed files:**\n\`\`\`\n${postGitDiff.slice(0, 400)}\n\`\`\``,
          ].join('\n')).catch(() => {});
        }
      }

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
