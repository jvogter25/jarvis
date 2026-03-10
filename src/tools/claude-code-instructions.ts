export function buildClaudeCodeInstructions(intent: string, repoOwner: string, repoName: string): string {
  return `# Jarvis Self-Modification Task

## Repository
Owner: ${repoOwner}
Repo: ${repoName}
The repo is already cloned at /home/user/jarvis. Work there directly.

## Task
${intent}

## Required 4-Phase Process — follow exactly in order

### Phase 1: ARCHITECT
1. Run: find /home/user/jarvis/src -name "*.ts" | head -80
2. Read the files most relevant to this task
3. Write your implementation plan to /home/user/plan.md — include: files to create/modify, new imports needed, functions to change, integration points to verify
4. Do NOT write any production code yet in this phase

### Phase 2: IMPLEMENT
For each file in your plan (one at a time):
1. Read the current file content
2. Make targeted edits — only change what is needed for the task
3. After editing each file, run: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck 2>&1 | head -20
4. Fix any TypeScript errors before moving to the next file

### Phase 3: REVIEW
After all files are written:
1. Re-read every file you modified
2. Verify all local imports use .js extensions (ESM requirement — CRITICAL)
3. Verify all async functions have try/catch where appropriate
4. Verify no hardcoded secrets — only process.env.VARIABLE_NAME
5. Run: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck 2>&1 | head -30
6. Fix any errors found

### Phase 4: TEST
1. Run: cd /home/user/jarvis && node_modules/.bin/tsc --noCheck
2. If it exits non-zero, fix errors and re-run until clean
3. Write your findings to /home/user/test-report.md
4. When all phases complete, write "DONE" to /home/user/done.txt

## Critical ESM Rules
- All local imports MUST use .js extension: import { foo } from './bar.js'
- Never use require()
- package.json has "type": "module"

## When done
Write "DONE" to /home/user/done.txt to signal completion.
`;
}
