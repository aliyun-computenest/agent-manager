export interface Budget {
  timeRate: 'daily' | 'monthly'
  value: number
  unit: 'token' | 'usd' | 'cny' | 'credits'
}

export const BudgetTimeRateLabels: Record<string, string> = {
  daily: '每日',
  monthly: '每月'
}

export const BudgetUnitLabels: Record<string, string> = {
  token: 'Token',
  usd: 'USD',
  cny: 'CNY',
  credits: '积分'
}

export const BudgetUnitSymbols: Record<string, string> = {
  token: '',
  usd: '$',
  cny: '¥',
  credits: ''
}
