/**
 * Budget 统一预算模型
 * 
 * 限额/用量 = Budget[] 列表，每个 Budget 自描述（值 + 单位 + 时间维度）
 * Budget 数据不落库，通过 Provider API 实时读写
 */

// ===== 枚举定义 =====

const BudgetTimeRate = Object.freeze({
  DAILY: 'daily',
  MONTHLY: 'monthly',

  labels: {
    daily: '每日',
    monthly: '每月'
  },

  label(key) {
    return this.labels[key] || key
  }
})

const BudgetUnit = Object.freeze({
  TOKEN: 'token',
  USD: 'usd',
  CNY: 'cny',
  CREDITS: 'credits',

  labels: {
    token: 'Token',
    usd: 'USD',
    cny: 'CNY',
    credits: '积分'
  },

  symbols: {
    token: '',
    usd: '$',
    cny: '¥',
    credits: ''
  },

  label(key) {
    return this.labels[key] || key
  },

  symbol(key) {
    return this.symbols[key] || ''
  }
})

// ===== Budget 类 =====

class Budget {
  /**
   * @param {string} timeRate - 时间维度 (daily | monthly)
   * @param {number} value - 限额数值
   * @param {string} unit - 限额单位 (token | usd | cny | credits)
   */
  constructor(timeRate, value, unit) {
    this.timeRate = timeRate
    this.value = value
    this.unit = unit
  }

  static fromJSON(obj) {
    return new Budget(obj.timeRate, obj.value, obj.unit)
  }

  toJSON() {
    return { timeRate: this.timeRate, value: this.value, unit: this.unit }
  }

  toString() {
    const unitLabel = BudgetUnit.label(this.unit)
    const timeLabel = BudgetTimeRate.label(this.timeRate)
    return `${this.value} ${unitLabel} / ${timeLabel}`
  }
}

// ===== BudgetList 类 =====

class BudgetList {
  /**
   * @param {Array} budgets - Budget 实例或普通对象数组
   */
  constructor(budgets = []) {
    this.budgets = budgets.map(b =>
      b instanceof Budget ? b : Budget.fromJSON(b)
    )
  }

  /** 是否启用限额（列表非空且存在 value > 0 的条目） */
  get enabled() {
    return this.budgets.length > 0 && this.budgets.some(b => b.value > 0)
  }

  /** 按单位筛选 */
  getByUnit(unit) {
    return this.budgets.filter(b => b.unit === unit)
  }

  /** 按时间维度筛选 */
  getByTimeRate(timeRate) {
    return this.budgets.filter(b => b.timeRate === timeRate)
  }

  /** 获取第一个匹配项 */
  find(unit, timeRate) {
    return this.budgets.find(b => b.unit === unit && b.timeRate === timeRate)
  }

  /** 添加或替换一个预算条目（同 unit + timeRate 覆盖） */
  upsert(budget) {
    const idx = this.budgets.findIndex(
      b => b.unit === budget.unit && b.timeRate === budget.timeRate
    )
    if (idx >= 0) {
      this.budgets[idx] = budget
    } else {
      this.budgets.push(budget)
    }
  }

  /** 移除指定预算条目 */
  remove(unit, timeRate) {
    this.budgets = this.budgets.filter(
      b => !(b.unit === unit && b.timeRate === timeRate)
    )
  }

  /** 序列化为 JSON 数组 */
  toJSON() {
    return this.budgets.map(b => b.toJSON())
  }

  /** 从 JSON 数组构造 */
  static fromJSON(arr) {
    return new BudgetList((arr || []).map(b => Budget.fromJSON(b)))
  }

  /** 人类可读摘要 */
  toString() {
    return this.budgets.map(b => b.toString()).join(' + ')
  }
}

export { Budget, BudgetTimeRate, BudgetUnit, BudgetList }
