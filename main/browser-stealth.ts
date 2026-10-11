import type { App, Session, WebPreferences } from 'electron'
import { allowInsecureContentFor } from './browser-session'

// Checked in a scratch Electron 44 run: with --remote-debugging-port (which the app always sets, for the AI browser
// endpoint) navigator.webdriver is true in every WebContentsView, with or without a Playwright CDP client attached,
// on every navigation. Turning off Blink's AutomationControlled feature makes it false for real (no JS patch for a
// page to detect). userAgentData brands were already plain (Chromium), and the session user agent is cleaned in
// browser-session.ts.
//
// Call once at the top of main/index.ts, next to the remote-debugging-port switch and before app 'ready'.
export function hideAutomationFlag(app: Pick<App, 'commandLine'>): void {
  const key = 'disable-blink-features'
  const have = app.commandLine.getSwitchValue(key)
  const features = new Set(have.split(',').map((s) => s.trim()).filter(Boolean))
  features.add('AutomationControlled')
  app.commandLine.appendSwitch(key, [...features].join(','))
}

// webPreferences for a new browser tab. Mixed content (http subresources on an https page) is only let through for
// local dev hosts; it is fixed when the view is created, so it follows the URL the tab is created with.
export function tabWebPreferences(session: Session, url: string): WebPreferences {
  return { session, sandbox: true, contextIsolation: true, nodeIntegration: false, allowRunningInsecureContent: allowInsecureContentFor(url) }
}
