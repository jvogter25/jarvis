import 'dotenv/config';
import fs from 'fs';
import cron from 'node-cron';
import { createDiscordClient } from './discord/client.js';
import { runResearchLoop } from './research/loop.js';
import { runOvernightTraining } from './overnight/trainer.js';
import { postMorningBriefing, postProjectMorningBriefings, postProjectOvernightLogs } from './overnight/briefing.js';
import { runProductPulse } from './overnight/product-pulse.js';
import { runToolDiscovery } from './overnight/tool-discovery.js';

async function main() {
  console.log('Jarvis starting...');
  try { console.log('APP contents:', fs.readdirSync('/app').join(', ')); } catch {}
  console.log('CWD:', process.cwd());

  const discord = createDiscordClient();
  await discord.login(process.env.DISCORD_TOKEN);

  // Research loop: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    runResearchLoop(discord).catch(console.error);
  });

  // Overnight training: 2am
  cron.schedule('0 2 * * *', () => {
    runOvernightTraining(discord).catch(console.error);
    postProjectOvernightLogs(discord).catch(console.error);
  });

  // Morning briefing: 7am
  cron.schedule('0 7 * * *', () => {
    postMorningBriefing(discord).catch(console.error);
    postProjectMorningBriefings(discord).catch(console.error);
  });

  // Weekly product pulse: Mondays at 8am
  cron.schedule('0 8 * * 1', () => {
    runProductPulse(discord).catch(console.error);
  });

  // Weekly tool discovery: Fridays at 9am
  cron.schedule('0 9 * * 5', () => {
    runToolDiscovery(discord).catch(console.error);
  });

  console.log('Jarvis online.');
}

main().catch(console.error);
