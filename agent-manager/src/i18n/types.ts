import 'react-i18next'

import zhCNCommon from '../locales/zh-CN/common.json'
import zhCNAuth from '../locales/zh-CN/auth.json'
import zhCNAdmin from '../locales/zh-CN/admin.json'
import zhCNUser from '../locales/zh-CN/user.json'
import zhCNLanding from '../locales/zh-CN/landing.json'

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    ns: ['common', 'auth', 'admin', 'user', 'landing']
    resources: {
      common: typeof zhCNCommon
      auth: typeof zhCNAuth
      admin: typeof zhCNAdmin
      user: typeof zhCNUser
      landing: typeof zhCNLanding
    }
  }
}
