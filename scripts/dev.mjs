// Dev loop: build main/preload once, start the Vite renderer server, then launch Electron against it.
import { spawn } from 'node:child_process'
import { build, createServer } from 'vite'

await build({ configFile: 'vite.main.config.ts', mode: 'development' })
await build({ configFile: 'vite.main.config.ts', mode: 'preload' })
const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()
const url = server.resolvedUrls.local[0]

const electron = (await import('electron')).default
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_URL: url } })
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
