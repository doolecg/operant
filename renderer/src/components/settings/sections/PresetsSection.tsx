import { useState } from "react";
import { Armchair, Copy, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { decodeIpcError } from "@shared/ipc";
import type { Preset } from "@shared/types";
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
  useDeletePreset,
  useDuplicatePreset,
  usePresets,
  useResetPreset,
  useRestoreBuiltinPresets,
  useSettings,
} from "@/lib/queries";
import { ConfirmDialog } from "../parts";
import { SeatDialog } from "./SeatDialog";

type Confirm = { kind: "delete" | "reset"; preset: Preset };

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
  const [seat, setSeat] = useState<Preset | null>(null);
  const [editing, setEditing] = useState<Preset | "new" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    const ok = await run(
      () =>
        kind === "delete"
          ? remove.mutateAsync([preset.id])
          : reset.mutateAsync([preset.id]),
      kind === "delete"
        ? `Deleted ${preset.name}.`
        : `${preset.name} is back to its built-in values.`,
    );
    if (ok) setConfirm(null);
  };

  const list = presets.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Presets</CardTitle>
        <CardDescription>
          Launch settings and a role text that seats start agents from.
        </CardDescription>
        <CardAction className="flex gap-2">
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
      <CardContent className="space-y-3">
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
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No presets. Restore the built-ins or create one.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((p) => {
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-4 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {p.name}
                      </span>
                      {p.builtin && <Badge variant="secondary">Built-in</Badge>}
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
                      aria-label={`Seat settings for ${p.name}`}
                      title="Seat settings"
                      onClick={() => setSeat(p)}
                    >
                      <Armchair />
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
                    {p.builtin && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Reset ${p.name} to built-in`}
                        title="Reset to built-in"
                        onClick={() => setConfirm({ kind: "reset", preset: p })}
                      >
                        <RotateCcw />
                      </Button>
                    )}
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
              );
            })}
          </ul>
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

      {seat && (
        <SeatDialog key={seat.id} preset={seat} onClose={() => setSeat(null)} />
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
            Seats and teams that use it show it as a deleted preset.
            {confirm.preset.builtin
              ? " Restore built-ins brings it back."
              : " This cannot be undone."}
          </p>
        ) : (
          <p>
            The launch settings and role text go back to the shipped values,
            replacing your edits.
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}

