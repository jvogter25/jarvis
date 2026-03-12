/**
 * Deploy CashClaw to GitHub.
 *
 * Creates the `cashclaw-agent` GitHub repo and pushes all source files.
 * Also posts status updates to the Discord #engineering channel.
 *
 * Run: /app/node_modules/.bin/tsx scripts/deploy-cashclaw.ts
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const OWNER = process.env.GITHUB_OWNER!;
const REPO = 'cashclaw-agent';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ENGINEERING;

async function postDiscord(msg: string): Promise<void> {
  if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
    console.log('[discord] (no token/channel)', msg.slice(0, 80));
    return;
  }
  const chunks: string[] = [];
  let rem = msg;
  while (rem.length > 0) { chunks.push(rem.slice(0, 1900)); rem = rem.slice(1900); }
  for (const chunk of chunks) {
    await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}` },
      body: JSON.stringify({ content: chunk }),
    }).catch(e => console.error('[discord] error:', e.message));
  }
  console.log('[discord]', msg.slice(0, 100));
}

async function githubFetch<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  if (!res.ok && res.status !== 422) {
    throw new Error(`GitHub ${method} ${path}: ${res.status} — ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

async function createRepo(): Promise<void> {
  try {
    await githubFetch(`/user/repos`, 'POST', {
      name: REPO,
      description: 'CashClaw — autonomous AI agent earning ETH on Moltlaunch',
      private: false,
      auto_init: true,
    });
    console.log(`[github] Created repo: ${OWNER}/${REPO}`);
    // Allow GitHub time to initialize
    await new Promise(r => setTimeout(r, 4000));
  } catch (err: any) {
    if (String(err?.message).includes('422') || String(err?.message).includes('already exists') || String(err?.message).includes('name already exists')) {
      console.log(`[github] Repo ${OWNER}/${REPO} already exists — continuing`);
    } else {
      throw err;
    }
  }
}

async function getSha(filePath: string): Promise<string | undefined> {
  try {
    const data = await githubFetch<{ type: string; sha: string } | unknown[]>(
      `/repos/${OWNER}/${REPO}/contents/${filePath}`
    );
    if (!Array.isArray(data) && (data as any).type === 'file') return (data as any).sha;
  } catch { /* file doesn't exist */ }
  return undefined;
}

async function upsertFile(filePath: string, content: string): Promise<void> {
  const sha = await getSha(filePath);
  await githubFetch(`/repos/${OWNER}/${REPO}/contents/${filePath}`, 'PUT', {
    message: `feat: CashClaw agent — ${filePath}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

function collectFiles(dir: string, baseDir: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    const rel = relative(baseDir, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, baseDir));
    } else {
      const content = readFileSync(full, 'utf-8');
      files.push({ path: rel, content });
    }
  }
  return files;
}

async function main() {
  console.log('🦀 CashClaw GitHub deploy starting...');

  if (!GITHUB_TOKEN || !OWNER) {
    throw new Error('GITHUB_TOKEN and GITHUB_OWNER must be set');
  }

  await createRepo();

  const cashclawDir = join(process.cwd(), 'cashclaw');
  const files = collectFiles(cashclawDir, cashclawDir);
  console.log(`[github] Pushing ${files.length} files to ${OWNER}/${REPO}...`);

  for (const file of files) {
    console.log(`  → ${file.path}`);
    await upsertFile(file.path, file.content);
  }

  const repoUrl = `https://github.com/${OWNER}/${REPO}`;
  console.log(`\n✅ Done! CashClaw repo: ${repoUrl}\n`);

  await postDiscord(
    `🦀 **CashClaw Agent** | GitHub repo deployed ✅\n` +
    `\`\`\`\n` +
    `Repo   : ${repoUrl}\n` +
    `Files  : ${files.length} pushed\n` +
    `Stack  : Node.js + TypeScript + GPT-4o + Moltlaunch\n` +
    `Skills : SEO Audit | Content Writing | Code Review | Competitor Research | Landing Page Copy\n` +
    `\`\`\`\n` +
    `**To deploy on Railway:**\n` +
    `1. railway.app → New Project → Deploy from GitHub → \`${REPO}\`\n` +
    `2. Set env vars: \`OPENAI_API_KEY\`, \`MOLTLAUNCH_PRIVATE_KEY\`, \`AGENT_ADDRESS\`, \`DISCORD_ENGINEERING_WEBHOOK\`\n` +
    `3. First boot auto-generates wallet — save the logged address + private key to Railway env vars`
  );
}

main().catch(async err => {
  const msg = (err as Error).message;
  console.error('❌ Deploy failed:', msg);
  await postDiscord(`⚠️ **CashClaw** | Deploy failed\n\`\`\`\n${msg.slice(0, 800)}\n\`\`\``);
  process.exit(1);
});
