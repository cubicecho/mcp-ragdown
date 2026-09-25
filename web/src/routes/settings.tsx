import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { InputField, SwitchField, useAppForm } from "@/components/app-form";
import { CardLayout } from "@/components/card-layout";
import { ConfirmButton } from "@/components/confirm-button";
import { DescriptionList, PropertyRow } from "@/components/description-list";
import {
  CreateFolder,
  DeleteFolder,
  McpConfig,
  McpOffHint,
  RenameFolder,
} from "@/components/folder-actions";
import { LeaveDialog } from "@/components/leave-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryError, QueryState } from "@/components/query-state";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, TriangleAlert } from "@/components/ui/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemePicker } from "@/components/ui/theme-picker";
import { useToast } from "@/components/ui/toast";
import type { Folder, Status } from "@/lib/api";
import { clearToken, getToken, requireAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/form-errors";
import { formatAgo, formatCount } from "@/lib/format";
import { useFolders, useStatus, useUpdateFolder } from "@/lib/queries";

export type SettingsTab = "folders" | "browser" | "server";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "folders", label: "Folders" },
  { value: "browser", label: "This browser" },
  { value: "server", label: "Server" },
];

/**
 * The folders, what this browser remembers, and how the server was started, one tab each. The
 * server's tab is read-only: it comes from environment variables at start, so each row names the
 * variable that changes it. The open tab is in the URL, so a link can land on one.
 */
export function SettingsPage() {
  const status = useStatus();
  const { tab = "folders" } = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });

  useEffect(() => {
    document.title = "Settings · ragdown";
  }, []);

  return (
    // The root wraps the page so the list in the header and the panels in the body are one set.
    <Tabs
      className="h-full"
      value={tab}
      onValueChange={(next) =>
        void navigate({
          search: next === "folders" ? {} : { tab: next as SettingsTab },
          replace: true,
        })
      }
    >
      <PageLayout
        title="Settings"
        description="Folders, how this browser shows ragdown, and how the server is set up."
        width="prose"
        breadcrumbs={
          // Under `md` the sidebar is gone, and its folder links with it.
          <Link to="/" className="inline-flex items-center gap-1 md:hidden">
            <ArrowLeft className="size-3.5" aria-hidden />
            Documents
          </Link>
        }
        headerContent={
          <TabsList aria-label="Settings" className="self-start">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        content={
          <div className="py-6">
            <TabsContent value="folders" className="mt-0">
              <FoldersSection
                writable={status.data?.ready === true && status.data.read_only === false}
              />
            </TabsContent>
            <TabsContent value="browser" className="mt-0">
              <Section
                description="Kept in this browser's storage. Other browsers keep their own."
                content={
                  <div className="flex flex-col gap-4">
                    <CardLayout
                      title="Appearance"
                      description="System follows the device's light or dark setting."
                      // Uncontrolled: bound to the same stored preference as the sidebar's toggle.
                      content={<ThemePicker />}
                    />
                    <AccessCard status={status.data} loading={status.isPending} />
                  </div>
                }
              />
            </TabsContent>
            <TabsContent value="server" className="mt-0">
              <Section
                description="Read from environment variables when the server starts. Change one and restart the server to apply it."
                content={
                  status.isError ? (
                    <QueryError
                      error={status.error}
                      onRetry={status.refetch}
                      what="the server status"
                    />
                  ) : (
                    <div className="flex flex-col gap-4">
                      <ServerCard status={status.data} loading={status.isPending} />
                      <HookCard status={status.data} loading={status.isPending} />
                    </div>
                  )
                }
              />
            </TabsContent>
          </div>
        }
      />
    </Tabs>
  );
}

/**
 * The folders are the one thing set from here rather than the environment: each one's
 * `.ragdown.json` holds its title and whether MCP serves it, and the server reads it back.
 */
function FoldersSection({ writable }: { writable: boolean }) {
  const folders = useFolders();
  const navigate = useNavigate();
  const loose = folders.data?.loose_files ?? [];
  // The folders with unsaved edits. One blocker for the section rather than one per card, so
  // leaving asks once however many cards are part-edited.
  const unsaved = useRef(new Set<string>());
  const onDirty = (name: string, dirty: boolean) => {
    if (dirty) unsaved.current.add(name);
    else unsaved.current.delete(name);
  };
  const blocker = useBlocker({
    shouldBlockFn: () => unsaved.current.size > 0,
    enableBeforeUnload: () => unsaved.current.size > 0,
    withResolver: true,
  });

  return (
    <Section
      description="Top-level folders of the docs directory. Each has its own search, and its own MCP address while MCP is on for it."
      action={
        writable ? (
          <CreateFolder
            trigger={
              <Button variant="outline" size="sm">
                <Plus aria-hidden /> Create folder
              </Button>
            }
            onCreated={(folder) =>
              void navigate({ to: "/f/$folder", params: { folder: folder.name } })
            }
          />
        ) : undefined
      }
      content={
        <div className="flex flex-col gap-4">
          <McpOffHint link={false} />
          {loose.length > 0 ? (
            <div
              role="note"
              className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
            >
              <p className="flex items-center gap-2 font-medium">
                <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden />
                {formatCount(loose.length, "file")} outside every folder{" "}
                {loose.length === 1 ? "is" : "are"} not indexed
              </p>
              <p className="text-muted-foreground">
                Markdown directly in the docs directory belongs to no folder. Move it into one to
                index it.
              </p>
              <ul className="font-mono">
                {loose.slice(0, 10).map((file) => (
                  <li key={file} className="truncate">
                    {file}
                  </li>
                ))}
                {loose.length > 10 ? <li>and {loose.length - 10} more</li> : null}
              </ul>
            </div>
          ) : null}
          <QueryState
            query={folders}
            what="the folders"
            count={folders.data?.folders.length ?? 0}
            rows={2}
            empty={
              <p className="py-4 text-center text-muted-foreground text-sm">
                No folders yet. Make one, or add a directory to the docs directory.
              </p>
            }
          />
          {folders.data?.folders.map((folder) => (
            <FolderCard key={folder.name} folder={folder} writable={writable} onDirty={onDirty} />
          ))}
          <LeaveDialog
            open={blocker.status === "blocked"}
            description="A folder's settings have changes that are not saved, and leaving throws them away."
            onStay={() => blocker.reset?.()}
            onLeave={() => blocker.proceed?.()}
          />
        </div>
      }
    />
  );
}

/**
 * A folder's settings as one form: change the title and the MCP switch, then Save sends both.
 * Nothing is saved on leaving a field, so a half-typed title never reaches agents.
 */
/** What a save sends: only what differs. An empty title means the name, as an untitled folder shows. */
function folderPatch(folder: Folder, values: { title: string; mcp: boolean }) {
  const title = values.title.trim();
  return {
    ...((title || folder.name) !== folder.title ? { title } : {}),
    ...(values.mcp !== folder.mcp ? { mcp: values.mcp } : {}),
  };
}

/** Tells the section whether a card has unsaved changes, and takes it back when the card goes. */
function ReportDirty({
  name,
  dirty,
  onDirty,
}: {
  name: string;
  dirty: boolean;
  onDirty: (name: string, dirty: boolean) => void;
}) {
  useEffect(() => {
    onDirty(name, dirty);
    return () => onDirty(name, false);
  }, [onDirty, name, dirty]);
  return null;
}

function FolderCard({
  folder,
  writable,
  onDirty,
}: {
  folder: Folder;
  writable: boolean;
  onDirty: (name: string, dirty: boolean) => void;
}) {
  const update = useUpdateFolder();
  const toast = useToast();
  const saved = { title: folder.title, mcp: folder.mcp };
  const form = useAppForm({
    defaultValues: saved,
    onSubmit: async ({ value }) => {
      const patch = folderPatch(folder, value);
      try {
        await update.mutateAsync({ name: folder.name, patch });
        toast(`Saved ${value.title.trim() || folder.name}`, "success");
      } catch (error) {
        toast(`Could not update ${folder.name}: ${errorMessage(error)}`);
      }
    },
  });
  // A save, or a change from another tab, lands here as the new starting point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the saved values are the trigger.
  useEffect(() => {
    form.reset({ title: folder.title, mcp: folder.mcp });
  }, [folder.title, folder.mcp]);
  const formId = `folder-${folder.name}`;
  const disabled = !writable || update.isPending;
  const reset = () => form.reset(saved);

  return (
    <CardLayout
      title={
        <Link
          to="/f/$folder"
          params={{ folder: folder.name }}
          className="hover:underline hover:underline-offset-4"
        >
          {folder.title}
        </Link>
      }
      description={
        <>
          <code className="text-xs">{folder.name}</code> · {formatCount(folder.files, "file")} ·{" "}
          {formatCount(folder.chunks, "chunk")}
        </>
      }
      action={
        <Badge variant={folder.mcp ? "secondary" : "outline"}>
          {folder.mcp ? "MCP" : "Human-only"}
        </Badge>
      }
      content={
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") reset();
          }}
        >
          <InputField
            form={form}
            name="title"
            label="Title"
            description="How the folder is shown here and to agents. The name, if left empty."
            placeholder={folder.name}
            disabled={disabled}
          />
          <form.Subscribe selector={(state) => state.values.mcp}>
            {(mcp) => (
              <SwitchField
                form={form}
                name="mcp"
                label="Serve over MCP"
                disabled={disabled}
                description={
                  mcp ? (
                    <>
                      Agents reach it at <code className="text-xs">{folder.mcp_path}</code>.
                    </>
                  ) : (
                    "Off, it is searchable here but agents never see it."
                  )
                }
              />
            )}
          </form.Subscribe>
          <form.Subscribe
            selector={(state) => Object.keys(folderPatch(folder, state.values)).length > 0}
          >
            {(dirty) => (
              <>
                <ReportDirty name={folder.name} dirty={dirty} onDirty={onDirty} />
                {writable ? (
                  <div className="flex items-center justify-end gap-2">
                    {dirty ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={reset}
                      >
                        Reset
                      </Button>
                    ) : null}
                    <form.AppForm>
                      <form.SubmitButton disabled={!dirty}>Save</form.SubmitButton>
                    </form.AppForm>
                  </div>
                ) : null}
              </>
            )}
          </form.Subscribe>
        </form>
      }
      // The shell's action row does not wrap, and three buttons outrun a phone's card.
      footerClassName="[&>div]:min-w-0 [&>div]:shrink [&>div]:flex-wrap [&>div]:justify-end"
      footerActions={
        <>
          <McpConfig folder={folder} />
          {writable ? (
            <>
              <RenameFolder folder={folder} />
              <DeleteFolder folder={folder} />
            </>
          ) : null}
        </>
      }
    />
  );
}

function AccessCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  // Read at render: forgetting the token hands the whole app to the token gate, so nothing here
  // needs to redraw after it.
  const [stored] = useState(() => getToken() !== null);

  return (
    <CardLayout
      title="Access"
      description={
        status && !status.auth_required
          ? "This server runs with SECURE_LOCAL_NET=true, so it asks for no token: anyone who can reach it can read the notes."
          : "The server asks for the token set in RAGDOWN_TOKEN. This browser keeps it after you enter it once."
      }
      loading={loading}
      content={
        status?.auth_required ? (
          <DescriptionList
            content={[
              <PropertyRow key="required" label="Token required" value={<YesNo value />} />,
              <PropertyRow
                key="stored"
                label="Stored here"
                value={<YesNo value={stored} />}
                action={
                  <ConfirmButton
                    label="Forget token"
                    variant="outline"
                    size="sm"
                    tooltip={false}
                    disabled={!stored}
                    title="Forget the token?"
                    description="This browser stops sending it, and asks for it again before it shows anything. Keep a copy: the server cannot show it to you."
                    confirmLabel="Forget"
                    onConfirm={() => {
                      clearToken();
                      requireAuth();
                    }}
                  >
                    Forget token
                  </ConfirmButton>
                }
              />,
            ]}
          />
        ) : null
      }
    />
  );
}

function ServerCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  const sync = status?.last_sync;
  return (
    <CardLayout
      title="Index"
      description={status ? `${status.name} ${status.version}` : undefined}
      action={
        status ? (
          <Badge variant={status.ready ? "secondary" : "outline"}>
            {!status.ready ? "Loading the model" : status.syncing ? "Indexing" : "Ready"}
          </Badge>
        ) : null
      }
      loading={loading}
      content={
        status ? (
          <DescriptionList
            content={[
              <PropertyRow
                key="docs"
                label="Docs directory"
                value={
                  <code className="break-all text-xs leading-5">{status.docs_dir ?? "—"}</code>
                }
                hint={<Env name="RAGDOWN_DOCS_DIR" />}
              />,
              <PropertyRow
                key="embedder"
                label="Embedder"
                value={status.embedder ?? "—"}
                hint={
                  <>
                    <Env name="RAGDOWN_EMBEDDER" />. A new one rebuilds the index, and wants its own
                    hook minimum score.
                  </>
                }
              />,
              <PropertyRow
                key="role"
                label="Role"
                value={status.role ?? "—"}
                hint={
                  status.role === "reader"
                    ? "Another process owns the index; this one reads it."
                    : "This process owns the index and keeps it in sync."
                }
              />,
              <PropertyRow
                key="read-only"
                label="Read-only"
                value={status.read_only === undefined ? "—" : <YesNo value={status.read_only} />}
                hint={
                  <>
                    <Env name="RAGDOWN_READ_ONLY" />. On, the MCP write tools are hidden.
                  </>
                }
              />,
              <PropertyRow
                key="watch"
                label="Watch for changes"
                value={<YesNo value={status.settings.watch} />}
                hint={
                  <>
                    <Env name="RAGDOWN_WATCH" />. Off, the index syncs at start and on{" "}
                    <code className="text-xs">ragdown_reindex</code> only.
                  </>
                }
              />,
              <PropertyRow
                key="indexed"
                label="Indexed"
                value={
                  status.ready
                    ? `${formatCount(status.files ?? 0, "file")} · ${formatCount(status.chunks ?? 0, "chunk")}`
                    : "—"
                }
              />,
              <PropertyRow
                key="sync"
                label="Last sync"
                value={
                  sync ? (
                    <time dateTime={sync.at} title={new Date(sync.at).toLocaleString()}>
                      {formatAgo(Date.parse(sync.at))}
                    </time>
                  ) : (
                    "—"
                  )
                }
                hint={
                  sync
                    ? `${sync.added} added, ${sync.updated} updated, ${sync.removed} removed`
                    : undefined
                }
              />,
            ]}
          />
        ) : null
      }
    />
  );
}

function HookCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  const settings = status?.settings;
  return (
    <CardLayout
      title="Search defaults"
      description={
        <>
          What <code className="text-xs">ragdown_context</code> injects before each prompt when the
          hook passes no arguments of its own.
        </>
      }
      loading={loading}
      content={
        settings ? (
          <DescriptionList
            content={[
              <PropertyRow
                key="top-k"
                label="Sections per prompt"
                value={settings.hook.top_k}
                hint={<Env name="RAGDOWN_HOOK_TOP_K" />}
              />,
              <PropertyRow
                key="min-score"
                label="Minimum score"
                value={settings.hook.min_score}
                hint={
                  <>
                    <Env name="RAGDOWN_HOOK_MIN_SCORE" />. Cosine similarity, on the embedder's own
                    scale.
                  </>
                }
              />,
              <PropertyRow
                key="min-ratio"
                label="Share of the best hit"
                value={settings.hook.min_ratio}
                hint={
                  <>
                    <Env name="RAGDOWN_HOOK_MIN_RATIO" />. The least a hit may score against the
                    best one; 0 turns it off.
                  </>
                }
              />,
              <PropertyRow
                key="max-chars"
                label="Characters per prompt"
                value={settings.hook.max_chars.toLocaleString()}
                hint={<Env name="RAGDOWN_HOOK_MAX_CHARS" />}
              />,
              <PropertyRow
                key="text-limit"
                label="Characters per hit"
                value={settings.text_limit.toLocaleString()}
                hint={
                  <>
                    <Env name="RAGDOWN_TEXT_LIMIT" />. For the search tools' text output.
                  </>
                }
              />,
            ]}
          />
        ) : null
      }
    />
  );
}

const YesNo = ({ value }: { value: boolean }) => <span>{value ? "Yes" : "No"}</span>;

const Env = ({ name }: { name: string }) => <code className="text-xs">{name}</code>;
