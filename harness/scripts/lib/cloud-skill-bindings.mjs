export function declaredSkillSlugs(config) {
  const values = [
    ...(config.commonSkills || []),
    ...Object.values(config.stages || {}).flat(),
  ]
  return [...new Set(values)]
}

export function validateStageSkillConfig(config, stageIds) {
  const errors = []
  if (config?.schemaVersion !== '1.0') {
    errors.push('stage skill config schemaVersion must be 1.0')
  }
  if (!Array.isArray(config?.commonSkills) || config.commonSkills.length === 0) {
    errors.push('stage skill config commonSkills must be a non-empty array')
  }
  if (!config?.stages || typeof config.stages !== 'object' || Array.isArray(config.stages)) {
    errors.push('stage skill config stages must be an object')
    return errors
  }

  const knownStages = new Set(stageIds)
  for (const stageId of stageIds) {
    const stageSkills = config.stages[stageId]
    if (!Array.isArray(stageSkills) || stageSkills.length === 0) {
      errors.push(`stage ${stageId} must declare at least one stage-specific cloud skill`)
    }
  }
  for (const stageId of Object.keys(config.stages)) {
    if (!knownStages.has(stageId)) errors.push(`stage skill config references unknown stage ${stageId}`)
  }

  for (const [scope, slugs] of [
    ['commonSkills', config.commonSkills || []],
    ...Object.entries(config.stages),
  ]) {
    const seen = new Set()
    for (const slug of slugs || []) {
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        errors.push(`${scope} contains invalid skill slug ${String(slug)}`)
      } else if (seen.has(slug)) {
        errors.push(`${scope} contains duplicate skill slug ${slug}`)
      }
      seen.add(slug)
    }
  }
  return errors
}

export function normalizeSkillCatalog(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.skills)
      ? payload.skills
      : payload?.skill
        ? [payload]
        : []
  return items.map((item) => {
    const skill = item?.skill || item
    return {
      id: skill?.id,
      slug: skill?.slug || skill?.name,
      currentVersion: skill?.currentVersion || skill?.version,
      attachedApps: item?.attachedApps ?? skill?.attachedApps,
      digest: skill?.contentDigest || skill?.digest,
    }
  })
}

export function resolveStageSkillBindings(config, stageIds, catalogPayload) {
  const configErrors = validateStageSkillConfig(config, stageIds)
  if (configErrors.length > 0) throw new Error(configErrors.join('\n'))

  const catalog = normalizeSkillCatalog(catalogPayload)
  const bySlug = new Map()
  for (const entry of catalog) {
    if (!entry.slug) continue
    if (bySlug.has(entry.slug)) throw new Error(`cloud skill catalog contains duplicate slug ${entry.slug}`)
    bySlug.set(entry.slug, entry)
  }

  const missing = declaredSkillSlugs(config).filter((slug) => {
    const entry = bySlug.get(slug)
    return !entry?.id || !entry?.currentVersion
  })
  if (missing.length > 0) {
    throw new Error(`cloud skill catalog is missing published id/version for: ${missing.join(', ')}`)
  }

  return new Map(stageIds.map((stageId) => {
    const slugs = [...config.commonSkills, ...config.stages[stageId]]
    const entries = slugs.map((slug) => bySlug.get(slug))
    return [stageId, {
      slugs,
      skillIds: entries.map((entry) => entry.id),
      versions: Object.fromEntries(entries.map((entry) => [entry.slug, entry.currentVersion])),
    }]
  }))
}
