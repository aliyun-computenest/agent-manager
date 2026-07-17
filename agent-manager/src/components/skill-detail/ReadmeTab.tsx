import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import { Loader2 } from 'lucide-react'

interface ReadmeTabProps {
  content: string | null
  loading: boolean
}

export default function ReadmeTab({ content, loading }: ReadmeTabProps) {
  const { t } = useTranslation('admin')

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-[#1890ff]" />
      </div>
    )
  }

  if (!content) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-[rgba(0,0,0,0.25)]">
        {t('skillSpace.noReadme')}
      </div>
    )
  }

  const html = marked(content) as string

  return (
    <div
      className="p-6 overflow-auto h-full readme-content"
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        lineHeight: '1.7',
        color: 'rgba(0,0,0,0.65)',
      }}
    />
  )
}
