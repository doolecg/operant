import { createContext, useContext } from 'react'

// Opens another settings page by its section id, from inside the settings page (a link in a preset, for one).
export const SettingsNavContext = createContext<(section: string) => void>(() => {})

export const useOpenSettingsSection = () => useContext(SettingsNavContext)
