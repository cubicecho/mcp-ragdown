import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Asked before leaving unsaved changes behind: stay (the default), or leave and lose them. */
export function LeaveDialog({
  open,
  description,
  onStay,
  onLeave,
}: {
  open: boolean;
  description: ReactNode;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onStay())}
      title="Discard unsaved changes?"
      description={description}
      cancelLabel="Keep editing"
      confirmLabel="Discard"
      onConfirm={onLeave}
    />
  );
}
