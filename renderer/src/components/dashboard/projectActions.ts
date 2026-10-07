import { decodeIpcError } from '@shared/ipc'
import type { Crew } from '@shared/types'
import { bridge } from '@/lib/bridge'
import { toast } from '@/lib/toast'

const fail = (what: string, e: unknown) => toast(`${what}: ${decodeIpcError(e).message}`, true)

// The project actions that run in main or the browser and need nothing from the page: each reports a failure as a toast.
export const projectActions = {
  openIde: (crew: Crew) => bridge().invoke('ide:open', crew.id).catch((e) => fail('Could not open the IDE', e)),
  openFolder: (crew: Crew) => bridge().invoke('shell:openFolder', crew.id).catch((e) => fail('Could not open the folder', e)),
  index: (crew: Crew) =>
    bridge()
      .invoke('index:run', crew.id)
      .then(() => undefined)
      .catch((e) => fail(`Could not index ${crew.name}`, e)),
  trackerNow: (crew: Crew) =>
    bridge()
      .invoke('crews:trackerNow', crew.id)
      .then((j) => toast(`Update tracker job #${j.id} is on the board`))
      .catch((e) => fail('Could not create the tracker job', e)),
  copyPath: (crew: Crew) =>
    navigator.clipboard.writeText(crew.folder).then(
      () => toast('Path copied'),
      () => toast('Could not copy the path', true),
    ),
}

export const folderLabel = (platform: string) => (platform === 'win32' ? 'Open in Explorer' : platform === 'darwin' ? 'Reveal in Finder' : 'Open folder')
