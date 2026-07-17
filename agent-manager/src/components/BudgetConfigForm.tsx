import { Budget, BudgetTimeRateLabels, BudgetUnitLabels } from '../types/budget'

interface BudgetConfigFormProps {
  budgets: Budget[]
  onChange: (budgets: Budget[]) => void
  allowedUnits: string[]
  allowedTimeRates: string[]
  disabled?: boolean
}

export default function BudgetConfigForm({
  budgets,
  onChange,
  allowedUnits,
  allowedTimeRates,
  disabled = false
}: BudgetConfigFormProps) {
  const handleValueChange = (index: number, value: string) => {
    const next = [...budgets]
    next[index] = { ...next[index], value: parseFloat(value) || 0 }
    onChange(next)
  }

  const handleUnitChange = (index: number, unit: string) => {
    const next = [...budgets]
    next[index] = { ...next[index], unit: unit as Budget['unit'] }
    onChange(next)
  }

  const handleTimeRateChange = (index: number, timeRate: string) => {
    const next = [...budgets]
    next[index] = { ...next[index], timeRate: timeRate as Budget['timeRate'] }
    onChange(next)
  }

  const handleRemove = (index: number) => {
    const next = budgets.filter((_, i) => i !== index)
    onChange(next)
  }

  const handleAdd = () => {
    const newBudget: Budget = {
      timeRate: allowedTimeRates[0] as Budget['timeRate'],
      value: 0,
      unit: allowedUnits[0] as Budget['unit']
    }
    onChange([...budgets, newBudget])
  }

  return (
    <div className="space-y-3">
      {budgets.map((budget, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            value={budget.value || ''}
            onChange={(e) => handleValueChange(index, e.target.value)}
            disabled={disabled}
            className="w-32 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            placeholder="限额值"
          />

          {allowedUnits.length > 1 ? (
            <select
              value={budget.unit}
              onChange={(e) => handleUnitChange(index, e.target.value)}
              disabled={disabled}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            >
              {allowedUnits.map(u => (
                <option key={u} value={u}>{BudgetUnitLabels[u] || u}</option>
              ))}
            </select>
          ) : (
            <span className="px-3 py-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md">
              {BudgetUnitLabels[budget.unit] || budget.unit}
            </span>
          )}

          <span className="text-gray-500 text-sm">/</span>

          {allowedTimeRates.length > 1 ? (
            <select
              value={budget.timeRate}
              onChange={(e) => handleTimeRateChange(index, e.target.value)}
              disabled={disabled}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            >
              {allowedTimeRates.map(t => (
                <option key={t} value={t}>{BudgetTimeRateLabels[t] || t}</option>
              ))}
            </select>
          ) : (
            <span className="px-3 py-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md">
              {BudgetTimeRateLabels[budget.timeRate] || budget.timeRate}
            </span>
          )}

          {!disabled && (
            <button
              type="button"
              onClick={() => handleRemove(index)}
              className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
              title="移除"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
      ))}

      {!disabled && (
        <button
          type="button"
          onClick={handleAdd}
          className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
          添加限额规则
        </button>
      )}

      {budgets.length === 0 && (
        <p className="text-sm text-gray-500">未设置限额规则（无限制）</p>
      )}
    </div>
  )
}
