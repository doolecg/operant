import type { OperantBridge } from '@shared/ipc'

declare global {
  interface Window {
    operant: OperantBridge
  }
}

export const bridge = (): OperantBridge => window.operant
