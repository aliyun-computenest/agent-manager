// agent-manager/server/schemas/skill-hub.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

// --- SkillHub Config ---

export const SkillHubConfigResponseSchema = z.object({
  success: z.literal(true),
  configured: z.boolean().describe('SkillHub 是否已初始化'),
  hubConfig: z.object({
    ossBucketName: z.string().describe('OSS Bucket 名称'),
    ossRegionId: z.string().describe('OSS Region'),
  }).nullable().describe('SkillHub 配置（未配置时为 null）'),
}).openapi('SkillHubConfigResponse', { description: '获取 SkillHub 配置响应' })

// --- Skill Spaces ---

export const SkillSpaceItemSchema = z.object({
  skillSpaceId: z.string(),
  skillSpaceName: z.string(),
  skillSpaceDescription: z.string(),
  createTime: z.string(),
  updateTime: z.string(),
}).openapi('SkillSpaceItem', { description: '技能空间条目' })

export const ListSkillSpacesResponseSchema = z.object({
  success: z.literal(true),
  skillSpaces: z.array(SkillSpaceItemSchema),
  nextToken: z.string().nullable().optional(),
  totalCount: z.number().int().optional(),
}).openapi('ListSkillSpacesResponse', { description: '列出技能空间响应' })

export const CreateSkillSpaceRequestSchema = z.object({
  skillSpaceName: z.string().describe('技能空间名称'),
  skillSpaceDescription: z.string().describe('描述'),
}).openapi('CreateSkillSpaceRequest', { description: '创建技能空间请求' })

export const CreateSkillSpaceResponseSchema = z.object({
  success: z.literal(true),
  skillSpaceId: z.string(),
}).openapi('CreateSkillSpaceResponse', { description: '创建技能空间响应' })

export const GetSkillSpaceResponseSchema = z.object({
  success: z.literal(true),
  skillSpace: SkillSpaceItemSchema,
}).openapi('GetSkillSpaceResponse', { description: '获取技能空间详情响应' })

// --- Skills ---

export const SkillItemSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  skillDisplayName: z.string().optional(),
  skillDescription: z.string(),
  skillSpaceId: z.string(),
  skillLabels: z.array(z.string()).optional(),
  downloadUrl: z.string().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
}).openapi('SkillItem', { description: '技能条目' })

export const ListSkillsResponseSchema = z.object({
  success: z.literal(true),
  skills: z.array(SkillItemSchema),
  nextToken: z.string().nullable().optional(),
  totalCount: z.number().int().optional(),
}).openapi('ListSkillsResponse', { description: '列出技能响应' })

export const CreateSkillRequestSchema = z.object({
  sourceType: z.enum(['UPLOAD', 'COPY']).describe('来源类型'),
  skillName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/).describe('Skill 标识符（字母数字开头，可含字母、数字、下划线、点、连字符，1-64字符）'),
  skillDisplayName: z.string().max(64).describe('Skill 展示名称（必填，最多64字符，中文按2字符计算）'),
  skillDescription: z.string().describe('描述'),
  ossUrl: z.string().optional().describe('OSS 文件地址（sourceType=UPLOAD 时必填）'),
  sourceSkillId: z.string().optional().describe('源技能 ID（sourceType=COPY 时必填）'),
  skillLabels: z.array(z.string()).max(10).optional().describe('标签列表'),
}).openapi('CreateSkillRequest', { description: '创建技能请求' })

export const CreateSkillResponseSchema = z.object({
  success: z.literal(true),
  skillId: z.string(),
}).openapi('CreateSkillResponse', { description: '创建技能响应' })

export const GetSkillResponseSchema = z.object({
  success: z.literal(true),
  skill: SkillItemSchema,
}).openapi('GetSkillResponse', { description: '获取技能详情响应' })

export const UpdateSkillRequestSchema = z.object({
  skillName: z.string().optional().describe('技能名称'),
  skillDisplayName: z.string().max(64).optional().describe('Skill 展示名称'),
  skillDescription: z.string().optional().describe('描述'),
  sourceType: z.enum(['OSS', 'COPY']).optional().describe('来源类型（仅更新文件时必传）'),
  ossUrl: z.string().optional().describe('OSS 文件地址'),
  sourceSkillId: z.string().optional().describe('源技能 ID'),
  skillLabels: z.array(z.string()).max(10).optional().describe('标签列表'),
}).openapi('UpdateSkillRequest', { description: '更新技能请求' })

export const UpdateSkillResponseSchema = z.object({
  success: z.literal(true),
  skillId: z.string(),
}).openapi('UpdateSkillResponse', { description: '更新技能响应' })

// --- Skill Files ---

export const SkillFileItemSchema = z.object({
  filePath: z.string(),
  signedUrl: z.string(),
}).openapi('SkillFileItem', { description: '技能文件条目' })

export const ListSkillFilesResponseSchema = z.object({
  success: z.literal(true),
  skillFiles: z.array(SkillFileItemSchema),
  nextToken: z.string().nullable().optional(),
  totalCount: z.number().int().optional(),
}).openapi('ListSkillFilesResponse', { description: '获取技能文件列表响应' })

// --- Official Skills ---

export const ListOfficialSkillsResponseSchema = z.object({
  success: z.literal(true),
  skills: z.array(SkillItemSchema),
  nextToken: z.string().nullable().optional(),
  totalCount: z.number().int().optional(),
}).openapi('ListOfficialSkillsResponse', { description: '列出官方技能响应' })

// --- Install Skills ---

export const InstallSkillItemSchema = z.object({
  skillId: z.string().trim().min(1),
  skillSpaceId: z.string().trim().min(1).optional(),
}).strict()

export const InstallSkillsRequestSchema = z.object({
  skills: z.array(InstallSkillItemSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  const keys = value.skills.map(skill => `${skill.skillSpaceId || 'official'}:${skill.skillId}`)
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skills'], message: 'Duplicate skills are not allowed' })
  }

  const sources = new Set(value.skills.map(skill => skill.skillSpaceId || 'official'))
  if (sources.size > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['skills'],
      message: 'One request must contain official skills or skills from one Skill Space',
    })
  }
}).openapi('InstallSkillsRequest', { description: '安装一个或多个 Skill 到指定实例' })

export const InstallSkillResultSchema = z.object({
  skillId: z.string(),
  status: z.enum(['succeeded', 'failed']),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
})

export const InstallSkillsResponseSchema = z.object({
  success: z.literal(true),
  results: z.array(InstallSkillResultSchema),
}).openapi('InstallSkillsResponse', { description: '本次 Skill 安装结果' })

// --- File Detect ---

export const CreateSkillFileDetectRequestSchema = z.object({
  ossUrl: z.string().describe('待检测文件的 OSS URL'),
}).openapi('CreateSkillFileDetectRequest', { description: '提交文件安全检测请求' })

export const CreateSkillFileDetectResponseSchema = z.object({
  success: z.literal(true),
  hashKey: z.string(),
}).openapi('CreateSkillFileDetectResponse', { description: '提交文件安全检测响应' })

export const GetSkillFileDetectResultResponseSchema = z.object({
  success: z.literal(true),
  hashKey: z.string(),
  result: z.number().int().describe('0=安全 1=可疑 2=检测失败 3=检测中'),
  score: z.number().int(),
  message: z.string(),
}).openapi('GetSkillFileDetectResultResponse', { description: '查询文件检测结果响应' })
