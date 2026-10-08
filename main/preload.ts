import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from 'electron'
import { CORE_CHANNELS, MAIN_CHANNELS, decodeIpcError, encodeIpcError, type OperantBridge } from '../shared/ipc'

const allowed = new Set<string>([...CORE_CHANNELS, ...MAIN_CHANNELS])

const bridge: OperantBridge = {
  invoke: (channel, ...args) => {
    if (!allowed.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
      const { code, message } = decodeIpcError(err)
      throw new Error(encodeIpcError(code, message))
    })
  },
  on: (name, listener) => {
    const wrapped = (_e: IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(`push:${name}`, wrapped)
    return () => ipcRenderer.removeListener(`push:${name}`, wrapped)
  },
  platform: process.platform,
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  filePath: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('operant', bridge)
