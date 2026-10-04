import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { FolderPen } from "@/components/app-icons";
import { CardLayout } from "@/components/card-layout";
import { ConfirmButton } from "@/components/confirm-button";
import { DescriptionList, PropertyRow } from "@/components/description-list";
import {
  CreateFolder,
  DeleteFolder,
  EditFolder,
  McpConfig,
  McpOffHint,
  RenameFolder,
} from "@/components/folder-actions";
import { EmptyState } from "@/components/page";
import { PageLayout } from "@/components/page-layout";
import { QueryError, QueryState } from "@/components/query-state";
import { Section } from "@/components/section";
import { EditServerSettings } from "@/components/server-settings";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { ArrowLeft, Copy, Folder as FolderIcon, Pencil, Plus, Trash2 } from "@/components/ui/icons";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemePicker } from "@/components/ui/theme-picker";
import { useToast } from "@/components/ui/toast";
import type { Folder, Status } from "@/lib/api";
import { clearToken, getToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useDeleteLooseFile, useFolders, useStatus, useWritable } from "@/lib/queries";

export type SettingsTab = "folders" | "device" | "server";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "folders", label: "Folders" },
  { value: "device", label: "This device" },
  { value: "server", label: "Server" },
];

/**
 * The folders, what this device remembers, and how the server is set up, one tab each. The
 * server's settings start as environment variables, so each row names its variable; the ones that
 * can change while it runs are edited here, and a value saved here wins over its variable. The open
 * tab is in the URL, so a link can land on one.
 */
export function SettingsPage() {
  const status = useStatus();
  const writable = useWritable();
  const { tab = "folders" } = useSearch({ from: "/settings" });
  const [editing, setEditing] = useState(false);
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
        description="Folders, how this device shows ragdown, and how the server is set up."
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
              <FoldersSection writable={writable} />
            </TabsContent>
            <TabsContent value="device" className="mt-0">
              <Section
                description="Kept on this device, in this browser's storage. Other devices and browsers keep their own."
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
                description="What the index is doing, then how the server is set up. Each setting starts as an environment variable; the embedder, watching and the search defaults can be changed here, and a value saved here wins over its variable."
                action={
                  writable && status.data ? (
                    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                      <Pencil />
                      Edit settings
                    </Button>
                  ) : null
                }
                content={
                  status.isError ? (
                    <QueryError
                      error={status.error}
                      onRetry={status.refetch}
                      what="the server status"
                    />
                  ) : (
                    <div className="flex flex-col gap-4">
                      <IndexStatusCard status={status.data} loading={status.isPending} />
                      <IndexSettingsCard status={status.data} loading={status.isPending} />
                      <HookCard status={status.data} loading={status.isPending} />
                    </div>
                  )
                }
              />
              {editing && status.data ? (
                <EditServerSettings
                  settings={status.data.settings}
                  onClose={() => setEditing(false)}
                />
              ) : null}
            </TabsContent>
          </div>
        }
      />
    </Tabs>
  );
}

/** Which of a folder's dialogs is up. By name, so the dialog reads the folder as it now is. */
type FolderDialog = { kind: "mcp" | "edit" | "rename" | "delete"; name: string };

/**
 * The folders are the one thing set from here rather than the environment: each one's
 * `.ragdown.json` holds its title, whether MCP serves it and its own search defaults, and the
 * server reads it back. A row shows a folder; every change to one is a dialog opened from it.
 */
function FoldersSection({ writable }: { writable: boolean }) {
  const folders = useFolders();
  const navigate = useNavigate();
  const loose = folders.data?.loose_files ?? [];
  const list = folders.data?.folders ?? [];
  const unrelated = useStatus().data?.settings.hook.unrelated_score;
  const lowScore = list.filter((folder) => scoreTooLow(folder.hook.min_score, unrelated));
  const [dialog, setDialog] = useState<FolderDialog | null>(null);
  const open = dialog ? list.find((folder) => folder.name === dialog.name) : undefined;
  const close = () => setDialog(null);

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
          {loose.length > 0 ? <LooseFiles files={loose} writable={writable} /> : null}
          {lowScore.length > 0 ? (
            <Alert
              variant="warning"
              title={`${lowScore.map((folder) => folder.title).join(", ")}: the minimum score is too low`}
              description={`An unrelated prompt scores up to ${unrelated} on this embedder, so a minimum score at or under that injects notes into prompts they have nothing to do with. Edit the folder and clear its minimum score, or raise it.`}
            />
          ) : null}
          <QueryState
            query={folders}
            what="the folders"
            count={list.length}
            rows={2}
            empty={
              <EmptyState
                icon={FolderIcon}
                title="No folders yet"
                description="Make one, or add a directory to the docs directory."
              />
            }
          />
          {list.length > 0 ? (
            <Table>
              <TableCaption className="sr-only">Folders</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Folder</TableHead>
                  <TableHead className="hidden sm:table-cell">Notes</TableHead>
                  <TableHead>Agents</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((folder) => (
                  <FolderRow
                    key={folder.name}
                    folder={folder}
                    writable={writable}
                    onOpen={(kind) => setDialog({ kind, name: folder.name })}
                  />
                ))}
              </TableBody>
            </Table>
          ) : null}
          {open && dialog?.kind === "mcp" ? <McpConfig folder={open} onClose={close} /> : null}
          {open && dialog?.kind === "edit" ? <EditFolder folder={open} onClose={close} /> : null}
          {open && dialog?.kind === "rename" ? (
            <RenameFolder folder={open} onClose={close} />
          ) : null}
          {open && dialog?.kind === "delete" ? (
            <DeleteFolder folder={open} onClose={close} />
          ) : null}
        </div>
      }
    />
  );
}

/** True when a `ragdown_context` floor is at or under what an unrelated prompt scores. */
const scoreTooLow = (minScore: number | undefined, unrelated: number | null | undefined) =>
  typeof minScore === "number" && typeof unrelated === "number" && minScore <= unrelated;

/**
 * The warning about Markdown outside every folder, and under it the files themselves, each with
 * its own delete while the server takes writes: a stray file is otherwise only fixable on disk.
 */
function LooseFiles({ files, writable }: { files: string[]; writable: boolean }) {
  const remove = useDeleteLooseFile();
  const toast = useToast();
  return (
    <div className="flex flex-col gap-2">
      <Alert
        variant="warning"
        title={`${formatCount(files.length, "file")} outside every folder ${files.length === 1 ? "is" : "are"} not indexed`}
        description={`Markdown directly in the docs directory belongs to no folder. Move it into one to index it${writable ? ", or delete it here" : ""}.`}
      />
      <ul
        aria-label="Files outside every folder"
        className="flex flex-col divide-y rounded-lg border"
      >
        {files.map((file) => (
          <li key={file} className="flex min-h-11 items-center justify-between gap-2 px-3 py-1.5">
            <Code className="min-w-0 truncate">{file}</Code>
            {writable ? (
              <ConfirmButton
                label={`Delete ${file}`}
                variant="outline"
                size="icon-xs"
                disabled={remove.isPending}
                title={`Delete ${file}?`}
                description={`${file} is deleted from the docs directory on disk. It was never indexed, so no folder or agent loses anything.`}
                onConfirm={() =>
                  remove.mutate(file, {
                    onSuccess: () => toast(`Deleted ${file}`, "success"),
                    onError: (error) => toast(`Could not delete ${file}: ${error.message}`),
                  })
                }
              >
                <Trash2 className="text-destructive" aria-hidden />
              </ConfirmButton>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FolderRow({
  folder,
  writable,
  onOpen,
}: {
  folder: Folder;
  writable: boolean;
  onOpen: (kind: FolderDialog["kind"]) => void;
}) {
  return (
    <TableRow>
      <TableHead className="h-auto py-2 font-medium">
        <Link
          to="/f/$folder"
          params={{ folder: folder.name }}
          className="hover:underline hover:underline-offset-4"
        >
          {folder.title}
        </Link>
        <code className="block font-normal text-muted-foreground text-xs">{folder.name}</code>
      </TableHead>
      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {formatCount(folder.files, "file")} · {formatCount(folder.chunks, "chunk")}
      </TableCell>
      <TableCell>
        <Badge variant={folder.mcp ? "secondary" : "outline"}>
          {folder.mcp ? "MCP" : "Human-only"}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <ActionButton
            variant="outline"
            size="icon-sm"
            label={`Copy MCP config for ${folder.title}`}
            onClick={() => onOpen("mcp")}
          >
            <Copy aria-hidden />
          </ActionButton>
          {writable ? (
            <>
              <ActionButton
                variant="outline"
                size="icon-sm"
                label={`Edit ${folder.title}`}
                onClick={() => onOpen("edit")}
              >
                <Pencil aria-hidden />
              </ActionButton>
              <ActionButton
                variant="outline"
                size="icon-sm"
                label={`Rename ${folder.name}`}
                onClick={() => onOpen("rename")}
              >
                <FolderPen aria-hidden />
              </ActionButton>
              <ActionButton
                variant="outline"
                size="icon-sm"
                label={`Delete ${folder.title}`}
                onClick={() => onOpen("delete")}
              >
                <Trash2 className="text-destructive" aria-hidden />
              </ActionButton>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
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
          : "The server asks for the token set in RAGDOWN_TOKEN. This device keeps it after you enter it once."
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
                    description="This device stops sending it, and asks for it again before it shows anything. Keep a copy: the server cannot show it to you."
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

/** What the index is doing now: nothing here is set, so no row names a variable. */
function IndexStatusCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  const sync = status?.last_sync;
  return (
    <CardLayout
      title="Index status"
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
            ]}
          />
        ) : null
      }
    />
  );
}

/** How the index is set up: each row names its variable, and says when a saved value overrides it. */
function IndexSettingsCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  return (
    <CardLayout
      title="Index settings"
      description="What is indexed, with which model, and how it is kept in sync."
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
                    <Env
                      name="RAGDOWN_EMBEDDER"
                      saved={status.settings.saved.embedder !== undefined}
                    />
                    . A new one rebuilds the index, and wants its own hook minimum score.
                  </>
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
                    <Env name="RAGDOWN_WATCH" saved={status.settings.saved.watch !== undefined} />.
                    Off, the index syncs at start and on <Code>ragdown_reindex</Code> only.
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

function HookCard({ status, loading }: { status: Status | undefined; loading: boolean }) {
  const settings = status?.settings;
  const saved = settings?.saved.hook;
  return (
    <CardLayout
      title="Search defaults"
      description={
        <>
          What <Code>ragdown_context</Code> injects before each prompt when the hook passes no
          arguments of its own. A folder can set its own under Folders.
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
                hint={<Env name="RAGDOWN_HOOK_TOP_K" saved={saved?.top_k !== undefined} />}
              />,
              <PropertyRow
                key="min-score"
                label="Minimum score"
                value={settings.hook.min_score}
                hint={
                  <>
                    <Env name="RAGDOWN_HOOK_MIN_SCORE" saved={saved?.min_score !== undefined} />.
                    Cosine similarity, on the embedder's own scale.
                    {scoreTooLow(settings.hook.min_score, settings.hook.unrelated_score) ? (
                      <span className="text-destructive">
                        {" "}
                        Too low: an unrelated prompt scores up to {settings.hook.unrelated_score} on
                        this embedder, so notes are injected into prompts they have nothing to do
                        with. Leave it unset to use the embedder's own.
                      </span>
                    ) : null}
                  </>
                }
              />,
              <PropertyRow
                key="min-ratio"
                label="Share of the best hit"
                value={settings.hook.min_ratio}
                hint={
                  <>
                    <Env name="RAGDOWN_HOOK_MIN_RATIO" saved={saved?.min_ratio !== undefined} />.
                    The least a hit may score against the best one; 0 turns it off.
                  </>
                }
              />,
              <PropertyRow
                key="max-chars"
                label="Characters per prompt"
                value={settings.hook.max_chars.toLocaleString()}
                hint={<Env name="RAGDOWN_HOOK_MAX_CHARS" saved={saved?.max_chars !== undefined} />}
              />,
              <PropertyRow
                key="text-limit"
                label="Characters per hit"
                value={settings.text_limit.toLocaleString()}
                hint={
                  <>
                    <Env
                      name="RAGDOWN_TEXT_LIMIT"
                      saved={settings.saved.text_limit !== undefined}
                    />
                    . For the search tools' text output.
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

/** The variable a setting starts from, and whether a value saved here has taken its place. */
const Env = ({ name, saved = false }: { name: string; saved?: boolean }) =>
  saved ? (
    <>
      Saved here, over <Code>{name}</Code>
    </>
  ) : (
    <Code>{name}</Code>
  );
