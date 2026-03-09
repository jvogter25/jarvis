import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleMessage, handleDesignMessage, handleTrainingMessage } from './handlers.js';
import { CHANNELS } from './channels.js';

let _client: Client | null = null;

export function getDiscordClient(): Client | null {
  return _client;
}

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    _client = client;
    console.log(`Discord connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === CHANNELS.DESIGN_ELEMENTS) {
      handleDesignMessage(msg).catch(console.error);
    } else if (msg.channelId === CHANNELS.TRAINING) {
      handleTrainingMessage(msg).catch(console.error);
    } else {
      handleMessage(msg).catch(console.error);
    }
  });

  return client;
}
