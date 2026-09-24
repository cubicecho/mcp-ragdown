import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { ConfirmButton } from "@/components/confirm-button";
import { DialogLayout } from "@/components/dialog-layout";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { FilePicker } from "@/components/ui/file-picker";
import { Trash2, Upload, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { folderOf, inFolder, withinFolder } from "@/lib/folders";
import { formatCount } from "@/lib/format";
import { useDeleteDoc, useUploadDoc } from "@/lib/queries";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

type Picked = {
  name: string;
  text: string;
  state: "ready" | "uploading" | "done" | "exists" | "failed";
  error?: string;
};

/** `notes/./imported/` → `notes/imported`; the server still has the last word on the path. */
function joinPath(subfolder: string, name: string): string {
  const parts = subfolder.split(/[\\/]+/).filter((part) => part && part !== ".");
  return [...parts, name].join("/");
}

/**
 * Upload Markdown files into a folder, optionally under a subfolder. The picker takes one file
 * at a time, so each pick adds a row; a file that already exists stays in the list with an
 * Overwrite button rather than being replaced unasked.
 */
export function UploadDocs({ folder, title }: { folder: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [subfolder, setSubfolder] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const upload = useUploadDoc();
  const toast = useToast();
  const navigate = useNavigate();

  const update = (name: string, patch: Partial<Picked>) =>
    setFiles((prev) => prev.map((file) => (file.name === name ? { ...file, ...patch } : file)));

  /** Upload `targets` one by one; the uploaded rows leave the list, the refused ones stay. */
  const send = async (targets: Picked[], overwrite: boolean) => {
    const uploaded: string[] = [];
    for (const file of targets) {
      update(file.name, { state: "uploading" });
      try {
        const result = await upload.mutateAsync({
          path: inFolder(folder, joinPath(subfolder, file.name)),
          text: file.text,
          overwrite,
        });
        uploaded.push(result.path);
        update(file.name, { state: "done" });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          update(file.name, { state: "exists" });
        } else {
          update(file.name, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    setFiles((prev) => prev.filter((file) => file.state !== "done"));

    if (uploaded.length > 0) toast(`Uploaded ${formatCount(uploaded.length, "file")}`, "success");
    // Everything picked is in: close, and show the file when there is only one to show.
    if (uploaded.length === files.length) {
      reset(false);
      const [only] = uploaded;
      if (uploaded.length === 1 && only) {
        void navigate({
          to: "/f/$folder",
          params: { folder },
          search: (prev) => ({ ...prev, doc: withinFolder(only) }),
        });
      }
    }
  };

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setFiles([]);
      setSubfolder("");
    }
  };

  const busy = files.some((file) => file.state === "uploading");
  const ready = files.filter((file) => file.state === "ready" || file.state === "failed");
  const existing = files.filter((file) => file.state === "exists");

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={
        <ActionButton label="Upload Markdown files" variant="ghost" size="icon-sm">
          <Upload aria-hidden />
        </ActionButton>
      }
      title="Upload Markdown"
      description={`Files are written into ${title} and indexed before the upload finishes.`}
      hasUnsavedChanges={() => files.some((file) => file.state !== "done")}
      content={
        <div className="flex flex-col gap-4">
          <FormField
            label="Subfolder"
            description={`Optional, relative to ${title}. Missing subfolders are created.`}
            control={
              <Input
                placeholder="notes/imported"
                value={subfolder}
                onChange={(event) => setSubfolder(event.target.value)}
              />
            }
          />
          <FilePicker
            label="Choose or drop a Markdown file"
            hint="One at a time: .md, .markdown or .mdx. Pick again to add another."
            accept=".md,.markdown,.mdx,text/markdown"
            onPick={(text, name) => {
              if (!MARKDOWN.test(name)) {
                toast(`${name} is not a Markdown file`);
                return;
              }
              setFiles((prev) => [
                ...prev.filter((file) => file.name !== name),
                { name, text, state: "ready" },
              ]);
            }}
          />
          {files.length > 0 ? (
            <ul className="flex flex-col divide-y rounded-md border text-sm">
              {files.map((file) => (
                <li key={file.name} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{joinPath(subfolder, file.name)}</p>
                    {file.state === "exists" ? (
                      <p className="text-muted-foreground text-xs">Already exists.</p>
                    ) : file.state === "failed" ? (
                      <p className="text-destructive text-xs">{file.error}</p>
                    ) : file.state === "uploading" ? (
                      <p className="text-muted-foreground text-xs">Uploading…</p>
                    ) : null}
                  </div>
                  {file.state === "exists" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void send([file], true)}
                    >
                      Overwrite
                    </Button>
                  ) : null}
                  <ActionButton
                    label={`Remove ${file.name}`}
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() =>
                      setFiles((prev) => prev.filter((other) => other.name !== file.name))
                    }
                  >
                    <X aria-hidden />
                  </ActionButton>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      }
      footer={
        existing.length > 1 ? (
          <Button variant="outline" disabled={busy} onClick={() => void send(existing, true)}>
            Overwrite {existing.length}
          </Button>
        ) : undefined
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy || ready.length === 0} onClick={() => void send(ready, false)}>
            {busy
              ? "Uploading…"
              : `Upload ${ready.length > 0 ? formatCount(ready.length, "file") : ""}`}
          </Button>
        </>
      )}
    />
  );
}

/** Delete the previewed file (root-relative `path`) from disk, then leave the preview. */
export function DeleteDoc({ path }: { path: string }) {
  const remove = useDeleteDoc();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <ConfirmButton
      label="Delete document"
      variant="ghost"
      size="icon-sm"
      disabled={remove.isPending}
      title="Delete this document?"
      description={`${path} is deleted from disk, not only from the index, and agents stop finding it.`}
      onConfirm={() =>
        remove.mutate(path, {
          onSuccess: () => {
            toast(`Deleted ${path}`, "success");
            void navigate({
              to: "/f/$folder",
              params: { folder: folderOf(path) },
              search: ({ doc: _, ...rest }) => rest,
            });
          },
          onError: (error) => toast(`Could not delete ${path}: ${error.message}`),
        })
      }
    >
      <Trash2 aria-hidden />
    </ConfirmButton>
  );
}
