import type { DesignOption, DesignQuestion } from '../types'

import { lookFor } from './styles'

const ABOUT_DESIGN = /\b(design|designs|style|styles|theme|themes|aesthetic|visual style|look and feel|colou?r scheme|layout)\b/i

// The design questions among an AskUserQuestion call's `questions` input.
// A question counts when its text names a design word, or when two or more
// of its options are known design styles.
export function designQuestions(input: unknown): DesignQuestion[] {
  if (!Array.isArray(input)) return []

  return input.flatMap(raw => {
    const question = toQuestion(raw)

    return question !== undefined && isDesign(question) ? [question] : []
  })
}

function toQuestion(raw: unknown): DesignQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { question, header, options } = raw as Record<string, unknown>
  if (typeof question !== 'string' || !Array.isArray(options)) return undefined

  const parsed = options.flatMap((option): DesignOption[] => {
    if (typeof option !== 'object' || option === null) return []
    const { label, description } = option as Record<string, unknown>
    if (typeof label !== 'string' || label.trim() === '') return []

    return [{ label: label.trim(), description: typeof description === 'string' ? description : undefined }]
  })

  if (parsed.length < 2) return undefined

  return { question, header: typeof header === 'string' ? header : '', options: parsed }
}

function isDesign(question: DesignQuestion): boolean {
  if (ABOUT_DESIGN.test(`${question.header} ${question.question}`)) return true

  return question.options.filter(option => lookFor(option.label) !== undefined).length >= 2
}
