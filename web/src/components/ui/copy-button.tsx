/**
 * The web copy button: the same `Button` and the same tick, with the browser's
 * clipboard as the writer. `copy-button.tsx` is the native counterpart and
 * `copy-button-base.ts` holds what they share.
 *
 * Hand-written rather than compiled because the native half's clipboard is
 * `expo-clipboard`, which the compiler has no DOM translation for — and a DOM app
 * should not install an Expo module to reach `navigator.clipboard`.
 *
 * `navigator.clipboard` exists only in a secure context, so on a LAN address over
 * plain http it is `undefined` rather than a function that fails. The fallback is
 * the old hidden-textarea `execCommand("copy")`, which still works there and is
 * what kanban_server's settings page carried for exactly that case.
 */
import { Button } from "@/components/ui/button";
import { type CopyButtonProps, useCopy } from "@/components/ui/copy-button-base";
import { Check, Copy } from "@/components/ui/icons";

export type { CopyButtonProps };

async function write(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("The clipboard refused the text");
}

export function CopyButton({
  value,
  label = "Copy",
  variant = "ghost",
  size = "icon-sm",
  onCopied,
  onError,
  className,
}: CopyButtonProps) {
  const { copied, copy } = useCopy(write, { value, onCopied, onError });

  return (
    <Button
      data-slot="copy-button"
      variant={variant}
      size={size}
      aria-label={copied ? "Copied" : label}
      className={className}
      onClick={() => void copy()}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}
