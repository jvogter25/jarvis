export const CHANNELS = {
  JARVIS: process.env.DISCORD_CHANNEL_JARVIS!,
  MORNING_BRIEF: process.env.DISCORD_CHANNEL_MORNING_BRIEF!,
  RESEARCH: process.env.DISCORD_CHANNEL_RESEARCH!,
  ENGINEERING: process.env.DISCORD_CHANNEL_ENGINEERING!,
  MARKETING: process.env.DISCORD_CHANNEL_MARKETING!,
  OVERNIGHT_LOG: process.env.DISCORD_CHANNEL_OVERNIGHT_LOG!,
};

export function splitMessage(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}
