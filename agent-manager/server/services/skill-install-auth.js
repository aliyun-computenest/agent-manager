import _Sts20150401, * as $Sts20150401 from '@alicloud/sts20150401'
import * as $OpenApi from '@alicloud/openapi-client'
import { appLogger } from '../utils/logger.js'

const Sts20150401 = _Sts20150401.default || _Sts20150401

export async function assumeSkillDownloadRole({ roleArn, durationSeconds, roleSessionName }) {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || ''
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || ''
  if (!accessKeyId || !accessKeySecret || !roleArn) {
    throw new Error('SkillHub AssumeRole is not configured')
  }

  try {
    const client = new Sts20150401(new $OpenApi.Config({
      accessKeyId,
      accessKeySecret,
      endpoint: 'sts.aliyuncs.com',
    }))
    const response = await client.assumeRole(new $Sts20150401.AssumeRoleRequest({
      roleArn,
      roleSessionName,
      durationSeconds,
    }))
    const credentials = response.body?.credentials
    if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken) {
      throw new Error('SkillHub AssumeRole returned incomplete credentials')
    }
    return {
      // 仅保留在内存中，随后通过沙箱进程环境变量传递。
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      securityToken: credentials.securityToken,
    }
  } catch (error) {
    const text = `${error?.code || ''} ${error?.message || ''}`
    appLogger.warn('SkillHub AssumeRole failed', {
      code: error?.code || 'UNKNOWN',
      permissionDenied: /access.?denied|forbidden|no.?permission|unauthorized/i.test(text),
    })
    throw error
  }
}
