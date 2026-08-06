const GENERIC_BROWSER_TEXT_PATTERNS = [
  /\blog[\s_-]*in\b/i,
  /\bsign[\s_-]*in\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bloading\b/i,
  /\bspinner\b/i,
  /\bskeleton\b/i,
  /\bplaceholder\b/i,
  /\bblank\s*(?:page|screen|state)?\b/i,
  /\blanding\b/i,
  /\bhome\s*page\b/i,
  /\bhomepage\b/i,
  /登录|登陆|未登录|认证|鉴权|首页|空页面|空白页|加载中|正在加载|加载…|加载\.\.\.|骨架屏|占位|暂无数据|无内容/,
]

const GENERIC_BROWSER_PATH_PATTERNS = [
  /^\/?$/,
  /^\/(?:login|signin|sign-in|auth|unauthorized)(?:\/|$)/i,
  /\/(?:login|signin|sign-in|auth|unauthorized)(?:\/|$)/i,
]

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function toText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(' ')
  if (value && typeof value === 'object') {
    return Object.values(value).map(toText).filter(Boolean).join(' ')
  }
  return ''
}

function fieldText(item) {
  if (!item || typeof item !== 'object') return ''
  return [
    item.kind,
    item.title,
    item.target,
    item.targetPath,
    item.targetUrl,
    item.url,
    item.path,
    item.pageTitle,
    item.description,
    item.summary,
    item.assertion,
    item.assertions,
    item.verifiedBehaviors,
    item.domText,
    item.screenshotText,
  ]
    .map(toText)
    .filter(Boolean)
    .join(' ')
}

function contentDescriptorText(item) {
  if (!item || typeof item !== 'object') return ''
  return [
    item.title,
    item.pageTitle,
    item.description,
    item.summary,
    item.assertion,
    item.assertions,
    item.verifiedBehaviors,
    item.domText,
    item.screenshotText,
  ]
    .map(toText)
    .filter(Boolean)
    .join(' ')
}

function pathFromUrl(value) {
  if (!hasText(value)) return ''
  try {
    return new URL(value).pathname || '/'
  } catch {
    return String(value)
  }
}

function hasGenericBrowserText(value) {
  const text = String(value || '')
  return GENERIC_BROWSER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function hasGenericBrowserPath(value) {
  const path = pathFromUrl(value).trim()
  if (!path) return false
  return GENERIC_BROWSER_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

export function isGenericBrowserEvidence(item) {
  if (!item || typeof item !== 'object') return false
  const text = fieldText(item)
  return hasGenericBrowserText(text)
    || hasGenericBrowserPath(item.targetUrl)
    || hasGenericBrowserPath(item.url)
    || hasGenericBrowserPath(item.path)
}

export function isScreenshotLikeEvidence(item) {
  if (!item || typeof item !== 'object') return false
  const kind = String(item.kind || item.type || '').toLowerCase()
  const url = String(item.url || item.path || '')
  return kind.includes('screenshot') || /\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(url)
}

export function hasFeatureContentDescriptor(item) {
  const text = contentDescriptorText(item).trim()
  return text.length >= 8 && !hasGenericBrowserText(text)
}

export function isGenericExperienceUrl(value) {
  return hasGenericBrowserPath(value) || hasGenericBrowserText(pathFromUrl(value))
}

export function featureAssertionsFor(value) {
  const assertions = []
  const sources = [
    value?.featureAssertions,
    value?.assertions,
    value?.verifiedBehaviors,
    value?.coverageAssertions,
    value?.evidenceAssertions,
  ]

  for (const source of sources) {
    if (Array.isArray(source)) assertions.push(...source)
    else if (hasText(source)) assertions.push(source)
  }

  for (const item of [...(value?.screenshots || []), ...(value?.artifacts || [])]) {
    if (Array.isArray(item?.assertions)) assertions.push(...item.assertions)
    else if (hasText(item?.assertion)) assertions.push(item.assertion)
    else if (Array.isArray(item?.verifiedBehaviors)) assertions.push(...item.verifiedBehaviors)
  }

  return assertions
    .map(toText)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function hasFeatureSpecificAssertions(value) {
  const assertions = featureAssertionsFor(value)
  return assertions.some((item) => !hasGenericBrowserText(item) && item.length >= 8)
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function assertionResultsFor(value) {
  if (!Array.isArray(value?.assertionResults)) return []
  return value.assertionResults.filter((item) => item && typeof item === 'object')
}

function assertionIdsForEvidence(item) {
  return stringList(item?.assertionIds)
}

function includesText(haystack, needle) {
  return String(haystack || '').toLocaleLowerCase().includes(String(needle || '').toLocaleLowerCase())
}

function validatePostActionContract({ value, result, screenshot, contract, assertionId, path, push, errors }) {
  if (!contract || typeof contract !== 'object') {
    push(errors, `${path}.manifest`, 'requiresPostActionReadback needs a postActionReadback contract')
    return
  }

  if (!hasText(contract.targetPathPattern)) {
    push(errors, `${path}.manifest.postActionReadback.targetPathPattern`, 'must be present')
    return
  }
  const resultMatchFields = stringList(contract.resultMatchFields)
  if (resultMatchFields.length === 0) {
    push(errors, `${path}.manifest.postActionReadback.resultMatchFields`, 'must contain at least one field')
    return
  }

  let targetPattern
  try {
    targetPattern = new RegExp(String(contract.targetPathPattern || ''))
  } catch {
    push(errors, `${path}.manifest.postActionReadback.targetPathPattern`, 'must be a valid regular expression')
    return
  }
  const targetPath = pathFromUrl(screenshot.targetUrl)
  if (!targetPattern.test(targetPath)) {
    push(
      errors,
      `${path}.evidence.${assertionId}.targetUrl`,
      `pathname ${targetPath || '(missing)'} must match post-action target pattern ${contract.targetPathPattern}`,
    )
  }

  for (const field of resultMatchFields) {
    const expected = result?.[field]
    if (!hasText(String(expected ?? ''))) {
      push(errors, `${path}.assertionResults.${assertionId}.${field}`, 'must be present for post-action correlation')
      continue
    }
    if (String(screenshot?.[field] ?? '') !== String(expected)) {
      push(errors, `${path}.evidence.${assertionId}.${field}`, 'must match the assertion result')
    }
  }

  const evidenceText = contentDescriptorText(screenshot)
  for (const field of stringList(contract.evidenceTextFields)) {
    const expected = result?.[field]
    if (!hasText(String(expected ?? ''))) {
      push(errors, `${path}.assertionResults.${assertionId}.${field}`, 'must be present for visible-content correlation')
    } else if (!includesText(evidenceText, expected)) {
      push(errors, `${path}.evidence.${assertionId}`, `visible evidence text must include ${field}=${expected}`)
    }
  }
  for (const requiredText of stringList(contract.requiredEvidenceText)) {
    if (!includesText(evidenceText, requiredText)) {
      push(errors, `${path}.evidence.${assertionId}`, `visible evidence text must include ${requiredText}`)
    }
  }

  const actionMatchFields = stringList(contract.actionResultMatchFields)
  if (actionMatchFields.length > 0) {
    const allowedStatuses = stringList(contract.actionResultStatuses).map((item) => item.toLocaleLowerCase())
    if (allowedStatuses.length === 0) {
      push(
        errors,
        `${path}.manifest.postActionReadback.actionResultStatuses`,
        'must contain at least one successful status when actionResultMatchFields is configured',
      )
      return
    }
    const actionResults = Array.isArray(value?.actionResults) ? value.actionResults : []
    const actionResult = actionResults.find((item) => (
      item
      && typeof item === 'object'
      && actionMatchFields.every((field) => String(item[field] ?? '') === String(result?.[field] ?? ''))
      && allowedStatuses.includes(String(item.status || '').toLocaleLowerCase())
    ))
    if (!actionResult) {
      push(
        errors,
        `${path}.actionResults`,
        `must include a successful action result correlated by ${actionMatchFields.join(', ')} for ${assertionId}`,
      )
    }
  }
}

export function validateRequiredE2eEvidence({
  value,
  items,
  requirements = {},
  path,
  push,
  errors,
}) {
  const requiredAssertions = stringList(requirements.requiredAssertions)
  const requiresPostActionReadback = requirements.requiresPostActionReadback === true
  if (requiredAssertions.length === 0 && !requiresPostActionReadback) return
  if (requiresPostActionReadback && requiredAssertions.length === 0) {
    push(errors, `${path}.manifest.requiredAssertions`, 'requiresPostActionReadback needs at least one required assertion')
    return
  }

  const assertionResults = assertionResultsFor(value)
  for (const assertionId of requiredAssertions) {
    const result = assertionResults.find((item) => String(item.id || '').trim() === assertionId)
    if (!result) {
      push(errors, `${path}.assertionResults`, `must include required assertion ${assertionId}`)
      continue
    }
    if (result.passed !== true) {
      push(errors, `${path}.assertionResults.${assertionId}.passed`, 'must be true')
    }

    const linkedScreenshots = items.filter((item) => (
      isScreenshotLikeEvidence(item) && assertionIdsForEvidence(item).includes(assertionId)
    ))
    if (linkedScreenshots.length === 0) {
      push(errors, `${path}.evidence`, `required assertion ${assertionId} must be linked from screenshot assertionIds`)
      continue
    }

    const linkedScreenshot = requiresPostActionReadback
      ? linkedScreenshots.find((item) => item?.phase === 'post_action_readback')
      : linkedScreenshots[0]
    if (!linkedScreenshot) {
      push(errors, `${path}.evidence`, `required assertion ${assertionId} must be linked from a post_action_readback screenshot`)
      continue
    }
    if (requiresPostActionReadback) {
      if (!hasText(linkedScreenshot.targetUrl) || !hasFeatureContentDescriptor(linkedScreenshot)) {
        push(errors, `${path}.evidence`, `required assertion ${assertionId} needs targetUrl and visible feature content in its post_action_readback screenshot`)
      }
      validatePostActionContract({
        value,
        result,
        screenshot: linkedScreenshot,
        contract: requirements.postActionReadback,
        assertionId,
        path,
        push,
        errors,
      })
    }
  }

  if (!requiresPostActionReadback) return
  const postActionScreenshots = items.filter((item) => (
    isScreenshotLikeEvidence(item) && item?.phase === 'post_action_readback'
  ))
  if (postActionScreenshots.length === 0) {
    push(errors, `${path}.screenshots`, 'must include a post_action_readback screenshot of the target system after the write/action completes')
    return
  }

  const completeReadback = postActionScreenshots.find((item) => (
    hasText(item.targetUrl)
    && hasFeatureContentDescriptor(item)
    && assertionIdsForEvidence(item).length > 0
    && requiredAssertions.some((id) => assertionIdsForEvidence(item).includes(id))
  ))
  if (!completeReadback) {
    push(
      errors,
      `${path}.screenshots`,
      'post_action_readback screenshot must include targetUrl, feature-specific domText/description, and assertionIds linked to a required assertion',
    )
  }
}

export function validateFeatureRelevantBrowserEvidence({ value, items, experienceUrl, path, push, errors }) {
  if (!hasFeatureSpecificAssertions(value)) {
    push(errors, `${path}.featureAssertions`, 'must list feature-specific UI/API assertions; page load, login, or generic homepage checks are not enough')
  }

  if (hasText(experienceUrl) && isGenericExperienceUrl(experienceUrl)) {
    push(errors, `${path}.experienceUrl`, 'must open the tested feature page, not a login, auth, homepage, or generic landing page')
  }

  for (const [index, item] of items.entries()) {
    if (isGenericBrowserEvidence(item)) {
      push(errors, `${path}.evidence[${index}]`, 'must show the tested feature state; login/auth/homepage/loading/blank screenshots are not valid completion evidence')
    }
    if (isScreenshotLikeEvidence(item) && !hasFeatureContentDescriptor(item)) {
      push(errors, `${path}.evidence[${index}]`, 'screenshot evidence must include feature-specific domText, screenshotText, pageTitle, description, or assertions; image URL alone is not enough')
    }
  }
}
