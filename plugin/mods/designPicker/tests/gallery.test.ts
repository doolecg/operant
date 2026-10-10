import { expect, test } from 'claude-code/testing'

import { renderGallery } from '../hooks/gallery'

test('known styles get their own sample and unknown options a neutral card', () => {
  const page = renderGallery([
    {
      header: 'Style',
      question: 'Which style?',
      options: [{ label: 'Glassmorphism', description: 'Frosted panels' }, { label: 'Quirky spiral' }],
    },
  ])

  expect(page).toContain('class="option look-glassmorphism"')
  expect(page).toContain('class="option look-neutral"')
  expect(page).toContain('Frosted panels')
  expect(page).toContain('<meta charset="utf-8">')
})

test('option text is escaped, never written as markup', () => {
  const page = renderGallery([
    { header: 'Style', question: 'Which?', options: [{ label: '<img src=x onerror=alert(1)>' }, { label: 'Flat' }] },
  ])

  expect(page).not.toContain('<img src=x')
  expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;')
})

test('the page makes no network requests', () => {
  const page = renderGallery([{ header: 'Style', question: 'Which?', options: [{ label: 'Flat' }, { label: 'Retro' }] }])

  expect(page).not.toMatch(/https?:\/\//)
  expect(page).not.toContain('<script')
})
