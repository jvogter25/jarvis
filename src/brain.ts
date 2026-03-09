import Anthropic from '@anthropic-ai/sdk';
import { Message } from './memory/supabase.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function think(systemPrompt: string, history: Message[], userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type');
  return block.text;
}
