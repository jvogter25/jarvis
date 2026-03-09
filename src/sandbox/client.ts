import { Sandbox } from 'e2b';

export interface SandboxResult {
  url: string;
  sandboxId: string;
}

/**
 * Spin up an E2B sandbox, write files into it, start a server, return public URL.
 * files: { path: string, content: string }[]
 * startCommand: shell command to start the server (e.g. "npx serve . -p 3000")
 * port: the port your server listens on
 */
export async function runInSandbox(
  files: { path: string; content: string }[],
  startCommand: string,
  port = 3000
): Promise<SandboxResult> {
  const sandbox = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 5 * 60 * 1000, // 5 min
  });

  // Write all files
  for (const file of files) {
    await sandbox.files.write(file.path, file.content);
  }

  // Start the server in background
  await sandbox.commands.run(startCommand, { background: true });

  // Give the server a moment to start
  await new Promise(r => setTimeout(r, 3000));

  const url = `https://${sandbox.getHost(port)}`;
  return { url, sandboxId: sandbox.sandboxId };
}

/**
 * Convenience: write a single HTML file and serve it
 */
export async function serveHtml(html: string): Promise<SandboxResult> {
  return runInSandbox(
    [{ path: 'index.html', content: html }],
    'npx --yes serve . -p 3000 -s',
    3000
  );
}

/**
 * Run a Next.js app in E2B sandbox for preview. Returns a live URL (valid ~1hr).
 * files: all Next.js project files including package.json
 */
export async function runNextjsPreview(
  files: { path: string; content: string }[]
): Promise<{ url: string; sandboxId: string }> {
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: 60 * 60 * 1000, // 1 hour for preview
    });

    // Write all files
    for (const file of files) {
      await sandbox.files.write(file.path, file.content);
    }

    // Install deps — throws CommandExitError automatically on non-zero exit
    await sandbox.commands.run('npm install --legacy-peer-deps', { timeoutMs: 120000 });

    // Start Next.js dev server in background
    await sandbox.commands.run('npx next dev --port 3000 2>&1', { background: true });

    // Wait for Next.js to start (it takes a few seconds)
    await new Promise(r => setTimeout(r, 8000));

    const url = `https://${sandbox.getHost(3000)}`;
    return { url, sandboxId: sandbox.sandboxId };
  } catch (err) {
    if (sandbox) {
      await sandbox.kill().catch(() => {}); // best-effort cleanup
    }
    throw err;
  }
}
