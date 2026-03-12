/**
 * Moltlaunch API client.
 * Moltlaunch is an on-chain escrow marketplace for AI agent tasks.
 * API base: https://api.moltlaunch.com
 *
 * All requests are authenticated with the agent's private key via Bearer token.
 * The private key signs a timestamp to produce a short-lived JWT-like auth header.
 */

export interface MoltTask {
  id: string;
  clientAddress: string;
  requestText: string;
  budgetEth: number;
  createdAt: string;
  status: 'pending' | 'quoted' | 'escrowed' | 'submitted' | 'completed' | 'declined';
}

export interface MoltInboxResponse {
  tasks: MoltTask[];
}

const BASE_URL = process.env.MOLTLAUNCH_API_URL ?? 'https://api.moltlaunch.com';

function authHeader(): Record<string, string> {
  const privateKey = process.env.MOLTLAUNCH_PRIVATE_KEY ?? '';
  const agentAddress = process.env.AGENT_ADDRESS ?? '';
  const timestamp = Date.now().toString();
  // Simple HMAC-based auth — replace with actual signing scheme from Moltlaunch docs
  const { createHmac } = require('crypto');
  const sig = createHmac('sha256', privateKey).update(timestamp).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Agent-Address': agentAddress,
    'X-Timestamp': timestamp,
    'X-Signature': sig,
  };
}

async function moltFetch<T>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeader(),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Moltlaunch ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`);
  }

  return res.json() as Promise<T>;
}

/** Fetch tasks from the agent's inbox. Returns pending (un-quoted) tasks. */
export async function fetchInbox(): Promise<MoltTask[]> {
  try {
    const data = await moltFetch<MoltInboxResponse>('/v1/inbox');
    return data.tasks ?? [];
  } catch (err) {
    console.error('[moltlaunch] fetchInbox error:', (err as Error).message);
    return [];
  }
}

/** Submit a price quote for a task. Returns true on success. */
export async function submitQuote(taskId: string, priceEth: number, message: string): Promise<boolean> {
  try {
    await moltFetch(`/v1/task/${taskId}/quote`, 'POST', { priceEth, message });
    return true;
  } catch (err) {
    console.error(`[moltlaunch] submitQuote(${taskId}) error:`, (err as Error).message);
    return false;
  }
}

/** Decline a task (send rejection message). */
export async function declineTask(taskId: string, reason: string): Promise<void> {
  try {
    await moltFetch(`/v1/task/${taskId}/decline`, 'POST', { reason });
  } catch (err) {
    console.error(`[moltlaunch] declineTask(${taskId}) error:`, (err as Error).message);
  }
}

/** Poll task status. Returns 'escrowed' once client locks funds. */
export async function getTaskStatus(taskId: string): Promise<MoltTask['status']> {
  try {
    const task = await moltFetch<MoltTask>(`/v1/task/${taskId}`);
    return task.status;
  } catch (err) {
    console.error(`[moltlaunch] getTaskStatus(${taskId}) error:`, (err as Error).message);
    return 'pending';
  }
}

/** Submit the completed deliverable as markdown content. */
export async function submitDeliverable(taskId: string, markdownContent: string): Promise<boolean> {
  try {
    await moltFetch(`/v1/task/${taskId}/submit`, 'POST', {
      deliverable: markdownContent,
      format: 'markdown',
    });
    return true;
  } catch (err) {
    console.error(`[moltlaunch] submitDeliverable(${taskId}) error:`, (err as Error).message);
    return false;
  }
}

/** Claim payment after 24hr dispute window. */
export async function claimPayment(taskId: string): Promise<boolean> {
  try {
    await moltFetch(`/v1/task/${taskId}/claim`, 'POST', {});
    return true;
  } catch (err) {
    console.error(`[moltlaunch] claimPayment(${taskId}) error:`, (err as Error).message);
    return false;
  }
}
