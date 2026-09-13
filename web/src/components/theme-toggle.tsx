import { Monitor, Moon, Sun } from "lucide-react";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match the system", icon: Monitor },
];

/**
 * Three states rather than a switch, because "follow the machine" is a real answer a two-way
 * toggle cannot hold — and it is the default, so a switch would have to lie about where it
 * started.
 *
 * Real radios under the labels rather than buttons wearing `role="radio"`: the group then
 * arrows between its options and announces itself without any of that being written here.
 */
export function ThemeToggle() {
  const theme = useTheme();

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
