import { useTranslation } from 'react-i18next'
import { Link2, Copy } from 'lucide-react'
import toast from 'react-hot-toast'

interface InstallPanelProps {
  skillName: string
  skillSpaceName?: string
  isCustomSkill: boolean
  onDownload: () => void
  downloadLoading?: boolean
}

export default function InstallPanel({ skillName, skillSpaceName, isCustomSkill, onDownload, downloadLoading }: InstallPanelProps) {
  const { t } = useTranslation('admin')

  const STEP1_CMD = '/bin/bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz)"'
  const STEP2_CMD = 'aliyun configure set --profile AkProfile --mode AK --access-key-id *** --access-key-secret *** --region "*"'
  const installCmd = isCustomSkill && skillSpaceName
    ? `computenest-cli skillhub install --skill_space_name '${skillSpaceName}' '${skillName}'`
    : `computenest-cli skillhub install ${skillName}`

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('skillSpace.copiedToClipboard'))
  }

  return (
    <div className="w-[320px] border-l border-[#e8e8e8] p-4 overflow-y-auto flex-shrink-0">
      <h4 className="text-base font-medium text-[rgba(0,0,0,0.85)] mb-4">{t('skillSpace.installSteps')}</h4>

      {/* Manual download */}
      <div className="mb-4">
        <div className="text-sm text-[rgba(0,0,0,0.65)] mb-2">{t('skillSpace.manualDownload')}</div>
        <button
          onClick={onDownload}
          disabled={downloadLoading}
          className="w-full h-8 flex items-center justify-center gap-2 border border-[#d9d9d9] rounded text-sm text-[rgba(0,0,0,0.65)] hover:border-[#1890ff] hover:text-[#1890ff] disabled:opacity-50"
        >
          <Link2 className="w-4 h-4" />
          {t('skillSpace.downloadSkill')}
        </button>
      </div>

      <div className="border-t border-[#f0f0f0] pt-4">
        {/* Step 1 */}
        <div className="mb-4">
          <div className="text-sm font-medium text-[rgba(0,0,0,0.85)] mb-2">{t('skillSpace.installStep1Title')}</div>
          <div className="relative group">
            <pre className="bg-[#f5f5f5] p-3 rounded text-xs text-[rgba(0,0,0,0.65)] whitespace-pre-wrap break-all leading-5">{STEP1_CMD}</pre>
            <button onClick={() => copyToClipboard(STEP1_CMD)} className="absolute top-2 right-2 p-1 text-[rgba(0,0,0,0.45)] hover:text-[#1890ff] opacity-0 group-hover:opacity-100 transition-opacity">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Step 2 - Always show */}
        <div className="mb-4">
          <div className="text-sm font-medium text-[rgba(0,0,0,0.85)] mb-2">
            {t('skillSpace.installStep2Title')}
            <a href="https://help.aliyun.com/document_detail/123181.html" target="_blank" rel="noopener noreferrer" className="text-[#1890ff] hover:underline ml-2 font-normal text-sm">
              {t('skillSpace.referenceDoc')}
            </a>
          </div>
          <div className="relative group">
            <pre className="bg-[#f5f5f5] p-3 rounded text-xs text-[rgba(0,0,0,0.65)] whitespace-pre-wrap break-all leading-5">{STEP2_CMD}</pre>
            <button onClick={() => copyToClipboard(STEP2_CMD)} className="absolute top-2 right-2 p-1 text-[rgba(0,0,0,0.45)] hover:text-[#1890ff] opacity-0 group-hover:opacity-100 transition-opacity">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Step 3 */}
        <div className="mb-4">
          <div className="text-sm font-medium text-[rgba(0,0,0,0.85)] mb-2">{t('skillSpace.installStep3Title')}</div>
          <div className="relative group">
            <pre className="bg-[#f5f5f5] p-3 rounded text-xs text-[rgba(0,0,0,0.65)] whitespace-pre-wrap break-all leading-5">{installCmd}</pre>
            <button onClick={() => copyToClipboard(installCmd)} className="absolute top-2 right-2 p-1 text-[rgba(0,0,0,0.45)] hover:text-[#1890ff] opacity-0 group-hover:opacity-100 transition-opacity">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
