import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const mboxPath = process.argv[2];
if (!mboxPath) {
  console.error('Usage: node scripts/ingest-email-style.mjs <path-to-Sent.mbox>');
  process.exit(1);
}

const resolvedPath = path.resolve(mboxPath.replace(/^~/, process.env.HOME ?? ''));
if (!fs.existsSync(resolvedPath)) {
  console.error(`File not found: ${resolvedPath}`);
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_ANON_KEY
);

console.log('Reading .mbox file...');
const raw = fs.readFileSync(resolvedPath, 'utf-8');

const chunks = raw.split(/^From /m).filter(c => c.trim().length > 0);
console.log(`Found ${chunks.length} raw messages`);

function extractEmail(chunk) {
  const lines = chunk.split('\n');
  let subject = '';
  let inBody = false;
  const bodyLines = [];

  for (const line of lines) {
    if (!inBody) {
      if (line.toLowerCase().startsWith('subject:')) {
        subject = line.replace(/^subject:\s*/i, '').trim();
      }
      if (line.trim() === '') {
        inBody = true;
      }
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join('\n').trim();
  if (body.length < 50) return null;
  if (body.startsWith('---------- Forwarded message')) return null;
  return { subject, body: body.slice(0, 2000) };
}

const emails = chunks
  .map(extractEmail)
  .filter(Boolean)
  .slice(0, 200);

console.log(`Extracted ${emails.length} usable emails (after filtering)`);

if (emails.length === 0) {
  console.error('No usable emails found. Check the .mbox format.');
  process.exit(1);
}

const BATCH_SIZE = 15;
const batches = [];
for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  batches.push(emails.slice(i, i + BATCH_SIZE));
}

console.log(`Processing ${batches.length} batch(es) with haiku...`);

async function extractBatchStyle(batch, batchIndex) {
  const emailText = batch.map((e, i) =>
    `--- Email ${i + 1} ---\nSubject: ${e.subject}\n\n${e.body}`
  ).join('\n\n');

  const prompt = `You are analyzing a set of emails written by the same person (Jake) to extract their writing style.

Emails to analyze:
${emailText.slice(0, 12000)}

Extract specific, actionable style patterns. Return JSON only, no markdown:
{
  "sentence_length": "short/medium/long and why",
  "openers": ["typical opening phrases or patterns"],
  "closers": ["typical closing phrases or sign-offs"],
  "ask_style": "how they make requests or calls to action",
  "formality": "casual/semi-formal/formal",
  "phrases_used": ["phrases or words they commonly use"],
  "phrases_avoided": ["formal/corporate phrases they do not use"],
  "tone_notes": "overall tone description in 2 sentences"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are extracting email writing style patterns. Return only valid JSON.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`Batch ${batchIndex + 1}: failed to parse JSON, skipping`);
    return null;
  }
}

const batchResults = [];
for (let i = 0; i < batches.length; i++) {
  process.stdout.write(`  Batch ${i + 1}/${batches.length}... `);
  const result = await extractBatchStyle(batches[i], i);
  if (result) {
    batchResults.push(result);
    console.log('done');
  } else {
    console.log('skipped (parse error)');
  }
}

if (batchResults.length === 0) {
  console.error('All batches failed. Cannot synthesize style profile.');
  process.exit(1);
}

console.log('\nSynthesizing unified style profile with sonnet...');

const synthesisPrompt = `You are synthesizing ${batchResults.length} partial email style analyses from the same writer (Jake) into one unified, authoritative style guide.

Batch analyses:
${JSON.stringify(batchResults, null, 2).slice(0, 10000)}

Synthesize these into a single, unified style profile. Resolve any contradictions by going with the majority pattern. Return JSON only, no markdown:
{
  "summary": "2-3 sentence description of Jake's overall email writing voice",
  "sentence_length": "short/medium/long + explanation",
  "openers": ["5-8 typical opening patterns"],
  "closers": ["3-5 typical closing patterns"],
  "ask_style": "how to phrase requests and calls-to-action",
  "formality": "casual/semi-formal/formal",
  "phrases_to_use": ["10-15 phrases or words Jake commonly uses"],
  "phrases_to_avoid": ["10-15 formal/corporate phrases Jake avoids"],
  "tone_notes": "specific guidance for writing in Jake's voice",
  "example_opener": "example of a strong opening sentence in Jake's voice",
  "example_ask": "example of how Jake would make a clear ask"
}`;

const synthesisResponse = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 2048,
  system: 'You are synthesizing writing style patterns into a unified guide. Return only valid JSON.',
  messages: [{ role: 'user', content: synthesisPrompt }],
});

const synthesisText = synthesisResponse.content.find(b => b.type === 'text')?.text ?? '{}';
let styleProfile;
try {
  styleProfile = JSON.parse(synthesisText);
} catch {
  console.error('Synthesis parse failed. Raw output:\n', synthesisText.slice(0, 500));
  process.exit(1);
}

console.log('\nSaving to Supabase knowledge_base...');

const { error } = await supabase
  .from('knowledge_base')
  .upsert({
    domain: 'email_style',
    title: 'Jake email writing style',
    content: JSON.stringify(styleProfile, null, 2),
    key_insights: [
      styleProfile.summary ?? '',
      `Formality: ${styleProfile.formality}`,
      `Ask style: ${styleProfile.ask_style}`,
      `Tone: ${styleProfile.tone_notes}`,
    ].filter(Boolean),
    source_url: null,
  }, {
    onConflict: 'domain,title',
  });

if (error) {
  console.error('Supabase upsert failed:', error);
  process.exit(1);
}

console.log('\nDone! Email style profile saved to knowledge_base.');
console.log('\nStyle summary:', styleProfile.summary);
