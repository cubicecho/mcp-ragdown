import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { InputField, SwitchField, useAppForm } from "@/components/app-form";
import { DialogLayout } from "@/components/dialog-layout";
import { Button } from "@/components/ui/button";
import { Check, Copy, TriangleAlert } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import type { Folder } from "@/lib/api";
import { getToken } from "@/lib/auth";
import {
  folderNameError,
  getLastFolder,
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

/** Rename a folder's directory. Every path in it changes, so it is re-indexed. */
export function RenameFolder({ folder }: { folder: Folder }) {
  const [open, setOpen] = useState(false);
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
        reset(false);
      } catch (error) {
        form.setFieldMeta("name", serverError(errorMessage(error)));
      }
    },
  });

  const reset = (next: boolean) => {
    setOpen(next);
    form.reset({ name: folder.name });
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={
        <Button variant="outline" size="sm">
          Rename
        </Button>
      }
      title={`Rename ${folder.name}`}
      description={
        <>
          Renames the directory, re-indexes it, and moves its MCP address to{" "}
          <form.Subscribe selector={(state) => state.values.name.trim()}>
            {(name) => <code>/mcp/{name || "…"}</code>}
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
export function DeleteFolder({ folder }: { folder: Folder }) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteFolder();
  const toast = useToast();
  const form = useAppForm({
    defaultValues: { typed: "" },
    onSubmit: async () => {
      try {
        await remove.mutateAsync(folder.name);
        if (getLastFolder() === folder.name) setLastFolder(null);
        toast(`Deleted ${folder.name}`, "success");
        reset(false);
      } catch (error) {
        form.setFieldMeta("typed", serverError(errorMessage(error)));
      }
    },
  });

  const reset = (next: boolean) => {
    setOpen(next);
    form.reset();
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={
        <Button variant="outline" size="sm" className="text-destructive">
          Delete
        </Button>
      }
      title={`Delete ${folder.title}?`}
      description={`The ${folder.name} directory is deleted from disk with its ${formatCount(folder.files, "file")}, subfolders and attachments, and agents using its MCP address stop reaching it.`}
      content={
        <form
          id="delete-folder"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <InputField
            form={form}
            name="typed"
            label={
              <>
                Type <code className="font-mono">{folder.name}</code> to confirm
              </>
            }
            autoFocus
            autoComplete="off"
            spellCheck={false}
            listeners={{ onChange: () => form.setFieldMeta("typed", serverError(undefined)) }}
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <form.AppForm>
            <form.Subscribe selector={(state) => state.values.typed === folder.name}>
              {(matches) => (
                <form.SubmitButton
                  form="delete-folder"
                  variant="destructive"
                  pendingLabel="Deleting…"
                  disabled={!matches}
                >
                  Delete folder
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
 * How to point an agent at a folder: the `claude mcp add` command and the `mcpServers` entry, with
 * the stored token in both when the server asks for one.
 */
export function McpConfig({ folder }: { folder: Folder }) {
  const status = useStatus();
  const origin = window.location.origin;
  const token = status.data?.auth_required ? getToken() : null;
  const command = mcpAddCommand(folder, origin, token);
  const json = mcpJsonEntry(folder, origin, token);

  return (
    <DialogLayout
      trigger={
        <Button variant="outline" size="sm">
          <Copy aria-hidden /> Copy MCP config
        </Button>
      }
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-sm">{label}</p>
        <ActionButton
          variant="ghost"
          size="icon-sm"
          label={copied ? "Copied" : `Copy the ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </ActionButton>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs [overflow-wrap:normal]">
        {text}
      </pre>
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
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
      <span>
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
      </span>
    </p>
  );
}
