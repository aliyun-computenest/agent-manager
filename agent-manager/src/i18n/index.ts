import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import zhCNCommon from '../locales/zh-CN/common.json'
import zhCNAuth from '../locales/zh-CN/auth.json'
import zhCNAdmin from '../locales/zh-CN/admin.json'
import zhCNUser from '../locales/zh-CN/user.json'
import zhCNLanding from '../locales/zh-CN/landing.json'

import enCommon from '../locales/en/common.json'
import enAuth from '../locales/en/auth.json'
import enAdmin from '../locales/en/admin.json'
import enUser from '../locales/en/user.json'
import enLanding from '../locales/en/landing.json'

const resources = {
  'zh-CN': {
    common: zhCNCommon,
    auth: zhCNAuth,
    admin: zhCNAdmin,
    user: zhCNUser,
    landing: zhCNLanding,
  },
  en: {
    common: enCommon,
    auth: enAuth,
    admin: enAdmin,
    user: enUser,
    landing: enLanding,
  },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    ns: ['common', 'auth', 'admin', 'user', 'landing'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
  })

export default i18n
