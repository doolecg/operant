import { useState } from 'react'
import { decodeIpcError } from '@shared/ipc'
import type { McpCli, McpScope, McpServer, McpServerInput, McpTransport } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAddMcp, useUpdateMcp } from '@/lib/queries'

const SCOPES: Record<McpCli, Array<{ id: McpScope; label: string }>> = {
  claude: [
    { id: 'user', label: 'User (every project)' },
    { id: 'project', label: 'Project (.mcp.json, shared)' },
    { id: 'local', label: 'Local (this project, private)' },
  ],
  opencode: [
    { id: 'global', label: 'Global' },
    { id: 'project', label: 'Project (opencode.json)' },
  ],
}

// Splits a command line on spaces; double or single quotes keep a part together.
export function splitCommand(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

const pairs = (text: string, sep: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim()
  }
  return out
}

const lines = (m: Record<string, string>, sep: string) =>
  Object.entries(m)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')

// Adds a server or edits one. Secret values are masked: leaving *** keeps the saved value.
export function McpServerDialog({ crewId, server, onClose }: { crewId: number | null; server: McpServer | null; onClose: () => void }) {
  const add = useAddMcp(crewId)
  const update = useUpdateMcp(crewId)
  const [name, setName] = useState(server?.name ?? '')
  const [cli, setCli] = useState<McpCli>(server?.cli ?? 'claude')
  const [scope, setScope] = useState<McpScope>(server?.scope ?? SCOPES[server?.cli ?? 'claude'][0]!.id)
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio')
  const [command, setCommand] = useState(server && server.transport === 'stdio' ? server.target : '')
  const [url, setUrl] = useState(server && server.transport !== 'stdio' ? server.target : '')
  const [env, setEnv] = useState(server ? lines(server.env, '=') : '')
  const [headers, setHeaders] = useState(server ? lines(server.headers, ': ') : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const changeCli = (next: McpCli) => {
    setCli(next)
    setScope(SCOPES[next][0]!.id)
    if (next === 'opencode' && transport === 'sse') setTransport('http')
  }

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      const parts = splitCommand(command)
      const input: McpServerInput = {
        name: name.trim(),
        cli,
        scope,
        transport,
        ...(transport === 'stdio'
          ? { command: parts[0] ?? '', args: parts.slice(1), env: pairs(env, '=') }
          : { url: url.trim(), headers: pairs(headers, ':') }),
      }
      if (server) await update.mutateAsync([server.id, input])
      else await add.mutateAsync([input])
      onClose()
    } catch (e) {
      setError(decodeIpcError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${server.name}` : 'Add MCP server'}</DialogTitle>
          <DialogDescription>
            {server
              ? 'The name, CLI and scope stay as they are. Saving re-adds the server with the CLI.'
              : 'Saved with the CLI’s own command, in the scope you pick.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name" className="text-sm">
              Name
            </Label>
            <Input id="mcp-name" value={name} disabled={!!server} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="contents">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-cli" className="text-sm">
                CLI
              </Label>
              <Select value={cli} disabled={!!server} onValueChange={(v) => changeCli(v as McpCli)}>
                <SelectTrigger id="mcp-cli" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="opencode">OpenCode</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-scope" className="text-sm">
                Scope
              </Label>
              <Select value={scope} disabled={!!server} onValueChange={(v) => setScope(v as McpScope)}>
                <SelectTrigger id="mcp-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES[cli].map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-transport" className="text-sm">
              Type
            </Label>
            <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
              <SelectTrigger id="mcp-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">Local command</SelectItem>
                <SelectItem value="http">Remote (HTTP)</SelectItem>
                {cli === 'claude' && <SelectItem value="sse">Remote (SSE)</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          </div>
          {transport === 'stdio' ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-command" className="text-sm">
                  Command and arguments
                </Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx my-mcp-server --flag"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-env" className="text-sm">
                  Environment
                </Label>
                <Textarea
                  id="mcp-env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder="API_KEY=value"
                  spellCheck={false}
                  className="min-h-28 font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">One KEY=value per line. Values are hidden after saving; leave *** to keep one.</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url" className="text-sm">
                  URL
                </Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-headers" className="text-sm">
                  Headers
                </Label>
                <Textarea
                  id="mcp-headers"
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder="Authorization: Bearer value"
                  spellCheck={false}
                  className="min-h-28 font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">One Name: value per line. Values are hidden after saving; leave *** to keep one.</p>
              </div>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim()}>
            {server ? 'Save server' : 'Add server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
