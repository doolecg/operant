import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { BrowserPopoutPage } from './components/browser/BrowserPopout'
import { TooltipProvider } from './components/ui/tooltip'
import { call } from './lib/queries'
import './index.css'
import { ThemeApplier, applyStoredTheme } from './lib/theme'

applyStoredTheme()

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
})

// A browser pop-out window loads this page with ?browserPopout=<crewId> and shows only that project's browser.
const popoutCrew = Number(new URLSearchParams(location.search).get('browserPopout'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeApplier />
      {popoutCrew ? (
        <TooltipProvider>
          <BrowserPopoutPage crewId={popoutCrew} onPopIn={() => void call('browser:popIn', popoutCrew)} />
        </TooltipProvider>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </StrictMode>,
)
