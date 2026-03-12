import 'dotenv/config';
import { loadOrCreateWallet } from './wallet.js';
import { pollInbox } from './inbox.js';
import { postToDiscord } from './discord.js';

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

async function main() {
  console.log('🦀 CashClaw starting up...');

  // Generate or load wallet on first startup
  const wallet = loadOrCreateWallet();
  console.log(`[init] Agent address: ${wallet.address}`);

  await postToDiscord(
    `🦀 **CashClaw** agent online\n` +
    `\`\`\`\nAddress : ${wallet.address}\nPolling : every 2 minutes\nSkills  : SEO Audit | Content Writing | Code Review | Competitor Research | Landing Page Copy\n\`\`\``
  );

  // Initial poll immediately on startup
  await pollInbox().catch(err => console.error('[main] Initial poll error:', err));

  // Then poll every 2 minutes
  setInterval(() => {
    pollInbox().catch(err => console.error('[main] Poll error:', err));
  }, POLL_INTERVAL_MS);

  console.log(`[init] CashClaw running — polling every ${POLL_INTERVAL_MS / 1000}s`);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
