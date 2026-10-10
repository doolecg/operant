import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Pencil, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { decodeIpcError } from "@shared/ipc";
import type { PresetImportItem } from "@shared/ops";
import type { ExportText, Preset } from "@shared/types";
import { STAGES, STAGE_KEYS, canEditFiles } from "@shared/presets";
import { PresetEditor } from "@/components/presets/PresetEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  call,
  keys,
  useDeletePreset,
  useDuplicatePreset,
  usePresets,
  useResetPreset,
  useRestoreBuiltinPresets,
  useSettings,
} from "@/lib/queries";
import { ConfirmDialog } from "../parts";

type Confirm = { kind: "delete" | "reset"; preset: Preset };
type Cli = "claude" | "opencode";

const CLI_LABEL: Record<Cli, string> = { claude: "Claude Code", opencode: "OpenCode" };
const AGENT_LABEL: Record<Preset["agent"], string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  shell: "Plain shell",
};

// The model class an alias names (Claude Code aliases), for a badge; null for a full id or an OpenCode model.
const modelClass = (model: string) => {
  const m = /^(?:claude-)?(haiku|sonnet|opus)(?:-[\d-]+)?$/.exec(model.trim());
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : null;
};

export const summary = (p: Preset) =>
  p.agent === "shell"
    ? "Plain shell"
    : [
        p.agent === "claude"
          ? p.model
          : `${p.agent === "opencode" ? "opencode" : "Codex"} ${p.model}`,
        p.effort && `effort ${p.effort}`,
        p.permissionMode,
        p.cacheTtl !== "auto" && `${p.cacheTtl} cache`,
        p.skills.length > 0 &&
          `${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}`,
        p.hindsight && "Hindsight",
        p.codegraph && "CodeGraph",
      ]
        .filter(Boolean)
        .join(" · ");

export function PresetsSection() {
  const presets = usePresets();
  const settings = useSettings();
  const duplicate = useDuplicatePreset();
  const remove = useDeletePreset();
  const reset = useResetPreset();
  const restore = useRestoreBuiltinPresets();
  const [editing, setEditing] = useState<Preset | "new" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cliByStage, setCliByStage] = useState<Record<string, Cli>>({});
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<{ text: string; items: PresetImportItem[] } | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const download = (f: ExportText) => {
    const url = URL.createObjectURL(new Blob([f.text], { type: f.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExport = (presetId?: number) =>
    run(async () => download(await call("presets:export", presetId)), "Exported.");

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    await run(async () => {
      const text = await file.text();
      setImporting({ text, items: await call("presets:importPreview", text) });
    });
  };

  const doImport = async () => {
    if (!importing) return;
    setImportBusy(true);
    const ok = await run(async () => {
      const items = await call("presets:import", importing.text);
      await qc.invalidateQueries({ queryKey: keys.presets });
      const added = items.filter((i) => i.action === "add").length;
      setNotice(
        `Imported ${added} preset${added === 1 ? "" : "s"}; ${items.length - added} not imported.`,
      );
    });
    setImportBusy(false);
    if (ok) setImporting(null);
  };

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(decodeIpcError(e).message);
      return false;
    }
  };

  const doDuplicate = (p: Preset) =>
    run(async () => {
      const copy = await duplicate.mutateAsync([p.id]);
      setEditing(copy);
    });

  const doConfirm = async () => {
    if (!confirm) return;
    const { kind, preset } = confirm;
    const label = preset.builtin ? `${preset.name} (${AGENT_LABEL[preset.agent]})` : preset.name;
    const ok = await run(
      () =>
        kind === "delete"
          ? remove.mutateAsync([preset.id])
          : reset.mutateAsync([preset.id]),
      kind === "delete"
        ? `Deleted ${label}.`
        : `${label} is back to its built-in values.`,
    );
    if (ok) setConfirm(null);
  };

  const list = presets.data ?? [];
  const byBuiltin = new Map(
    list.filter((p) => p.builtin).map((p) => [p.builtin!, p] as const),
  );
  const mine = list.filter((p) => p.builtin == null);
  const stages = [...STAGE_KEYS].sort((a, b) => STAGES[a]!.stage - STAGES[b]!.stage);

  // One stage row: its Claude Code or OpenCode copy, chosen with the switch.
  const stageRow = (key: string) => {
    const info = STAGES[key]!;
    const cli = cliByStage[key] ?? "claude";
    const p = byBuiltin.get(cli === "claude" ? key : `${key}-opencode`);
    const editable = p ? canEditFiles(p) : !info.readOnly;
    return (
      <li
        key={key}
        data-stage={key}
        className="flex flex-wrap items-start gap-3 px-3 py-3"
      >
        <span
          aria-label={`Stage ${info.stage}`}
          className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums"
        >
          {info.stage}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{info.name}</span>
            <Badge variant="outline">{editable ? "Can edit" : "Read-only"}</Badge>
            {cli === "claude" && p && (
              <Badge variant="outline">{modelClass(p.model) ? `${modelClass(p.model)} model` : p.model}</Badge>
            )}
            {cli === "opencode" && p && (
              <Badge variant="outline">{p.model ? p.model : "OpenCode's model"}</Badge>
            )}
          </div>
          <div className="text-muted-foreground text-xs">{info.description}</div>
          <div className="text-muted-foreground text-xs">
            Use it when: {info.whenToUse}
          </div>
          {!p && (
            <div className="text-destructive text-xs">
              Not in your list for {CLI_LABEL[cli]}. Restore built-ins brings it back.
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <div
            role="group"
            aria-label={`CLI for ${info.name}`}
            className="bg-muted mr-1 inline-flex rounded-md p-0.5"
          >
            {(["claude", "opencode"] as Cli[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cli === c}
                onClick={() => setCliByStage((s) => ({ ...s, [key]: c }))}
                className={`rounded-md px-2 py-1 text-xs ${
                  cli === c
                    ? "bg-background font-medium shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                {CLI_LABEL[c]}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${info.name}, ${CLI_LABEL[cli]}`}
            title="Edit"
            disabled={!p}
            onClick={() => p && setEditing(p)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Export ${info.name}, ${CLI_LABEL[cli]}`}
            title="Export"
            disabled={!p}
            onClick={() => p && void doExport(p.id)}
          >
            <Download />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Duplicate ${info.name}, ${CLI_LABEL[cli]}`}
            title="Duplicate"
            disabled={!p}
            onClick={() => p && void doDuplicate(p)}
          >
            <Copy />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reset ${info.name}, ${CLI_LABEL[cli]} to built-in`}
            title="Reset to built-in"
            disabled={!p}
            onClick={() => p && setConfirm({ kind: "reset", preset: p })}
          >
            <RotateCcw />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Presets</CardTitle>
        <CardDescription>
          Eight stages, each for Claude Code and OpenCode. Applying a preset
          starts nothing; it only fills in the settings of a terminal you open.
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <Upload /> Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={list.length === 0}
            onClick={() => void doExport()}
          >
            <Download /> Export all
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json,text/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void pickFile(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={restore.isPending}
            onClick={() =>
              void run(
                () => restore.mutateAsync([]),
                "Built-in presets restored.",
              )
            }
          >
            <RotateCcw /> Restore built-ins
          </Button>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> New preset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-muted-foreground text-sm">
            {notice}
          </p>
        )}
        {presets.isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Built-in stages</h3>
              <ul className="divide-y rounded-md border">
                {stages.map((k) => stageRow(k))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Your presets</h3>
              {mine.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  None yet. Create one with New preset, or duplicate a stage to
                  start from its settings.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {mine.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-4 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {p.name}
                          </span>
                          {p.agent !== "shell" && (
                            <Badge variant="outline">
                              {canEditFiles(p) ? "Can edit" : "Read-only"}
                            </Badge>
                          )}
                          <Badge variant="secondary">{AGENT_LABEL[p.agent]}</Badge>
                        </div>
                        <div className="text-muted-foreground truncate font-mono text-xs">
                          {summary(p)}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${p.name}`}
                          title="Edit"
                          onClick={() => setEditing(p)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Export ${p.name}`}
                          title="Export"
                          onClick={() => void doExport(p.id)}
                        >
                          <Download />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Duplicate ${p.name}`}
                          title="Duplicate"
                          onClick={() => void doDuplicate(p)}
                        >
                          <Copy />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${p.name}`}
                          title="Delete"
                          onClick={() => setConfirm({ kind: "delete", preset: p })}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>

      {editing && (
        <PresetEditor
          open
          preset={editing === "new" ? null : editing}
          defaultModel={settings.data?.defaultModels.claude ?? "sonnet"}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={confirm != null}
        title={
          confirm?.kind === "delete"
            ? `Delete ${confirm.preset.name}?`
            : `Reset ${confirm?.preset.name} to built-in?`
        }
        confirmLabel={
          confirm?.kind === "delete" ? "Delete preset" : "Reset preset"
        }
        destructive={confirm?.kind === "delete"}
        busy={remove.isPending || reset.isPending}
        error={error}
        onConfirm={() => void doConfirm()}
        onClose={() => {
          setConfirm(null);
          setError(null);
        }}
      >
        {confirm?.kind === "delete" ? (
          <p>
            {confirm.preset.builtin
              ? "Restore built-ins brings it back."
              : "This cannot be undone."}
          </p>
        ) : (
          <p>
            The launch settings and instructions go back to the shipped values,
            replacing your edits.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={importing != null}
        title="Import presets"
        confirmLabel="Import"
        destructive={false}
        busy={importBusy}
        error={error}
        onConfirm={() => void doImport()}
        onClose={() => {
          setImporting(null);
          setError(null);
        }}
      >
        <ul className="max-h-60 space-y-1 overflow-auto text-sm">
          {importing?.items.map((i, n) => (
            <li key={n} className="flex items-baseline justify-between gap-3">
              <span className="truncate">{i.name || "(unnamed)"}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {i.action}
                {i.reason && `: ${i.reason}`}
              </span>
            </li>
          ))}
        </ul>
        {importing?.items.length === 0 && <p>The file has no presets.</p>}
      </ConfirmDialog>
    </Card>
  );
}
