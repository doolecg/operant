import { join } from 'node:path'
import { app } from 'electron'
import { MediaService } from '../core/media'
import { spawnHidden } from '../core/proc'
import type { Operant } from '../core/operant'

// The media helper script ships next to the app (extraResources), never inside the asar, so PowerShell can read it.
const helperScript = () => join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'helper', 'media-helper.ps1')

// Starts and stops the helper as the "Windows media controls" setting changes.
export function createMedia(operant: Operant): MediaService {
  // The e2e run swaps in a fake helper (a Node script speaking the same lines); unpackaged runs only.
  const fake = !app.isPackaged ? process.env.OPERANT_E2E_MEDIA_HELPER : undefined
  const media = new MediaService({
    script: fake ?? helperScript(),
    ...(fake
      ? { launch: (script: string) => spawnHidden(process.execPath, [script], { source: 'media', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }) }
      : {}),
  })
  const sync = () => (operant.currentSettings.topBar.mediaControls ? media.start() : media.stop())
  sync()
  operant.on('settings', sync)
  app.on('will-quit', () => media.stop())
  return media
}
