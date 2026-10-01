import type { ComponentType } from 'react'
import { CollaborationSection } from './CollaborationSection'
import { GeneralSection } from './GeneralSection'
import { PresetsSection } from './PresetsSection'
import { ShortcutsSection } from './ShortcutsSection'
import { TokensSection } from './TokensSection'

// The settings sub-navigation renders from this list.
export const SETTINGS_SECTIONS: Array<{ id: string; label: string; component: ComponentType }> = [
  { id: 'general', label: 'General', component: GeneralSection },
  { id: 'collaboration', label: 'Collaboration', component: CollaborationSection },
  { id: 'tokens', label: 'Tokens', component: TokensSection },
  { id: 'presets', label: 'Presets', component: PresetsSection },
  { id: 'shortcuts', label: 'Shortcuts', component: ShortcutsSection },
]
