import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type ToastTone = "error" | "success";

type Toast = { id: number; message: string; tone: ToastTone };

/** Show a message. Defaults to `error`, which is what nearly every caller wants. */
type ShowToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Errors linger — the user has to read a reason; confirmations do not. */
const DURATION_MS: Record<ToastTone, number> = {
  error: 6000,
  success: 3000,
};

const TONE_CLASS: Record<ToastTone, string> = {
  error: "bg-destructive",
  success: "bg-primary",
};

const TONE_TEXT_CLASS: Record<ToastTone, string> = {
  error: "text-destructive-foreground",
  success: "text-primary-foreground",
};

/**
 * `position: "fixed"` keeps the stack pinned to the viewport on web no matter
 * which scroll container the mutation was fired from. It is a real CSS value
 * that react-native-web passes through, but not one react-native's `ViewStyle`
 * admits, hence the cast. Native gets `absolute`, which resolves against the
 * router's full-screen container.
 */
const VIEWPORT_STYLE = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 50,
} as unknown as React.CSSProperties;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (message, tone = "error") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS[tone]),
      );
    },
    [dismiss],
  );

  // A toast outlives the component that raised it, so the timer has to be
  // cleaned up here rather than at the call site.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toasts.length > 0 && (
        <div style={VIEWPORT_STYLE} className="cube-rn-view cube-rn-pe-box-none gap-2">
          {/*
           * The announcement and the dismiss target are two elements, not one. They were one — a
           * `Pressable` with `accessibilityRole="alert"` — and `rn2web` is what showed that to be
           * wrong: a role replaces an element's semantics rather than adding to them, so that
           * markup was an alert with a click handler nothing could reach by keyboard. The same
           * was true on device, where the role told the screen reader it was looking at a
           * message and not at something to activate.
           */}
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="alert"
              className={cn(
                "cube-rn-view",
                `max-w-sm flex-row items-start gap-3 rounded-lg px-4 py-3 shadow-lg ${TONE_CLASS[toast.tone]}`,
              )}
            >
              <span className={cn("cube-rn-text", `flex-1 text-sm ${TONE_TEXT_CLASS[toast.tone]}`)}>
                {toast.message}
              </span>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
                className="cube-rn-view cube-rn-pressable shrink-0"
              >
                <span
                  className={cn(
                    "cube-rn-text",
                    `text-sm font-medium ${TONE_TEXT_CLASS[toast.tone]}`,
                  )}
                >
                  ×
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/**
 * Throws when no provider is mounted rather than silently swallowing the
 * message — a toast that never appears is the bug this module exists to fix.
 */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return show;
}
