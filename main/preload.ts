import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CORE_CHANNELS, MAIN_CHANNELS, type OperantBridge } from '../shared/ipc'

const allowed = new Set<string>([...CORE_CHANNELS, ...MAIN_CHANNELS])

const bridge: OperantBridge = {
  invoke: (channel, ...args) => {
    if (!allowed.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (name, listener) => {
    const wrapped = (_e: IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(`push:${name}`, wrapped)
    return () => ipcRenderer.removeListener(`push:${name}`, wrapped)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('operant', bridge)
