import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { InputField, useAppForm } from "@/components/app-form";
import { FilePen } from "@/components/app-icons";
import { ConfirmButton } from "@/components/confirm-button";
import { DialogLayout } from "@/components/dialog-layout";
import { Button } from "@/components/ui/button";
import { FilePicker } from "@/components/ui/file-picker";
import { Plus, Trash2, Upload, X } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { folderOf, inFolder, withinFolder } from "@/lib/folders";
import { errorMessage, serverError } from "@/lib/form-errors";
import { formatCount } from "@/lib/format";
import { useDeleteDoc, useMoveDoc, useUploadDoc } from "@/lib/queries";

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
  const [files, setFiles] = useState<Picked[]>([]);
  const upload = useUploadDoc();
  const toast = useToast();
  const navigate = useNavigate();
  const form = useAppForm({
    defaultValues: { subfolder: "" },
    onSubmit: () =>
      send(
        files.filter((file) => file.state === "ready" || file.state === "failed"),
        false,
      ),
  });

  const update = (name: string, patch: Partial<Picked>) =>
    setFiles((prev) => prev.map((file) => (file.name === name ? { ...file, ...patch } : file)));

  /** Upload `targets` one by one; the uploaded rows leave the list, the refused ones stay. */
  const send = async (targets: Picked[], overwrite: boolean) => {
    const { subfolder } = form.state.values;
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
            error: errorMessage(error),
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
      form.reset();
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
        <form
          id="upload-docs"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <InputField
            form={form}
            name="subfolder"
            label="Subfolder"
            description={`Optional, relative to ${title}. Missing subfolders are created.`}
            placeholder="notes/imported"
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
                    <form.Subscribe selector={(state) => state.values.subfolder}>
                      {(subfolder) => (
                        <p className="truncate font-mono text-xs">
                          {joinPath(subfolder, file.name)}
                        </p>
                      )}
                    </form.Subscribe>
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
        </form>
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
          <form.AppForm>
            <form.SubmitButton
              form="upload-docs"
              pendingLabel="Uploading…"
              disabled={busy || ready.length === 0}
            >
              {busy
                ? "Uploading…"
                : `Upload ${ready.length > 0 ? formatCount(ready.length, "file") : ""}`}
            </form.SubmitButton>
          </form.AppForm>
        </>
      )}
    />
  );
}

/**
 * A note's file name from its title: the title itself, as Obsidian does, less the characters a
 * file system or a wikilink cannot hold.
 */
const fileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/^[.\s-]+|\s+$/g, "")}.md`;

/**
 * Where a new note's title and subfolder put it. Typed with an extension, the title is the file
 * name: `Kafka.md` is `Kafka.md`, not `Kafka.md.md`.
 */
function target({ title, subfolder }: { title: string; subfolder: string }) {
  const heading = title.trim().replace(MARKDOWN, "");
  const name = fileName(heading);
  return { heading, name, relative: joinPath(subfolder, name) };
}

const isExisting = (error: unknown) => error instanceof ApiError && error.status === 409;

/**
 * Start a new note in a folder, optionally in a subfolder of it (created if missing), and open it
 * in the editor. `dir` is where it goes unless changed: the open note's subfolder, so a new note
 * lands beside the one being read.
 */
export function NewNote({
  folder,
  title: folderTitle,
  dir = "",
  trigger,
}: {
  folder: string;
  title: string;
  dir?: string | undefined;
  trigger?: ReactNode | undefined;
}) {
  const [open, setOpen] = useState(false);
  const create = useUploadDoc();
  const navigate = useNavigate();
  const form = useAppForm({
    defaultValues: { title: "", subfolder: dir },
    onSubmit: async ({ value }) => {
      const { heading, relative } = target(value);
      try {
        await create.mutateAsync({ path: inFolder(folder, relative), text: `# ${heading}\n\n` });
        reset(false);
        openNote(relative, true);
      } catch (error) {
        form.setFieldMeta(
          "title",
          serverError(
            isExisting(error) ? "A note with that name is already there." : errorMessage(error),
          ),
        );
      }
    },
  });
  const exists = isExisting(create.error);

  // A change to either field is a different file: the last answer about it no longer applies.
  const clearServer = () => {
    create.reset();
    form.setFieldMeta("title", serverError(undefined));
  };
  const reset = (next: boolean) => {
    setOpen(next);
    form.reset({ title: "", subfolder: dir });
    create.reset();
  };
  const openNote = (relative: string, edit: boolean) =>
    void navigate({
      to: "/f/$folder",
      params: { folder },
      search: (prev) => ({ ...prev, doc: relative, ...(edit ? { edit: true } : {}) }),
    });

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={
        trigger ?? (
          <ActionButton label="New note" variant="ghost" size="icon-sm">
            <Plus aria-hidden />
          </ActionButton>
        )
      }
      title="New note"
      description={`A Markdown file in ${folderTitle}, opened in the editor once it is created.`}
      hasUnsavedChanges={() => form.state.values.title !== ""}
      content={
        <form
          id="new-note"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Subscribe
            selector={(state) => {
              const { name, relative } = target(state.values);
              return name === ".md" ? undefined : relative;
            }}
          >
            {(relative) => (
              <InputField
                form={form}
                name="title"
                label="Title"
                required
                description={
                  relative ? (
                    <>
                      Saved as <span className="break-all font-mono">{relative}</span>
                    </>
                  ) : undefined
                }
                autoFocus
                placeholder="Kafka retention"
                validators={{
                  onChange: ({ value }) =>
                    target({ title: value, subfolder: "" }).name === ".md"
                      ? "A note needs a title."
                      : undefined,
                }}
                listeners={{ onChange: clearServer }}
              />
            )}
          </form.Subscribe>
          <InputField
            form={form}
            name="subfolder"
            label="Subfolder"
            description={`Optional, relative to ${folderTitle}. Missing subfolders are created.`}
            placeholder="notes/ideas"
            listeners={{ onChange: clearServer }}
          />
        </form>
      }
      footer={
        exists ? (
          <Button
            variant="outline"
            onClick={() => {
              const { relative } = target(form.state.values);
              reset(false);
              openNote(relative, false);
            }}
          >
            Open it
          </Button>
        ) : undefined
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.SubmitButton form="new-note" pendingLabel="Creating…">
              Create
            </form.SubmitButton>
          </form.AppForm>
        </>
      )}
    />
  );
}

/** What was typed as a path within the folder: tidied, and a note even without its extension. */
function movedTo(typed: string): string {
  const path = joinPath("", typed.trim());
  return !path || MARKDOWN.test(path) ? path : `${path}.md`;
}

/**
 * Rename or move the previewed note (root-relative `path`) within its folder. The server rewrites
 * every link in the folder that pointed at it, so nothing that linked here breaks.
 */
export function RenameDoc({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const move = useMoveDoc();
  const toast = useToast();
  const navigate = useNavigate();
  const folder = folderOf(path);
  const current = withinFolder(path);
  const form = useAppForm({
    defaultValues: { to: current },
    onSubmit: async ({ value }) => {
      const to = movedTo(value.to);
      try {
        const moved = await move.mutateAsync({ from: path, to: inFolder(folder, to) });
        setOpen(false);
        const links = moved.updated.length;
        toast(
          links > 0 ? `Moved, and updated links in ${formatCount(links, "note")}` : "Moved",
          "success",
        );
        void navigate({
          to: "/f/$folder",
          params: { folder },
          search: (prev) => ({ ...prev, doc: withinFolder(moved.to) }),
        });
      } catch (error) {
        form.setFieldMeta(
          "to",
          serverError(
            isExisting(error) ? "Something is already at that path." : errorMessage(error),
          ),
        );
      }
    },
  });
  const reset = (next: boolean) => {
    setOpen(next);
    form.reset({ to: current });
    move.reset();
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={
        <ActionButton label="Rename or move" variant="ghost" size="icon-sm">
          <FilePen aria-hidden />
        </ActionButton>
      }
      title="Rename or move"
      description="Links to this note from anywhere in the folder are rewritten to follow it."
      hasUnsavedChanges={() => movedTo(form.state.values.to) !== current}
      content={
        <form
          id="rename-doc"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Subscribe selector={(state) => movedTo(state.values.to)}>
            {(to) => (
              <InputField
                form={form}
                name="to"
                label="Path"
                required
                autoFocus
                description={
                  to && to !== current ? (
                    <>
                      Saved as <span className="break-all font-mono">{to}</span>
                    </>
                  ) : (
                    "Relative to the folder. Missing subfolders are created."
                  )
                }
                validators={{
                  onChange: ({ value: typed }) => {
                    const to = movedTo(typed);
                    if (!to) return "A note needs a path.";
                    if (to === current) return "That is where it is now.";
                    return undefined;
                  },
                }}
                listeners={{ onChange: () => form.setFieldMeta("to", serverError(undefined)) }}
              />
            )}
          </form.Subscribe>
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.SubmitButton form="rename-doc" pendingLabel="Moving…">
              Move
            </form.SubmitButton>
          </form.AppForm>
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
