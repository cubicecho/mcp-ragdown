import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { InputField, NumberField, SwitchField, useAppForm } from "@/components/app-form";
import { DialogLayout } from "@/components/dialog-layout";
import { Section } from "@/components/section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code, CodeBlock } from "@/components/ui/code";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { useToast } from "@/components/ui/toast";
import type { Folder } from "@/lib/api";
import { getToken } from "@/lib/auth";
import {
  folderForm,
  folderNameError,
  folderPatch,
  getLastFolder,
  hookValueError,
  mcpAddCommand,
  mcpJsonEntry,
  mcpOffEverywhere,
  setLastFolder,
} from "@/lib/folders";
import { errorMessage, serverError } from "@/lib/form-errors";
import { formatCount } from "@/lib/format";
import {
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useStatus,
  useUpdateFolder,
} from "@/lib/queries";

/** A new top-level folder: the directory and its `.ragdown.json`. Human-only unless MCP is on. */
export function CreateFolder({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated?: (folder: Folder) => void;
}) {
  const [open, setOpen] = useState(false);
  const create = useCreateFolder();
  const toast = useToast();
  const form = useAppForm({
    defaultValues: { name: "", title: "", mcp: false },
    onSubmit: async ({ value }) => {
      const title = value.title.trim();
      try {
        const folder = await create.mutateAsync({
          name: value.name.trim(),
          ...(title ? { title } : {}),
          mcp: value.mcp,
        });
        toast(`Created ${folder.title}`, "success");
        reset(false);
        onCreated?.(folder);
      } catch (error) {
        form.setFieldMeta("name", serverError(errorMessage(error)));
      }
    },
  });

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) form.reset();
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={trigger}
      title="Create folder"
      description="A top-level folder in the docs directory, with its own notes, search and MCP address."
      hasUnsavedChanges={() => !form.state.isDefaultValue}
      content={
        <form
          id="create-folder"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            description="The directory's name, and the last part of its MCP address."
            autoFocus
            placeholder="work"
            validators={{ onChange: ({ value }) => folderNameError(value.trim()) }}
            listeners={{ onChange: () => form.setFieldMeta("name", serverError(undefined)) }}
          />
          <InputField
            form={form}
            name="title"
            label="Title"
            description="How the folder is shown. The name, if left empty."
            placeholder="Work notes"
          />
          <SwitchField
            form={form}
            name="mcp"
            label="Serve over MCP"
            description="Off, the folder is human-only: searchable here, but agents never see it."
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.SubmitButton form="create-folder" pendingLabel="Creating…">
              Create
            </form.SubmitButton>
          </form.AppForm>
        </>
      )}
    />
  );
}

/** A dialog about one folder, opened from its row. Mounted while it is open, so it starts fresh. */
type FolderDialogProps = { folder: Folder; onClose: () => void };

const closing = (onClose: () => void) => (open: boolean) => {
  if (!open) onClose();
};

/**
 * A folder's settings as one form: its title, the MCP switch, and its own search defaults. Nothing
 * is saved until Save, so a half-typed title never reaches agents.
 */
export function EditFolder({ folder, onClose }: FolderDialogProps) {
  const update = useUpdateFolder();
  const status = useStatus();
  const toast = useToast();
  const defaults = status.data?.settings.hook;
  const form = useAppForm({
    defaultValues: folderForm(folder),
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync({ name: folder.name, patch: folderPatch(folder, value) });
        toast(`Saved ${value.title.trim() || folder.name}`, "success");
        onClose();
      } catch (error) {
        toast(`Could not update ${folder.name}: ${errorMessage(error)}`);
      }
    },
  });
  const changed = () => Object.keys(folderPatch(folder, form.state.values)).length > 0;
  const placeholder = (value: number | undefined) =>
    value === undefined ? undefined : String(value);

  return (
    <DialogLayout
      open
      onOpenChange={closing(onClose)}
      title={`Edit ${folder.title}`}
      description={
        <>
          Kept in <Code>{folder.name}/.ragdown.json</Code>.
        </>
      }
      hasUnsavedChanges={changed}
      content={
        <form
          id="edit-folder"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <InputField
            form={form}
            name="title"
            label="Title"
            description="How the folder is shown here and to agents. The name, if left empty."
            placeholder={folder.name}
            autoFocus
          />
          <form.Subscribe selector={(state) => state.values.mcp}>
            {(mcp) => (
              <SwitchField
                form={form}
                name="mcp"
                label="Serve over MCP"
                description={
                  mcp ? (
                    <>
                      Agents reach it at <Code>{folder.mcp_path}</Code>.
                    </>
                  ) : (
                    "Off, it is searchable here but agents never see it."
                  )
                }
              />
            )}
          </form.Subscribe>
          <Section
            title="Search defaults"
            level={3}
            description={
              <>
                What <Code>ragdown_context</Code> injects from this folder before each prompt. Left
                empty, a value is the server's.
              </>
            }
            content={
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  form={form}
                  name="top_k"
                  label="Sections per prompt"
                  min={0}
                  step={1}
                  placeholder={placeholder(defaults?.top_k)}
                  validators={{ onChange: ({ value }) => hookValueError("top_k", value) }}
                />
                <NumberField
                  form={form}
                  name="max_chars"
                  label="Characters per prompt"
                  min={0}
                  step={500}
                  placeholder={placeholder(defaults?.max_chars)}
                  validators={{ onChange: ({ value }) => hookValueError("max_chars", value) }}
                />
                <NumberField
                  form={form}
                  name="min_score"
                  label="Minimum score"
                  description="Cosine similarity, on the embedder's own scale."
                  step={0.05}
                  placeholder={placeholder(defaults?.min_score)}
                />
                <NumberField
                  form={form}
                  name="min_ratio"
                  label="Share of the best hit"
                  description="The least a hit may score against the best one; 0 turns it off."
                  min={0}
                  max={1}
                  step={0.05}
                  placeholder={placeholder(defaults?.min_ratio)}
                  validators={{ onChange: ({ value }) => hookValueError("min_ratio", value) }}
                />
              </div>
            }
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.Subscribe
              selector={(state) => Object.keys(folderPatch(folder, state.values)).length === 0}
            >
              {(unchanged) => (
                <form.SubmitButton form="edit-folder" pendingLabel="Saving…" disabled={unchanged}>
                  Save
                </form.SubmitButton>
              )}
            </form.Subscribe>
          </form.AppForm>
        </>
      )}
    />
  );
}

/** Rename a folder's directory. Every path in it changes, so it is re-indexed. */
export function RenameFolder({ folder, onClose }: FolderDialogProps) {
  const update = useUpdateFolder();
  const toast = useToast();
  const form = useAppForm({
    defaultValues: { name: folder.name },
    onSubmit: async ({ value }) => {
      try {
        const renamed = await update.mutateAsync({
          name: folder.name,
          patch: { name: value.name.trim() },
        });
        if (getLastFolder() === folder.name) setLastFolder(renamed.name);
        toast(`Renamed ${folder.name} to ${renamed.name}`, "success");
        onClose();
      } catch (error) {
        form.setFieldMeta("name", serverError(errorMessage(error)));
      }
    },
  });

  return (
    <DialogLayout
      open
      onOpenChange={closing(onClose)}
      title={`Rename ${folder.name}`}
      description={
        <>
          Renames the directory, re-indexes it, and moves its MCP address to{" "}
          <form.Subscribe selector={(state) => state.values.name.trim()}>
            {(name) => <Code>/mcp/{name || "…"}</Code>}
          </form.Subscribe>
          . Agents set up with the old address stop reaching it.
        </>
      }
      hasUnsavedChanges={() => form.state.values.name.trim() !== folder.name}
      content={
        <form
          id="rename-folder"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <InputField
            form={form}
            name="name"
            label="New name"
            required
            autoFocus
            validators={{ onChange: ({ value }) => folderNameError(value.trim()) }}
            listeners={{ onChange: () => form.setFieldMeta("name", serverError(undefined)) }}
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.Subscribe selector={(state) => state.values.name.trim() === folder.name}>
              {(unchanged) => (
                <form.SubmitButton
                  form="rename-folder"
                  pendingLabel="Renaming…"
                  disabled={unchanged}
                >
                  Rename
                </form.SubmitButton>
              )}
            </form.Subscribe>
          </form.AppForm>
        </>
      )}
    />
  );
}

/**
 * Delete a folder and everything in it, from disk. Asked with the name typed out, because it takes
 * every note with it — a click-through confirm is too easy to wave past for that.
 */
export function DeleteFolder({ folder, onClose }: FolderDialogProps) {
  const remove = useDeleteFolder();
  const toast = useToast();

  return (
    <ConfirmDialog
      open
      onOpenChange={closing(onClose)}
      title={`Delete ${folder.title}?`}
      description={`The ${folder.name} directory is deleted from disk with its ${formatCount(folder.files, "file")}, subfolders and attachments, and agents using its MCP address stop reaching it.`}
      requireText={folder.name}
      confirmLabel={remove.isPending ? "Deleting…" : "Delete folder"}
      onConfirm={() => {
        if (remove.isPending) return;
        remove.mutate(folder.name, {
          onSuccess: () => {
            if (getLastFolder() === folder.name) setLastFolder(null);
            toast(`Deleted ${folder.name}`, "success");
            onClose();
          },
          onError: (error) => toast(`Could not delete ${folder.name}: ${errorMessage(error)}`),
        });
      }}
    />
  );
}

/**
 * How to point an agent at a folder: the `claude mcp add` command and the `mcpServers` entry, with
 * the stored token in both when the server asks for one.
 */
export function McpConfig({ folder, onClose }: FolderDialogProps) {
  const status = useStatus();
  const origin = window.location.origin;
  const token = status.data?.auth_required ? getToken() : null;
  const command = mcpAddCommand(folder, origin, token);
  const json = mcpJsonEntry(folder, origin, token);

  return (
    <DialogLayout
      open
      onOpenChange={closing(onClose)}
      size="lg"
      title={`Connect an agent to ${folder.title}`}
      description={
        folder.mcp
          ? "Either one adds this folder as its own MCP server."
          : "MCP is off for this folder, so its address answers 404 until you turn it on."
      }
      content={
        <div className="flex flex-col gap-4">
          <Snippet label="Claude Code" text={command} />
          <Snippet label="mcpServers entry" text={json} />
          {status.data?.auth_required ? (
            <p className="text-muted-foreground text-xs">
              {token
                ? "Both include the token stored in this browser. Treat them like a password."
                : "The server asks for a token, and this browser has none stored: add the Authorization header yourself."}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium text-sm">{label}</p>
      <CodeBlock content={text} action={<CopyButton value={text} label={`Copy the ${label}`} />} />
    </div>
  );
}

/**
 * Folders start human-only, so after an upgrade nothing reaches MCP until one is turned on. Said
 * wherever someone might wonder why their agent finds nothing.
 */
export function McpOffHint({ link = true }: { link?: boolean }) {
  const folders = useFolders();
  if (!mcpOffEverywhere(folders.data?.folders)) return null;
  return (
    <Alert
      variant="warning"
      description={
        <>
          MCP is off in every folder, so agents see nothing until one is turned on
          {link ? (
            <>
              {" "}
              in{" "}
              <Link to="/settings" className="underline underline-offset-4">
                Settings
              </Link>
            </>
          ) : null}
          .
        </>
      }
    />
  );
}
