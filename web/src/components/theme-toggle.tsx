import { Monitor, Moon, Sun } from "@/components/ui/icons";
import { useThemePreference } from "@/components/ui/theme-preference";
import type { ThemePreference } from "@/components/ui/theme-preference-base";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match the system", icon: Monitor },
];

/**
 * The theme choice, small enough for the sidebar's footer and the phone header bar.
 *
 * The storing, the class on `<html>` and following the system all come from cubeui's
 * `useThemePreference`. Only the control is drawn here: `ThemePicker` is a row of card tiles with
 * a caption under each, which does not fit a 14rem sidebar or a header bar.
 * TODO(https://github.com/cubicecho/cubeui/issues/126): swap for `<ThemePicker variant="compact" />` once there is one.
 *
 * Real radios under the labels rather than buttons wearing `role="radio"`: the group then
 * arrows between its options and announces itself without any of that being written here.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useThemePreference();

  return (
    <fieldset className="flex items-center gap-0.5 rounded-lg border p-0.5">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <label
          key={value}
          title={label}
          className="flex flex-1 cursor-pointer items-center justify-center rounded-md py-1 text-muted-foreground transition-colors hover:text-foreground has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name="theme"
            className="sr-only"
            value={value}
            checked={theme === value}
            onChange={() => setTheme(value)}
          />
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
