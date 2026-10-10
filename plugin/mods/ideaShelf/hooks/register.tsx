import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Editing } from '../types'
import { cleanIdea, ideaKey, isIdea, newId, parseEdit, shelfPrefix } from './shelf'

type Row = { id: string; text: string; at: number }

const editing = atom({ plugin: 'idea-shelf', key: 'editing' } as const, null as Editing | null)

async function listIdeas($: EngineInterface, cwd: string): Promise<Row[]> {
  const prefix = shelfPrefix(cwd)
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix))
  const rows = await Promise.all(keys.map(async key => {
    const value = await $.store.get(key)
    return isIdea(value) ? { id: key.slice(prefix.length), text: value.text, at: value.at } : null
  }))
  return rows.filter((row): row is Row => row !== null).sort((a, b) => a.at - b.at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'idea',
        description: "Park an idea on this project's shelf; /idea edit <n> <text> changes one",
        argumentHint: '<text>',
        immediate: true,
      })
      await $.command.register({
        name: 'ideas',
        description: 'Open the Idea Shelf to send, edit or delete parked ideas',
        immediate: true,
      })
    } catch {
      $.ui.toast('Idea Shelf: could not register its commands')
    }
    return next(e)
  })

  on('command.run', { command: 'idea' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const edit = parseEdit(e.args)
    if (edit !== null) {
      const text = cleanIdea(edit.text)
      const row = (await listIdeas($, cwd))[edit.n - 1]
      if (row === undefined) $.ui.toast(`No idea number ${edit.n} on this shelf`)
      else if (text === null) $.ui.toast('An idea cannot be empty')
      else {
        await $.store.set(ideaKey(cwd, row.id), { text, at: row.at })
        $.ui.toast(`Idea ${edit.n} updated`)
        $.ui.invalidate('ui.render')
      }
      return {}
    }
    const text = cleanIdea(e.args)
    if (text === null) {
      $.ui.toast('Usage: /idea <text>, or /idea edit <n> <text>')
      return {}
    }
    try {
      const at = await $.clock.now()
      await $.store.set(ideaKey(cwd, newId(at, Math.random())), { text, at })
      $.ui.toast('Idea parked on this project\'s shelf (/ideas to review)')
      $.ui.invalidate('ui.render')
    } catch {
      $.ui.toast('Idea Shelf: could not save the idea')
    }
    return {}
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await $.ui.open({ id: 'ideas', title: 'Idea Shelf', closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'ideas' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    const ideas = await listIdeas($, cwd)
    const current = await read($, editing)
    const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

    const send = async (idea: Row) => {
      try {
        await $.prompt.submit({ text: idea.text, asUser: true })
      } catch {
        $.ui.toast('Idea Shelf: could not send the idea; it stays on the shelf')
        return
      }
      await $.store.delete(ideaKey(cwd, idea.id))
      $.ui.invalidate('ui.render')
    }

    const remove = async (idea: Row) => {
      await $.store.delete(ideaKey(cwd, idea.id))
      if ((await read($, editing))?.id === idea.id) await update($, editing, () => null)
      $.ui.invalidate('ui.render')
    }

    const startEdit = async (idea: Row) => {
      await update($, editing, () => ({ id: idea.id, draft: idea.text }))
      $.ui.invalidate('ui.render')
    }

    const finishEdit = async (idea: Row, value: string | undefined) => {
      const text = cleanIdea(value ?? (await read($, editing))?.draft ?? '')
      if (text === null) {
        $.ui.toast('An idea cannot be empty; it was not saved')
        return
      }
      await $.store.set(ideaKey(cwd, idea.id), { text, at: idea.at })
      await update($, editing, () => null)
      $.ui.invalidate('ui.render')
    }

    const cancelEdit = async () => {
      await update($, editing, () => null)
      $.ui.invalidate('ui.render')
    }

    const editor = (idea: Row, index: number) => {
      if (e.surface === 'mobile') return <Text dimColor>Editing needs the terminal or desktop window.</Text>
      const { Input } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Input
            key={`draft:${idea.id}`}
            value={idea.text}
            label={`Idea ${index + 1}`}
            submitLabel="Save"
            onInput={(value: string) => { void update($, editing, state => (state ? { ...state, draft: value } : state)) }}
            onSubmit={(value: string) => finishEdit(idea, value)}
          />
          <Box>
            <Button key={`save:${idea.id}`} label="Save" variant="primary" onPress={() => finishEdit(idea, undefined)} />
            <Button key={`cancel:${idea.id}`} label="Cancel" role="dismiss" onPress={cancelEdit} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{folder}: {ideas.length} idea(s) on the shelf</Text>
        {ideas.length === 0 && <Text dimColor>{'The shelf is empty. Park an idea with /idea <text>.'}</Text>}
        {ideas.map((idea, index) => (
          <Box key={idea.id} flexDirection="column">
            {current?.id === idea.id ? editor(idea, index) : (
              <Box flexDirection="column">
                <Text>{`${index + 1}. ${idea.text}`}</Text>
                <Box>
                  <Button key={`send:${idea.id}`} label="Send" variant="primary" onPress={() => send(idea)} />
                  <Button key={`edit:${idea.id}`} label="Edit" onPress={() => startEdit(idea)} />
                  <Button key={`delete:${idea.id}`} label="Delete" onPress={() => remove(idea)} />
                </Box>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
