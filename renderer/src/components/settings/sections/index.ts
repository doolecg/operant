import type { ComponentType } from "react";
import { AppearanceSection } from "./AppearanceSection";
import { BudgetsSection } from "./BudgetsSection";
import { CollaborationSection } from "./CollaborationSection";
import { DiscordSection } from "./DiscordSection";
import { GeneralSection } from "./GeneralSection";
import { HindsightSection } from "./HindsightSection";
import { ImportExportSection } from "./ImportExportSection";
import { LearningSection } from "./LearningSection";
import { McpSection } from "./McpSection";
import { PresetsSection } from "./PresetsSection";
import { ProjectsSection } from "./ProjectsSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { TeamsSection } from "./TeamsSection";
import { TokensSection } from "./TokensSection";
import { TopBarSection } from "./TopBarSection";

// The settings sub-navigation renders from this list.
export const SETTINGS_SECTIONS: Array<{
  id: string;
  label: string;
  component: ComponentType;
}> = [
  { id: "general", label: "General", component: GeneralSection },
  { id: "appearance", label: "Appearance", component: AppearanceSection },
  {
    id: "collaboration",
    label: "Collaboration",
    component: CollaborationSection,
  },
  { id: "projects", label: "Projects", component: ProjectsSection },
  { id: "topbar", label: "Top bar", component: TopBarSection },
  { id: "tokens", label: "Tokens", component: TokensSection },
  { id: "budgets", label: "Budgets", component: BudgetsSection },
  { id: "presets", label: "Presets", component: PresetsSection },
  { id: "teams", label: "Teams", component: TeamsSection },
  { id: "learning", label: "Learning", component: LearningSection },
  { id: "hindsight", label: "Hindsight", component: HindsightSection },
  { id: "mcp", label: "MCP servers", component: McpSection },
  { id: "discord", label: "Discord", component: DiscordSection },
  { id: "import", label: "Import and export", component: ImportExportSection },
  { id: "shortcuts", label: "Shortcuts", component: ShortcutsSection },
];
