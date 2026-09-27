export const DEFAULT_MILITARY_SPECIALIZED_SKILLS = 'FIREARMS MILITARY TRAINING'

const SPECIALIZED_SKILLS_NO_RE =
  /((?:Do you possess specialized skills|Do you have any specialized skills)[^\n?]*\?)\s*No\b/i

function sourceHasMilitaryService(source) {
  if (/^yes$/i.test(String(source?.servedInMilitary || '').trim())) return true
  const rows = Array.isArray(source?.militaryService) ? source.militaryService : []
  return rows.some((row) => {
    const branch = String(row?.branch || '').trim()
    const rank = String(row?.rank || '').trim()
    const from = String(row?.dateFrom || '').trim()
    const to = String(row?.dateTo || '').trim()
    return Boolean(branch || rank || from || to)
  })
}

function specializedSkillsDescriptionFromSource(source) {
  const desc = String(source?.specializedSkillsDescription || '').trim()
  if (desc && !/^(?:n\/?a|none|not applicable)$/i.test(desc)) return desc
  return DEFAULT_MILITARY_SPECIALIZED_SKILLS
}

/** Military / IDF service implies DS-160 specialized skills (firearms training). */
export function applyMilitarySpecializedSkillsToSourceData(source) {
  if (!source || typeof source !== 'object' || !sourceHasMilitaryService(source)) return source
  return {
    ...source,
    hasSpecializedSkills: 'yes',
    specializedSkillsDescription: specializedSkillsDescriptionFromSource(source),
  }
}

export function applyMilitarySpecializedSkillsToTranslatedText(text) {
  const body = String(text || '')
  if (!/Have you (?:ever )?served in the military\?\s*Yes\b/i.test(body)) return body
  if (!SPECIALIZED_SKILLS_NO_RE.test(body)) return body
  return body.replace(
    SPECIALIZED_SKILLS_NO_RE,
    `$1 Yes\nFull Description: ${DEFAULT_MILITARY_SPECIALIZED_SKILLS}`,
  )
}

function answerSheetHasMilitaryService(sheet) {
  const extra = sheet?.work_additional
  if (!extra || typeof extra !== 'object') return false
  if (extra.military_service === true) return true
  return Array.isArray(extra.military_service_details) && extra.military_service_details.length > 0
}

export function applyMilitarySpecializedSkillsToAnswerSheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || !answerSheetHasMilitaryService(sheet)) return sheet
  const extra = sheet.work_additional && typeof sheet.work_additional === 'object'
    ? sheet.work_additional
    : {}
  const desc = String(extra.specialized_skills_explanation || '').trim()
  return {
    ...sheet,
    work_additional: {
      ...extra,
      specialized_skills_or_training: true,
      specialized_skills_explanation: desc || DEFAULT_MILITARY_SPECIALIZED_SKILLS,
    },
  }
}
