export type ThemePreference = "light" | "dark" | "system";

/** In the order a picker shows them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

/**
 * The key the preference is stored under, on both platforms. One key rather than an option: the
 * picker's own hook, the one at the app's root and the pre-paint script all have to agree on it,
 * and a key passed to one of them and not the others is a picker that writes where nothing reads.
 */
export const THEME_STORAGE_KEY = "cubeui-theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Where the device keeps the preference. `@react-native-async-storage/async-storage` fits as it
 * is; `expo-secure-store` or MMKV fit behind two lambdas. The item takes the shape rather than a
 * package, so it adds no storage dependency to an app that already has one. Either method may
 * return a promise.
 */
export type ThemeStorage = {
  getItem: (key: string) => string | null | undefined | Promise<string | null | undefined>;
  setItem: (key: string, value: string) => void | Promise<void>;
  /** Only `migrateThemePreference` calls it, to clear the old key. Without it the old key stays. */
  removeItem?: ((key: string) => void | Promise<void>) | undefined;
};

/**
 * Which set of colours to paint in, beside the light / dark choice. `default` is cubeui's own and
 * what nothing stored means; the rest are `palettes` in `tokens/palette.mjs`.
 */
export type PalettePreference = "default" | "monokai";

/** In the order a picker shows them. */
export const PALETTE_PREFERENCES: readonly PalettePreference[] = ["default", "monokai"];

/** Where the palette is stored, beside `THEME_STORAGE_KEY` and for the same reason. */
export const PALETTE_STORAGE_KEY = "cubeui-palette";

/**
 * Palettes with no light set. Choosing one is dark whatever the theme says — there is no light
 * Monokai to paint — and a picker shows the theme choice as moot while one is chosen.
 */
export const DARK_ONLY_PALETTES: readonly PalettePreference[] = ["monokai"];

export function isPalettePreference(value: unknown): value is PalettePreference {
  return PALETTE_PREFERENCES.includes(value as PalettePreference);
}

/**
 * The keys an app stored these choices under before it adopted the picker, oldest name last. The
 * storage keys stay fixed, for the reason `THEME_STORAGE_KEY` gives; this is the one-way door into
 * them, so a reader who had chosen dark is not back on System the day the app moves over.
 */
export type LegacyPreferenceKeys = {
  /** Keys that held `light`, `dark` or `system`. */
  theme?: readonly string[] | undefined;
  /** Keys that held one of `PALETTE_PREFERENCES`. */
  palette?: readonly string[] | undefined;
};

/**
 * What a migration does, as data both halves and the pre-paint script walk: for each of our keys
 * that is empty, the first old key holding one of `values` is copied in and then removed. A key
 * of ours that already holds something is left alone, and so is an old value that is not one of
 * ours — a `"sepia"` is not copied in to be ignored.
 */
export function legacyMigrations(
  legacyKeys: LegacyPreferenceKeys = {},
): { key: string; from: readonly string[]; values: readonly string[] }[] {
  return [
    { key: THEME_STORAGE_KEY, from: legacyKeys.theme ?? [], values: THEME_PREFERENCES },
    { key: PALETTE_STORAGE_KEY, from: legacyKeys.palette ?? [], values: PALETTE_PREFERENCES },
  ].filter((migration) => migration.from.length > 0);
}

export type ThemePreferenceOptions = {
  /**
   * Device only: where the choice persists between launches. Without one, a choice lasts until
   * the app is closed. Pass it where the app starts; a `useThemePreference()` anywhere else — the
   * one inside `ThemePicker` — writes through it too. The web always uses `localStorage`, because
   * it is the one store the pre-paint script can read before any of the bundle has loaded.
   */
  storage?: ThemeStorage | undefined;
};

/** What `useThemePreference` returns: the stored choice and the one way to change it. */
export type ThemePreferenceState = readonly [
  preference: ThemePreference,
  setPreference: (next: ThemePreference) => void,
];

/** What `usePalettePreference` returns, the same shape. */
export type PalettePreferenceState = readonly [
  palette: PalettePreference,
  setPalette: (next: PalettePreference) => void,
];

/**
 * The web's first paint, before React mounts: the same rule `useThemePreference` applies, as a
 * self-contained script for an inline `<script>` in the page's `<head>`. Render it with
 * `dangerouslySetInnerHTML` where the head is React (Expo's `+html.tsx`, a Next layout); paste the
 * copy in the skill's `controls.md` where it is a static `index.html`. A unit test holds that copy
 * to this string.
 *
 * `dark` goes on `<html>` for Dark, and for System while the device is dark; `light` goes on it for
 * Light only. A dark-only palette is `dark` whatever the theme, and never `light`. A palette other
 * than the default is `data-palette` on `<html>`, which both stylesheets key its colours off. `dist/tokens.native.css` (Expo web) reads both over its `prefers-color-scheme` block;
 * `tokens.web.css` (the DOM registry) has no media query and reads `.dark` alone, which is why
 * System still sets `dark` on a dark device rather than leaving it to a query that stylesheet does
 * not have.
 *
 * Written in ES5 and wrapped in `try`, because it runs before anything else on the page and a
 * browser with storage switched off throws on `localStorage` itself.
 *
 * `legacyKeys` makes it migrate first — the same copy `migrateThemePreference` does, here because
 * this runs before the bundle and the first paint after an upgrade is the one that would flash.
 * Without them the script is `THEME_PRE_PAINT_SCRIPT`, byte for byte.
 */
export function themePrePaintScript({
  legacyKeys,
}: {
  legacyKeys?: LegacyPreferenceKeys | undefined;
} = {}): string {
  const migrations = legacyMigrations(legacyKeys);
  const migrate =
    migrations.length === 0
      ? ""
      : "m=function(k,l,v){if(s.getItem(k)===null)for(var i=0;i<l.length;i++){" +
        "var x=s.getItem(l[i]);if(v.indexOf(x)>=0){s.setItem(k,x);s.removeItem(l[i]);break}}}," +
        migrations
          .map(
            ({ key, from, values }) => `_=m(${JSON.stringify([key, from, values]).slice(1, -1)}),`,
          )
          .join("");
  return (
    "(function(){try{" +
    `var s=localStorage,${migrate}p=s.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),` +
    PRE_PAINT_RULE
  );
}

/** Everything after the theme is read: the rule itself, the same with or without a migration. */
const PRE_PAINT_RULE =
  `q=s.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)}),` +
  `k=${JSON.stringify(DARK_ONLY_PALETTES)}.indexOf(q)>=0,` +
  'd=k||p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches),' +
  'e=document.documentElement,c=e.classList;c.toggle("dark",d);c.toggle("light",!k&&p==="light");' +
  `if(${JSON.stringify(PALETTE_PREFERENCES.filter((p) => p !== "default"))}.indexOf(q)>=0)` +
  'e.setAttribute("data-palette",q)' +
  "}catch(e){}})();";

/** The pre-paint script for an app with no older keys to bring across. */
export const THEME_PRE_PAINT_SCRIPT = themePrePaintScript();
