import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillFile, type EnhanceSkill } from '../shared/prompt-enhance'

// An installed skill with the file it lives in (SKILL.md).
export interface InstalledSkillFile extends EnhanceSkill {
  path: string
}

// The skills in <claude dir>/skills/*/SKILL.md, by name and description, then the Operant hub's own skills
// (<claude dir>/operant-hub/skills, e.g. team-work with its subagent tiers and limits).
export function installedSkills(claudeDir: string): EnhanceSkill[] {
  return [...skillsIn(join(claudeDir, 'operant-hub', 'skills')), ...skillsIn(join(claudeDir, 'skills'))].map(({ name, description }) => ({ name, description }))
}

// The skills Claude Code loads everywhere (<claude dir>/skills) and the ones of a project (<project>/.claude/skills).
export function claudeSkillFiles(claudeDir: string, folder: string | null): InstalledSkillFile[] {
  return [...skillsIn(join(claudeDir, 'skills')), ...(folder ? skillsIn(join(folder, '.claude', 'skills')) : [])]
}

function skillsIn(root: string): InstalledSkillFile[] {
  if (!existsSync(root)) return []
  const out: InstalledSkillFile[] = []
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      const path = join(root, e.name, 'SKILL.md')
      try {
        const meta = parseSkillFile(readFileSync(path, 'utf8'))
        out.push({ name: meta.name || e.name, description: meta.description ?? '', path })
      } catch {
        // no SKILL.md in this folder
      }
    }
  } catch {
    return out
  }
  return out
}
