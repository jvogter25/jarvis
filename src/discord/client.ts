import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleMessage } from './handlers.js';

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, handleMessage);

  return client;
}
