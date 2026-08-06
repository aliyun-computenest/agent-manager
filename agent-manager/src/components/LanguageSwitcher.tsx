import React, { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ChevronDown } from 'lucide-react'

const languages = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
]

const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const currentLang = languages.find(l => l.code === i18n.language) || languages[0]

  const handleChange = (code: string) => {
    i18n.changeLanguage(code)
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-md text-sm text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <Globe className="w-4 h-4" />
        <span>{currentLang.label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-32 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
          {languages.map(lang => (
            <button
              key={lang.code}
              onClick={() => handleChange(lang.code)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                lang.code === i18n.language
                  ? 'text-primary-600 bg-primary-50 font-medium'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default LanguageSwitcher
