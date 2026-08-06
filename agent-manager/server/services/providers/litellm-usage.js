function readSpend(value) {
  const spend = Number(value)
  return Number.isFinite(spend) ? spend : 0
}

function readEntrySpend(entry) {
  return readSpend(entry?.metrics?.spend ?? entry?.spend ?? entry?.total_spend ?? 0)
}

function addSpend(consumerSpendMap, consumerId, spend) {
  if (!consumerId || consumerId === 'Unassigned' || spend === 0) return
  consumerSpendMap.set(consumerId, (consumerSpendMap.get(consumerId) || 0) + spend)
}

function collectApiKeyBreakdownSpend(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object') return 0
  return Object.values(apiKeys).reduce((sum, keyData) => sum + readEntrySpend(keyData), 0)
}

export function collectSpendByConsumer(results) {
  const consumerSpendMap = new Map()
  const dayResults = Array.isArray(results) ? results : []

  for (const day of dayResults) {
    const entities = day?.breakdown?.entities
    if (entities && typeof entities === 'object') {
      for (const [entityId, entityData] of Object.entries(entities)) {
        addSpend(
          consumerSpendMap,
          entityId,
          readEntrySpend(entityData) + collectApiKeyBreakdownSpend(entityData?.api_key_breakdown)
        )
      }
    }

    const models = day?.breakdown?.models
    if (!models || typeof models !== 'object') continue

    for (const modelData of Object.values(models)) {
      const apiKeys = modelData?.api_key_breakdown
      if (!apiKeys || typeof apiKeys !== 'object') continue

      for (const keyData of Object.values(apiKeys)) {
        const metadata = keyData?.metadata || {}
        const consumerId = metadata.user_id || metadata.key_alias || metadata.end_user || metadata.team_id
        addSpend(consumerSpendMap, consumerId, readEntrySpend(keyData))
      }
    }
  }

  return consumerSpendMap
}
