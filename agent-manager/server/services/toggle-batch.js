/**
 * Batch Toggle Executor
 *
 * 对某个 Agent Type 下所有 running 实例，通过 e2b Sandbox API 并发执行
 * `toggle-observability.sh enable/disable`，用于批量开启/关闭采集。
 */

import { Sandbox } from '@e2b/code-interpreter'
import { supabaseAdmin } from '../config/index.js'

// 每批最多并发执行的实例数量，避免一次性连接过多 sandbox
const BATCH_SIZE = 5

/**
 * 对单个实例执行 toggle-observability.sh
 * @param {{ id: string, sandbox_id: string }} instance
 * @param {boolean} enabled
 */
async function toggleOneInstance(instance, enabled) {
  const action = enabled ? 'enable' : 'disable'
  const sandbox = await Sandbox.connect(instance.sandbox_id)
  const result = await sandbox.commands.run(
    `toggle-observability.sh ${action}`,
    { user: 'root', timeoutMs: 15000 }
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `exit code ${result.exitCode}`)
  }
  console.log(`[batch-toggle] ${action} succeeded for sandbox ${instance.sandbox_id}`)
}

/**
 * 批量对某 Agent Type 的所有 running 实例执行采集开关 toggle
 * @param {string} agentTypeId
 * @param {boolean} enabled
 * @returns {Promise<{ succeeded: number, failed: number, total: number }>}
 */
export async function executeBatchToggle(agentTypeId, enabled) {
  const action = enabled ? 'enable' : 'disable'

  const { data: instances, error } = await supabaseAdmin
    .from('agent_instances')
    .select('id, sandbox_id')
    .eq('agent_type_id', agentTypeId)
    .eq('status', 'running')
    .not('sandbox_id', 'is', null)

  if (error) {
    console.error(`[batch-toggle] failed to query running instances for agent type ${agentTypeId}:`, error.message || error)
    throw new Error(`Failed to query running instances: ${error.message || error}`)
  }

  const total = instances?.length || 0
  console.log(`[batch-toggle] start ${action} for agent type ${agentTypeId}, ${total} running instance(s)`)

  let succeeded = 0
  let failed = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = instances.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map(inst => toggleOneInstance(inst, enabled))
    )

    results.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        succeeded++
      } else {
        failed++
        const inst = batch[idx]
        const reason = res.reason?.message || res.reason
        console.warn(`[batch-toggle] ${action} failed for sandbox ${inst.sandbox_id} (instance ${inst.id}): ${reason}`)
      }
    })
  }

  console.log(`[batch-toggle] done ${action} for agent type ${agentTypeId}: succeeded=${succeeded}, failed=${failed}, total=${total}`)

  return { succeeded, failed, total }
}
