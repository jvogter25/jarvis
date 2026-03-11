import 'dotenv/config';
import fs from 'fs';
import cron from 'node-cron';
import { createDiscordClient } from './discord/client.js';
import { runResearchLoop } from './research/loop.js';
import { runOvernightTraining } from './overnight/trainer.js';
import { postMorningBriefing, postProjectMorningBriefings, postProjectOvernightLogs } from './overnight/briefing.js';
import { runProductPulse } from './overnight/product-pulse.js';
import { runToolDiscovery } from './overnight/tool-discovery.js';
import { runInboxMonitor } from './overnight/inbox-monitor.js';
import { processQueue } from './tools/engineering-queue.js';
import { isEmergencyLocked, restoreEmergencyLockState } from './tools/emergency.js';
import { startWebSocketServer } from './dashboard/events.js';
import { fetchTwitterThread, formatThread } from './tools/twitter.js';

let isShuttingDown = false;
export function getIsShuttingDown(): boolean { return isShuttingDown; }

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[${signal}] Graceful shutdown — saving state...`);
  await new Promise(resolve => setTimeout(resolve, 5000)); // brief grace for in-flight
  try {
    const { getPendingState } = await import('./discord/handlers.js');
    const { saveShutdownState } = await import('./memory/supabase.js');
    await saveShutdownState({ pendingApprovals: getPendingState(), savedAt: new Date().toISOString() });
    console.log('[shutdown] State saved.');
  } catch (err) {
    console.error('[shutdown] Failed to save state:', err);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  console.log('Jarvis starting...');
  try { console.log('APP contents:', fs.readdirSync('/app').join(', ')); } catch {}
  console.log('CWD:', process.cwd());

  // Use Railway's assigned PORT — Railway only exposes one port per service.
  startWebSocketServer(Number(process.env.PORT ?? process.env.DASHBOARD_WS_PORT ?? 8080));

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  try {
    const { loadShutdownState } = await import('./memory/supabase.js');
    const { restorePendingState } = await import('./discord/handlers.js');
    const saved = await loadShutdownState();
    if (saved?.pendingApprovals) {
      restorePendingState(saved.pendingApprovals as any);
      console.log('[startup] Restored pending approvals from Supabase.');
    }
  } catch (err) {
    console.error('[startup] Could not restore state:', err);
  }

  // Restore emergency lock state (persists across redeploys)
  await restoreEmergencyLockState().catch(err =>
    console.error('[startup] Could not restore lock state:', err)
  );

  const TZ = 'America/Los_Angeles';

  // Pre-research warning: 10 min before each research window (11:50pm, 5:50am, 11:50am, 5:50pm PT)
  cron.schedule('50 23,5,11,17 * * *', async () => {
    try {
      const jarvisChannel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_JARVIS!).catch(() => null);
      if (jarvisChannel?.isTextBased()) {
        await (jarvisChannel as any).send(
          `Research loop runs in **10 minutes**. Reply now if you want to add anything to the queue before it locks.\n` +
          `_(Next window after this: in 6 hours)_`
        );
      }
    } catch (err) {
      console.error('[pre-research-warn] Failed:', err);
    }
  }, { timezone: TZ });

  // Research loop: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    runResearchLoop(discord).catch(console.error);
  }, { timezone: TZ });

  // Engineering queue processor: 1am — skip if emergency locked
  cron.schedule('0 1 * * *', async () => {
    if (isEmergencyLocked()) {
      console.log('[queue] Skipping — emergency lock active.');
      return;
    }
    console.log('[queue] Running overnight engineering queue...');
    const engineeringChannel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ENGINEERING!).catch(() => null);
    if (!engineeringChannel?.isTextBased()) return;
    await processQueue(async (msg) => {
      await (engineeringChannel as any).send(msg);
    });
  }, { timezone: TZ });

  // Overnight training: 2am
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
    postProjectOvernightLogs(discord).catch(console.error);
  }, { timezone: TZ });

  // Morning briefing: 7am
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
    postProjectMorningBriefings(discord).catch(console.error);
  }, { timezone: TZ });

  // Weekly product pulse: Mondays at 8am
  cron.schedule('0 8 * * 1', () => {
    runProductPulse(discord).catch(console.error);
  }, { timezone: TZ });

  // Weekly tool discovery: Fridays at 9am
  cron.schedule('0 9 * * 5', () => {
    runToolDiscovery(discord).catch(console.error);
  }, { timezone: TZ });

  // Inbox monitor: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runInboxMonitor(discord).catch(console.error);
  }, { timezone: TZ });

  // Tweet watcher: fetch https://x.com/moltlaunch/status/2031830587309506873 every 20 min
  // Stops automatically once the tweet is successfully retrieved and posted.
  const tweetWatcher = cron.schedule('*/20 * * * *', async () => {
    try {
      const result = await fetchTwitterThread('https://x.com/moltlaunch/status/2031830587309506873');
      if (result.error || !result.tweet.text) {
        console.log('[tweet-watcher] Fetch attempt failed silently:', result.error ?? 'empty tweet');
        return;
      }
      const jarvisChannel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_JARVIS!).catch(() => null);
      if (jarvisChannel?.isTextBased()) {
        const formatted = formatThread(result);
        await (jarvisChannel as any).send(formatted);
      }
      tweetWatcher.stop();
      console.log('[tweet-watcher] Tweet fetched and posted — cron stopped.');
    } catch (err) {
      console.log('[tweet-watcher] Fetch attempt failed silently:', (err as Error).message);
    }
  }, { timezone: TZ });

  console.log('Jarvis online.');
}

main().catch(console.error);
