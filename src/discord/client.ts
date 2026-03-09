import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleMessage, handleDesignMessage } from './handlers.js';
import { CHANNELS } from './channels.js';

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

  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === CHANNELS.DESIGN_ELEMENTS) {
      handleDesignMessage(msg).catch(console.error);
    } else {
      handleMessage(msg).catch(console.error);
    }
  });

  return client;
}
