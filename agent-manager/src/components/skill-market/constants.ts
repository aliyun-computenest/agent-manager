/**
 * Skill Market constants — aligned with ComputeNest SkillMarket/constants.ts
 */

/** Max results per API page request — aligned with ComputeNest MAX_RESULTS = 30 */
export const MAX_RESULTS = 30

/** Scroll container offset for InfiniteScroll height calculation */
export const SCROLL_CONTAINER_OFFSET = 275

/** InfiniteScroll threshold to trigger load more */
export const SCROLL_THRESHOLD = 0.8

/** Skill avatar size in px */
export const SKILL_AVATAR_SIZE = 48

/** Config init wait time in ms (ComputeNest waits 5s for async backend init) */
export const CONFIG_INIT_WAIT_MS = 5000

/**
 * Skill tag category codes — same as ComputeNest SKILL_TAG_CODES
 */
export const SKILL_TAG_CODES = {
  SKILL_MANAGEMENT: 'category:skill-management',
  DEVELOPER_TOOLS: 'category:developer-tools',
  MARKETING_SEO: 'category:marketing-seo',
  FRONTEND_DEVELOPMENT: 'category:frontend-development',
  AI_MEDIA: 'category:ai-media',
  CODE_QUALITY_TESTING: 'category:code-quality-testing',
  MOBILE_DEVELOPMENT: 'category:mobile-development',
  CLOUD_DEVOPS: 'category:cloud-devops',
  OTHER: 'category:other',
} as const

/**
 * Skill tag i18n keys — maps tag code to i18n key
 */
export const SKILL_TAG_I18N_KEYS: Record<string, string> = {
  // Full form: "category:xxx" (ComputeNest format)
  [SKILL_TAG_CODES.SKILL_MANAGEMENT]: 'skillSpace.category.skillManagement',
  [SKILL_TAG_CODES.DEVELOPER_TOOLS]: 'skillSpace.category.developerTools',
  [SKILL_TAG_CODES.MARKETING_SEO]: 'skillSpace.category.marketingSeo',
  [SKILL_TAG_CODES.FRONTEND_DEVELOPMENT]: 'skillSpace.category.frontendDevelopment',
  [SKILL_TAG_CODES.AI_MEDIA]: 'skillSpace.category.aiMedia',
  [SKILL_TAG_CODES.CODE_QUALITY_TESTING]: 'skillSpace.category.codeQualityTesting',
  [SKILL_TAG_CODES.MOBILE_DEVELOPMENT]: 'skillSpace.category.mobileDevelopment',
  [SKILL_TAG_CODES.CLOUD_DEVOPS]: 'skillSpace.category.cloudDevops',
  [SKILL_TAG_CODES.OTHER]: 'skillSpace.category.other',
  // Short form: "xxx" (without "category:" prefix, also returned by API)
  'skill-management': 'skillSpace.category.skillManagement',
  'developer-tools': 'skillSpace.category.developerTools',
  'marketing-seo': 'skillSpace.category.marketingSeo',
  'frontend-development': 'skillSpace.category.frontendDevelopment',
  'ai-media': 'skillSpace.category.aiMedia',
  'code-quality-testing': 'skillSpace.category.codeQualityTesting',
  'mobile-development': 'skillSpace.category.mobileDevelopment',
  'cloud-devops': 'skillSpace.category.cloudDevops',
  'other': 'skillSpace.category.other',
}

export type SkillTagCode = typeof SKILL_TAG_CODES[keyof typeof SKILL_TAG_CODES]

export type TabId = 'official' | 'custom' | 'settings'
