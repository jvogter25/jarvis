import { SubTask } from './task-planner.js';

export function buildClaudeCodeInstructions(subtask: SubTask, repoOwner: string, repoName: string): string {
  const progressNote = subtask.total > 1
    ? `\n> **Subtask ${subtask.index + 1} of ${subtask.total}: ${subtask.title}**\n`
    : '';

  const preloadedSection = subtask.relevantFiles.length > 0
    ? `## Pre-loaded Context Files
The following files have been identified as relevant. Read them carefully before writing any code.
${subtask.relevantFiles.map(f => `
### \`${f.path}\`
\`\`\`typescript
${f.content}
\`\`\``).join('\n')}

---
`
    : '';

  return `# Jarvis Coding Task
${progressNote}
## Repository
Owner: ${repoOwner}
Repo: ${repoName}
The repo is already cloned at /home/user/jarvis. Work there directly.

## Task
${subtask.intent}

${preloadedSection}## Implementation Process — follow exactly in order

### Phase 1: PLAN (5 minutes max)
1. Review the pre-loaded files above — they are the most relevant to this task
2. If you need to check one or two additional files, read them now (max 3 extra reads)
3. Write your plan to /home/user/plan.md — list each file you will create/modify and what changes you will make
4. Do NOT write any production code yet

### Phase 2: IMPLEMENT (commit after every file)
For each file in your plan:
1. Read the current file content (if modifying an existing file)
2. Make your changes
3. Run: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck 2>&1 | head -20
4. Fix any TypeScript errors before continuing
5. **Commit immediately after each file is complete:**
   \`\`\`
   cd /home/user/jarvis && git add -A && git commit -m "feat: [describe what you just did]"
   \`\`\`

### Phase 3: VERIFY
After all files are written and committed:
1. Run: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck 2>&1 | head -30
2. Fix any remaining errors and commit fixes
3. Run final check: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck
4. Write a brief summary to /home/user/test-report.md: what you changed and why

## Critical ESM Rules
- All local imports MUST use .js extension: \`import { foo } from './bar.js'\`
- Never use require()
- package.json has "type": "module"

## Critical Commit Rules
- Commit after EVERY file change — do not batch multiple files into one commit
- Use clear commit messages: "feat: add X to Y", "fix: handle Z in W"
- Never leave uncommitted changes at the end of the session

## When done
Write "DONE" to /home/user/done.txt to signal completion.
`;
}
