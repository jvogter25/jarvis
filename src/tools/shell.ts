import { Sandbox } from 'e2b';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run shell commands sequentially inside an E2B sandbox.
 * Optional files are written before commands run.
 * Timeout: 5 minutes.
 */
export async function runShell(
  commands: string[],
  inputFiles: { path: string; content: string }[] = []
): Promise<ShellResult> {
  const sandbox = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 5 * 60 * 1000,
  });

  try {
    // Write input files if any
    for (const file of inputFiles) {
      await sandbox.files.write(file.path, file.content);
    }

    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let lastExitCode = 0;

    for (const cmd of commands) {
      const result = await sandbox.commands.run(cmd, { timeoutMs: 0 });
      if (result.stdout) stdoutParts.push(result.stdout);
      if (result.stderr) stderrParts.push(result.stderr);
      lastExitCode = result.exitCode ?? -1;
    }

    return {
      stdout: stdoutParts.join('\n').trim(),
      stderr: stderrParts.join('\n').trim(),
      exitCode: lastExitCode,
    };
  } finally {
    await sandbox.kill();
  }
}
