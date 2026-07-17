import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/core'
// Register common languages (control bundle size)
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import 'highlight.js/styles/github.css'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)

const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', xml: 'xml', svg: 'xml',
}

const MAX_FILE_SIZE = 500 * 1024 // 500KB

interface CodeViewerProps {
  code: string
  fileName: string
}

export default function CodeViewer({ code, fileName }: CodeViewerProps) {
  const { t } = useTranslation('admin')
  const codeRef = useRef<HTMLElement>(null)

  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const language = LANGUAGE_MAP[ext]

  useEffect(() => {
    if (codeRef.current && code.length <= MAX_FILE_SIZE) {
      // Reset and re-highlight
      codeRef.current.removeAttribute('data-highlighted')
      hljs.highlightElement(codeRef.current)
    }
  }, [code, fileName])

  if (code.length > MAX_FILE_SIZE) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[rgba(0,0,0,0.45)]">
        {t('skillSpace.fileTooLarge')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-[#fafafa]">
      <pre className="p-4 m-0 text-[13px] leading-[1.6]">
        <code ref={codeRef} className={language ? `language-${language}` : ''}>
          {code}
        </code>
      </pre>
    </div>
  )
}
