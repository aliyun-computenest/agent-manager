import { describe, expect, it } from 'vitest'
import { collectSpendByConsumer } from '../../server/services/providers/litellm-usage.js'

describe('LiteLLM usage aggregation', () => {
  it('collects spend from current api_key_breakdown by key_alias', () => {
    const spendByConsumer = collectSpendByConsumer([
      {
        breakdown: {
          models: {
            'qwen-plus': {
              api_key_breakdown: {
                tokenA: {
                  metrics: { spend: 0.12 },
                  metadata: { key_alias: 'openclaw_user_1' }
                },
                tokenB: {
                  metrics: { spend: 0.33 },
                  metadata: { key_alias: 'openclaw_user_2' }
                }
              }
            },
            'qwen-max': {
              api_key_breakdown: {
                tokenA: {
                  metrics: { spend: 0.08 },
                  metadata: { key_alias: 'openclaw_user_1' }
                }
              }
            }
          }
        }
      }
    ])

    expect(spendByConsumer.get('openclaw_user_1')).toBe(0.2)
    expect(spendByConsumer.get('openclaw_user_2')).toBe(0.33)
  })

  it('collects spend from entity api_key_breakdown by entity id', () => {
    const spendByConsumer = collectSpendByConsumer([
      {
        breakdown: {
          entities: {
            openclaw_group_1: {
              api_key_breakdown: {
                tokenA: {
                  metrics: { spend: 0.42 },
                  metadata: { key_alias: 'openclaw_group_1' }
                },
                tokenB: {
                  spend: '0.58',
                  metadata: { key_alias: 'openclaw_group_1_1780000000000' }
                }
              }
            }
          }
        }
      }
    ])

    expect(spendByConsumer.get('openclaw_group_1')).toBe(1)
  })

  it('prefers user_id over key_alias when aggregating model breakdown', () => {
    const spendByConsumer = collectSpendByConsumer([
      {
        breakdown: {
          models: {
            'qwen-plus': {
              api_key_breakdown: {
                tokenA: {
                  metrics: { spend: 0.12 },
                  metadata: {
                    user_id: 'openclaw_user_1',
                    key_alias: 'openclaw_user_1_1780000000000'
                  }
                }
              }
            }
          }
        }
      }
    ])

    expect(spendByConsumer.get('openclaw_user_1')).toBe(0.12)
    expect(spendByConsumer.has('openclaw_user_1_1780000000000')).toBe(false)
  })

  it('keeps legacy entity breakdown support', () => {
    const spendByConsumer = collectSpendByConsumer([
      {
        breakdown: {
          entities: {
            openclaw_user_1: { metrics: { spend: 1.5 } },
            openclaw_user_2: { total_spend: '2.25' },
            Unassigned: { spend: 9 }
          }
        }
      }
    ])

    expect(spendByConsumer.get('openclaw_user_1')).toBe(1.5)
    expect(spendByConsumer.get('openclaw_user_2')).toBe(2.25)
    expect(spendByConsumer.has('Unassigned')).toBe(false)
  })
})
