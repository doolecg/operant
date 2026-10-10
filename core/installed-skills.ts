import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillFile, type EnhanceSkill } from '../shared/prompt-enhance'

// The skills in <claude dir>/skills/*/SKILL.md, by name and description.
export function installedSkills(claudeDir: string): EnhanceSkill[] {
  const root = join(claudeDir, 'skills')
  if (!existsSync(root)) return []
  const out: EnhanceSkill[] = []
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      try {
        const meta = parseSkillFile(readFileSync(join(root, e.name, 'SKILL.md'), 'utf8'))
        out.push({ name: meta.name || e.name, description: meta.description ?? '' })
      } catch {
        // no SKILL.md in this folder
      }
    }
  } catch {
    return out
  }
  return out
}
