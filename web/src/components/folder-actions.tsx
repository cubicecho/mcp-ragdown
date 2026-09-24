import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { DialogLayout } from "@/components/dialog-layout";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Check, Copy, TriangleAlert } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { formatCount } from "@/lib/format";
import {
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useStatus,
  useUpdateFolder,
} from "@/lib/queries";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A new top-level folder: the directory and its `.ragdown.json`. Human-only unless MCP is on. */
export function CreateFolder({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated?: (folder: Folder) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [mcp, setMcp] = useState(false);
  const [touched, setTouched] = useState(false);
  const create = useCreateFolder();
  const toast = useToast();

  const invalid = folderNameError(name.trim());
  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setTitle("");
      setMcp(false);
      setTouched(false);
      create.reset();
    }
  };
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    create.mutate(
      { name: name.trim(), ...(title.trim() ? { title: title.trim() } : {}), mcp },
      {
        onSuccess: (folder) => {
          toast(`Created ${folder.title}`, "success");
          reset(false);
          onCreated?.(folder);
        },
      },
    );
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={reset}
      trigger={trigger}
      title="Create folder"
      description="A top-level folder in the docs directory, with its own notes, search and MCP address."
      hasUnsavedChanges={() => name !== "" || title !== ""}
      content={
        <form
          id="create-folder"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label="Name"
            required
            description="The directory's name, and the last part of its MCP address."
            error={(touched && invalid) || (create.error ? message(create.error) : undefined)}
            control={
              <Input
                autoFocus
                placeholder="work"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setTouched(true)}
              />
            }
          />
          <FormField
            label="Title"
            description="How the folder is shown. The name, if left empty."
            control={
              <Input
                placeholder="Work notes"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            }
          />
          <FormField
            orientation="horizontal"
            label="Serve over MCP"
            description="Off, the folder is human-only: searchable here, but agents never see it."
            control={<Switch checked={mcp} onCheckedChange={setMcp} />}
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="create-folder" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </>
      )}
    />
  );
}

/** Rename a folder's directory. Every path in it changes, so it is re-indexed. */
export function RenameFolder({ folder }: { folder: Folder }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(folder.name);
  const update = useUpdateFolder();
  const toast = useToast();
  const invalid = folderNameError(name.trim());
  const unchanged = name.trim() === folder.name;

  const reset = (next: boolean) => {
    setOpen(next);
    setName(folder.name);
    update.reset();
  };
  const submit = () => {
    if (invalid || unchanged) return;
    update.mutate(
      { name: folder.name, patch: { name: name.trim() } },
      {
        onSuccess: (renamed) => {
          if (getLastFolder() === folder.name) setLastFolder(renamed.name);
          toast(`Renamed ${folder.name} to ${renamed.name}`, "success");
          reset(false);
        },
      },
    );
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
          <code>/mcp/{name.trim() || "…"}</code>. Agents set up with the old address stop reaching
          it.
        </>
      }
      hasUnsavedChanges={() => !unchanged}
      content={
        <form
          id="rename-folder"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label="New name"
            required
            error={(!unchanged && invalid) || (update.error ? message(update.error) : undefined)}
            control={
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            }
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="rename-folder"
            disabled={update.isPending || unchanged || Boolean(invalid)}
          >
            {update.isPending ? "Renaming…" : "Rename"}
          </Button>
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
  const [typed, setTyped] = useState("");
  const remove = useDeleteFolder();
  const toast = useToast();
  const matches = typed === folder.name;

  const reset = (next: boolean) => {
    setOpen(next);
    setTyped("");
    remove.reset();
  };
  const submit = () => {
    if (!matches) return;
    remove.mutate(folder.name, {
      onSuccess: () => {
        if (getLastFolder() === folder.name) setLastFolder(null);
        toast(`Deleted ${folder.name}`, "success");
        reset(false);
      },
    });
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
            submit();
          }}
        >
          <FormField
            label={
              <>
                Type <code className="font-mono">{folder.name}</code> to confirm
              </>
            }
            error={remove.error ? message(remove.error) : undefined}
            control={
              <Input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            }
          />
        </form>
      }
      footerActions={(close) => (
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="delete-folder"
            variant="destructive"
            disabled={!matches || remove.isPending}
          >
            {remove.isPending ? "Deleting…" : "Delete folder"}
          </Button>
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
