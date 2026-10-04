import type { ServerSettingsPatch, Status } from "@/lib/api";
import { HOOK_KEYS } from "@/lib/folders";

type Settings = Status["settings"];

/**
 * The server settings as their form holds them. The embedder and the watch switch always show a
 * value; a number left empty is `null`, which is whatever the environment says.
 */
export type SettingsForm = {
  embedder: string;
  watch: boolean;
  text_limit: number | null;
  top_k: number | null;
  min_score: number | null;
  min_ratio: number | null;
  max_chars: number | null;
};

export const settingsForm = (settings: Settings): SettingsForm => ({
  embedder: settings.embedder,
  watch: settings.watch,
  text_limit: settings.saved.text_limit ?? null,
  top_k: settings.saved.hook?.top_k ?? null,
  min_score: settings.saved.hook?.min_score ?? null,
  min_ratio: settings.saved.hook?.min_ratio ?? null,
  max_chars: settings.saved.hook?.max_chars ?? null,
});

/**
 * What a save sends: only what differs from what is saved. An embedder or a watch switch put back
 * to what the environment says is sent as `null`, so nothing is saved for it.
 */
export function settingsPatch(settings: Settings, values: SettingsForm): ServerSettingsPatch {
  const patch: ServerSettingsPatch = {};
  if (values.embedder !== settings.embedder) {
    patch.embedder = values.embedder === settings.env.embedder ? null : values.embedder;
  }
  if (values.watch !== settings.watch) {
    patch.watch = values.watch === settings.env.watch ? null : values.watch;
  }
  if (values.text_limit !== (settings.saved.text_limit ?? null)) {
    patch.text_limit = values.text_limit;
  }
  const hook: NonNullable<ServerSettingsPatch["hook"]> = {};
  for (const key of HOOK_KEYS) {
    if (values[key] !== (settings.saved.hook?.[key] ?? null)) hook[key] = values[key];
  }
  if (Object.keys(hook).length > 0) patch.hook = hook;
  return patch;
}

/** The floor a prompt must reach when none is saved, for the embedder the form has chosen. */
export const defaultMinScore = (settings: Settings, embedder: string) =>
  settings.env.hook.min_score ?? settings.embedders[embedder]?.min_score ?? settings.hook.min_score;
