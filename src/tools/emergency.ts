import { saveShutdownState, loadShutdownState } from '../memory/supabase.js';

let locked = false;

export function isEmergencyLocked(): boolean {
  return locked;
}

export async function activateEmergencyLock(pendingState: Record<string, unknown>): Promise<{ sandboxesKilled: number; pendingCleared: string[] }> {
  locked = true;

  // Kill all active E2B sandboxes
  const { killAllSandboxes } = await import('./claude-code-agent.js');
  const sandboxesKilled = await killAllSandboxes();

  // Persist: save lock + snapshot of what was cleared
  await saveShutdownState({
    ...pendingState,
    emergencyLocked: true,
    lockedAt: new Date().toISOString(),
  });

  const pendingCleared: string[] = [];
  if (Object.keys((pendingState as any).pendingApprovals?.prApprovals ?? {}).length) pendingCleared.push('PR approvals');
  if (Object.keys((pendingState as any).pendingApprovals?.stagingApprovals ?? {}).length) pendingCleared.push('staging approvals');
  if (Object.keys((pendingState as any).pendingApprovals?.previewApprovals ?? {}).length) pendingCleared.push('preview approvals');
  if (Object.keys((pendingState as any).pendingApprovals?.emailApprovals ?? {}).length) pendingCleared.push('email approvals');

  return { sandboxesKilled, pendingCleared };
}

export async function deactivateEmergencyLock(): Promise<void> {
  locked = false;
  // Load current state and remove the lock flag
  const current = await loadShutdownState();
  if (current) {
    const { emergencyLocked: _removed, lockedAt: _ts, ...rest } = current as any;
    await saveShutdownState(rest);
  }
}

export async function restoreEmergencyLockState(): Promise<void> {
  const state = await loadShutdownState();
  if (state?.emergencyLocked) {
    locked = true;
    console.log('[emergency] Restored locked state from Supabase — Jarvis is in baseline mode.');
  }
}

const KILL_PATTERNS = [
  /\babort everything\b/i,
  /\bkill everything\b/i,
  /\bhard reset\b/i,
  /\bstop all operations\b/i,
  /\bemergency stop\b/i,
  /\bkill all\b/i,
  /\babort all\b/i,
  /\bkill switch\b/i,
];

const RESUME_PATTERNS = [
  /\ball clear\b/i,
  /\bresume normal operations?\b/i,
  /\byou(?:'re| are) good to go\b/i,
  /\bback online\b/i,
  /\bunlock\b/i,
  /\bresume everything\b/i,
];

export function detectKillPhrase(text: string): boolean {
  return KILL_PATTERNS.some(p => p.test(text));
}

export function detectResumePhrase(text: string): boolean {
  return RESUME_PATTERNS.some(p => p.test(text));
}
