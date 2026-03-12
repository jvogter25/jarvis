import {
  fetchInbox,
  submitQuote,
  declineTask,
  getTaskStatus,
  submitDeliverable,
  claimPayment,
  type MoltTask,
} from './moltlaunch.js';
import { analyzeTask } from './analyze.js';
import { executeSkill } from './executor.js';
import {
  postToDiscord,
  taskAcceptedMsg,
  taskDeclinedMsg,
  escrowConfirmedMsg,
  deliverableSubmittedMsg,
  paymentClaimedMsg,
  errorMsg,
} from './discord.js';

// Track tasks we've already processed to avoid double-handling
const processedTaskIds = new Set<string>();

// Track tasks waiting for escrow confirmation: taskId -> { analysis, quotedAt }
interface PendingEscrow {
  taskId: string;
  skill: string;
  target: string;
  priceEth: number;
  quotedAt: number;
}
const pendingEscrow = new Map<string, PendingEscrow>();

// Track tasks in execution: taskId -> { submittedAt, priceEth }
interface SubmittedTask {
  submittedAt: number;
  priceEth: number;
}
const submittedTasks = new Map<string, SubmittedTask>();

/** Called every 2 minutes — poll inbox for new tasks */
export async function pollInbox(): Promise<void> {
  console.log('[inbox] Polling Moltlaunch inbox...');

  // 1. Check for new tasks
  const tasks = await fetchInbox();
  for (const task of tasks) {
    if (processedTaskIds.has(task.id)) continue;
    processedTaskIds.add(task.id);
    await handleNewTask(task).catch(err =>
      postToDiscord(errorMsg('handleNewTask', (err as Error).message))
    );
  }

  // 2. Check escrow status for pending tasks
  for (const [taskId, pending] of pendingEscrow.entries()) {
    await checkEscrowAndExecute(taskId, pending).catch(err =>
      postToDiscord(errorMsg('checkEscrow', (err as Error).message))
    );
  }

  // 3. Claim payments for tasks past the 24hr window
  const now = Date.now();
  const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
  for (const [taskId, sub] of submittedTasks.entries()) {
    if (now - sub.submittedAt >= CLAIM_WINDOW_MS) {
      await attemptClaimPayment(taskId, sub.priceEth);
      submittedTasks.delete(taskId);
    }
  }

  console.log(`[inbox] Done. Pending escrow: ${pendingEscrow.size}, Awaiting claim: ${submittedTasks.size}`);
}

async function handleNewTask(task: MoltTask): Promise<void> {
  console.log(`[inbox] New task ${task.id}: "${task.requestText.slice(0, 80)}"`);

  const analysis = await analyzeTask(task.requestText);

  if (!analysis.accepted || !analysis.skill) {
    // Decline
    await declineTask(task.id, analysis.declineReason ?? 'Skill not available.');
    await postToDiscord(taskDeclinedMsg(task.id, analysis.declineReason ?? 'Skill not available.'));
    console.log(`[inbox] Task ${task.id} declined.`);
    return;
  }

  // Submit quote
  const quoted = await submitQuote(task.id, analysis.priceEth, analysis.quoteMessage);
  if (!quoted) {
    console.error(`[inbox] Failed to quote task ${task.id}`);
    return;
  }

  await postToDiscord(taskAcceptedMsg(task.id, analysis.skill, analysis.priceEth, analysis.target));

  // Track for escrow confirmation
  pendingEscrow.set(task.id, {
    taskId: task.id,
    skill: analysis.skill,
    target: analysis.target,
    priceEth: analysis.priceEth,
    quotedAt: Date.now(),
  });
}

async function checkEscrowAndExecute(taskId: string, pending: PendingEscrow): Promise<void> {
  const status = await getTaskStatus(taskId);

  if (status !== 'escrowed') {
    // Quotes expire after 48 hours with no response
    const AGE_MS = Date.now() - pending.quotedAt;
    if (AGE_MS > 48 * 60 * 60 * 1000) {
      console.log(`[inbox] Task ${taskId} quote expired — removing from pending`);
      pendingEscrow.delete(taskId);
    }
    return;
  }

  // Escrow confirmed!
  pendingEscrow.delete(taskId);
  await postToDiscord(escrowConfirmedMsg(taskId));
  console.log(`[inbox] Task ${taskId} escrowed — executing skill=${pending.skill}`);

  try {
    const deliverable = await executeSkill(pending.skill as any, pending.target);
    const submitted = await submitDeliverable(taskId, deliverable);

    if (submitted) {
      await postToDiscord(deliverableSubmittedMsg(taskId));
      submittedTasks.set(taskId, { submittedAt: Date.now(), priceEth: pending.priceEth });
      console.log(`[inbox] Task ${taskId} deliverable submitted.`);
    } else {
      await postToDiscord(errorMsg(`submit task ${taskId}`, 'submitDeliverable returned false'));
    }
  } catch (err) {
    await postToDiscord(errorMsg(`execute task ${taskId}`, (err as Error).message));
  }
}

async function attemptClaimPayment(taskId: string, priceEth: number): Promise<void> {
  console.log(`[inbox] Claiming payment for task ${taskId}`);
  const claimed = await claimPayment(taskId);
  if (claimed) {
    await postToDiscord(paymentClaimedMsg(taskId, priceEth));
    console.log(`[inbox] Payment claimed for task ${taskId}: ${priceEth} ETH`);
  } else {
    await postToDiscord(errorMsg(`claim payment ${taskId}`, 'claimPayment returned false'));
  }
}
