import type { ComponentType } from "react";
import type { SettingsSectionId } from "../pages";
import { AppearanceSection } from "./AppearanceSection";
import { AuxSection } from "./AuxSection";
import { BackupsSection } from "./BackupsSection";
import { BudgetsSection } from "./BudgetsSection";
import { CodegraphSection } from "./CodegraphSection";
import { GeneralSection } from "./GeneralSection";
import { HindsightSection } from "./HindsightSection";
import { ImportExportSection } from "./ImportExportSection";
import { LearningSection } from "./LearningSection";
import { McpSection } from "./McpSection";
import { MemorySection } from "./MemorySection";
import { ModsSection } from "./ModsSection";
import { PresetsSection } from "./PresetsSection";
import { ProjectsSection } from "./ProjectsSection";
import { ResetSection } from "./ResetSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { SuperpowersSection } from "./SuperpowersSection";
import { TeamsSection } from "./TeamsSection";
import { TerminalSection, TilesSection } from "./TerminalSection";
import { TerminalsSection } from "./TerminalsSection";
import { TokensSection } from "./TokensSection";
import { TopBarSection } from "./TopBarSection";

// Each settings section component, by its section id. The pages in ../pages.ts compose these.
export const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  projects: ProjectsSection,
  topbar: TopBarSection,
  terminals: TerminalsSection,
  terminal: TerminalSection,
  tiles: TilesSection,
  mods: ModsSection,
  tokens: TokensSection,
  budgets: BudgetsSection,
  presets: PresetsSection,
  teams: TeamsSection,
  learning: LearningSection,
  memory: MemorySection,
  aux: AuxSection,
  hindsight: HindsightSection,
  codegraph: CodegraphSection,
  backups: BackupsSection,
  superpowers: SuperpowersSection,
  mcp: McpSection,
  import: ImportExportSection,
  shortcuts: ShortcutsSection,
  reset: ResetSection,
};
