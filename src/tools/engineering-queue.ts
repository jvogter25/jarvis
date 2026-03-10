import { getPendingQueueItems, updateQueueItem } from '../memory/supabase.js';
import { requestSelfModify, executeSelfModifyPlan } from './self-modify.js';

export async function processQueue(
  postToEngineering: (message: string) => Promise<void>
): Promise<void> {
  const items = await getPendingQueueItems();
  if (items.length === 0) {
    console.log('[queue] No pending items.');
    return;
  }

  console.log(`[queue] Processing ${items.length} queued item(s)...`);

  for (const item of items) {
    try {
      await updateQueueItem(item.id, { status: 'running' });
      await postToEngineering(`🔧 Starting queued task: *${item.intent.slice(0, 100)}*`);

      const result = await requestSelfModify(item.intent);

      if (!result.success || !result.plan) {
        await updateQueueItem(item.id, { status: 'failed', result: result.message });
        await postToEngineering(`❌ Queue task failed: ${result.message.slice(0, 200)}`);
        continue;
      }

      const execution = await executeSelfModifyPlan(result.plan);
      const summary = execution.prUrl
        ? `PR ready: ${execution.prUrl}`
        : execution.message;

      await updateQueueItem(item.id, { status: 'done', result: summary });
      await postToEngineering(`✅ Queue task complete: ${summary}`);
    } catch (err) {
      const msg = (err as Error).message;
      await updateQueueItem(item.id, { status: 'failed', result: msg });
      await postToEngineering(`❌ Queue task error: ${msg.slice(0, 200)}`);
    }
  }
}
