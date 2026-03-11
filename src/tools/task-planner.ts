import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();

export interface SubTask {
  index: number;
  total: number;
  title: string;
  intent: string;
  relevantFiles: string[];  // file paths only — Claude reads them itself
  fromBranch: string;  // which branch to clone from for this subtask
}

const MAX_RELEVANT_FILES = 8;
const SRC_DIR = '/app/src';

function getAllSourceFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(full);
        }
      }
    } catch { /* dir doesn't exist on local dev */ }
  }
  walk(SRC_DIR);
  return files;
}

export async function planCodingTask(intent: string): Promise<SubTask[]> {
  const allFiles = getAllSourceFiles();

  // If no local source files (local dev without /app), return single task with no hints
  if (allFiles.length === 0) {
    console.log('[task-planner] No local source files found at /app/src — skipping file hint');
    return [{
      index: 0,
      total: 1,
      title: 'Full task',
      intent,
      relevantFiles: [],
      fromBranch: 'main',
    }];
  }

  const fileList = allFiles.map(f => f.replace(SRC_DIR, 'src')).join('\n');

  const plannerPrompt = `You are a senior engineer helping plan a coding task for a Node.js/TypeScript Discord bot called Jarvis.

## Task
${intent}

## Available source files
${fileList}

## Instructions
1. Identify the ≤${MAX_RELEVANT_FILES} source files most relevant to implementing this task. Pick files that will need to be MODIFIED or that the modified files import from.
2. Decide if the task should be split into sequential subtasks. Split ONLY if the task clearly has independent phases (e.g., "create new module" then "wire it into existing handlers"). Each subtask must be completable in ≤30 minutes by Claude Code.
3. For most tasks (single-file changes, small features), return exactly 1 subtask.

Return ONLY valid JSON in this exact format — no markdown, no explanation:
{
  "relevantFiles": ["src/path/to/file.ts", ...],
  "subtasks": [
    { "title": "Short title", "intent": "Detailed description of exactly what to do in this subtask" }
  ]
}`;

  let plannerResponse: string;
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: plannerPrompt }],
    });
    plannerResponse = (msg.content[0] as any).text ?? '';
  } catch (err) {
    console.error('[task-planner] Planner LLM call failed:', err);
    return [{ index: 0, total: 1, title: 'Full task', intent, relevantFiles: [], fromBranch: 'main' }];
  }

  let plan: { relevantFiles: string[]; subtasks: Array<{ title: string; intent: string }> };
  try {
    const cleaned = plannerResponse.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    plan = JSON.parse(cleaned);
  } catch (err) {
    console.error('[task-planner] Failed to parse planner JSON:', plannerResponse.slice(0, 300));
    return [{ index: 0, total: 1, title: 'Full task', intent, relevantFiles: [], fromBranch: 'main' }];
  }

  const relevantFiles = (plan.relevantFiles ?? []).slice(0, MAX_RELEVANT_FILES);

  console.log(`[task-planner] ${relevantFiles.length} relevant file hint(s), ${plan.subtasks?.length ?? 1} subtask(s)`);

  const subtasks = plan.subtasks ?? [{ title: 'Full task', intent }];
  return subtasks.map((st, i) => ({
    index: i,
    total: subtasks.length,
    title: st.title,
    intent: st.intent,
    relevantFiles,
    fromBranch: 'main',  // first subtask always from main; agent.ts updates for subsequent ones
  }));
}
