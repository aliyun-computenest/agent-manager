import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Boxes, Plus, Search, ChevronRight, Trash2, Loader2, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { listSandboxSets, deleteSandboxSet, type SandboxSetSummary } from '../lib/sandboxsets'

function formatUpdatedAt(iso: string) {
  try {
    const d = new Date(iso)
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

const SandboxSetManagement: React.FC = () => {
  const navigate = useNavigate()
  const { session } = useAuth()
  const { t } = useTranslation('admin')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SandboxSetSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const token = session?.access_token

  const fetchList = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const data = await listSandboxSets(token)
      setItems(data)
    } catch (err: any) {
      setError(err.code === 'Cluster.Unavailable'
        ? t('sandboxsetManagement.clusterUnavailable')
        : (err.message || t('sandboxsetManagement.loadFailed')))
    } finally {
      setLoading(false)
    }
  }, [token, t])

  useEffect(() => { fetchList() }, [fetchList])

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    const q = query.trim().toLowerCase()
    return items.filter(item =>
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q),
    )
  }, [items, query])

  const handleDelete = async (name: string, namespace: string) => {
    if (!token) return
    if (!window.confirm(t('sandboxsetManagement.confirmDelete', { name }))) {
      return
    }
    try {
      await deleteSandboxSet(name, token, namespace)
      await fetchList()
    } catch (err: any) {
      alert(err.message || t('sandboxsetManagement.deleteFailed'))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">{t('sandboxsetManagement.loading')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Boxes className="w-6 h-6 text-primary-600" />
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{t('sandboxsetManagement.title')}</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('sandboxsetManagement.subtitle')}
            </p>
          </div>
        </div>
        <button
          onClick={() => navigate('/admin/sandboxsets/new')}
          className="btn-primary flex items-center space-x-2"
        >
          <Plus className="w-4 h-4" />
          <span>{t('sandboxsetManagement.newButton')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="card">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sandboxsetManagement.searchPlaceholder')}
            className="input-field pl-9"
          />
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">{t('sandboxsetManagement.table.name')}</th>
                <th className="px-4 py-3">{t('sandboxsetManagement.table.namespace')}</th>
                <th className="px-4 py-3">{t('sandboxsetManagement.table.image')}</th>
                <th className="px-4 py-3">{t('sandboxsetManagement.table.replicas')}</th>
                <th className="px-4 py-3">{t('sandboxsetManagement.table.relatedAgentType')}</th>
                <th className="px-4 py-3">{t('sandboxsetManagement.table.updatedAt')}</th>
                <th className="px-4 py-3 text-right">{t('sandboxsetManagement.table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                    {query ? t('sandboxsetManagement.noMatch') : t('sandboxsetManagement.empty')}
                  </td>
                </tr>
              ) : (
                filtered.map(item => (
                  <tr
                    key={`${item.namespace}/${item.name}`}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => navigate(`/admin/sandboxsets/${item.name}?ns=${item.namespace}`)}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">{item.name}</td>
                    <td className="px-4 py-3 text-gray-600">{item.namespace}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs font-mono max-w-[200px] truncate" title={item.image}>
                      {item.image || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{item.replicas}</td>
                    <td className="px-4 py-3">
                      {item.relatedAgentTypeCodes.length > 0
                        ? item.relatedAgentTypeCodes.map(code => (
                            <span key={code} className="inline-block text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded mr-1 mb-0.5">{code}</span>
                          ))
                        : <span className="text-gray-400 text-xs">-</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatUpdatedAt(item.updatedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end space-x-2" onClick={(e) => e.stopPropagation()}>
                        <Link
                          to={`/admin/sandboxsets/${item.name}?ns=${item.namespace}`}
                          className="inline-flex items-center text-sm text-primary-600 hover:text-primary-700"
                        >
                          {t('sandboxsetManagement.actions.view')}<ChevronRight className="w-4 h-4" />
                        </Link>
                        <button
                          onClick={() => handleDelete(item.name, item.namespace)}
                          className="p-1.5 rounded-md text-red-500 hover:bg-red-50"
                          title={t('sandboxsetManagement.actions.delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('sandboxsetManagement.warning')}
        </div>
      </div>
    </div>
  )
}

export default SandboxSetManagement
