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
import type { Folder, Status } from "@/lib/api";
import { clearToken, getToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useFolders, useStatus, useWritable } from "@/lib/queries";

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
  const writable = useWritable();
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
              <FoldersSection writable={writable} />
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
          {loose.length > 0 ? (
            <Alert
              variant="warning"
              title={`${formatCount(loose.length, "file")} outside every folder ${loose.length === 1 ? "is" : "are"} not indexed`}
              description={
                <>
                  Markdown directly in the docs directory belongs to no folder. Move it into one to
                  index it:{" "}
                  {loose.slice(0, 10).map((file, index) => (
                    <span key={file}>
                      {index > 0 ? ", " : null}
                      <Code>{file}</Code>
                    </span>
                  ))}
                  {loose.length > 10 ? ` and ${loose.length - 10} more` : null}.
                </>
              }
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
      <TableCell className="text-right">
        <ActionButton
          variant="ghost"
          size="icon-sm"
          label={`Copy MCP config for ${folder.title}`}
          onClick={() => onOpen("mcp")}
        >
          <Copy aria-hidden />
        </ActionButton>
        {writable ? (
          <>
            <ActionButton
              variant="ghost"
              size="icon-sm"
              label={`Edit ${folder.title}`}
              onClick={() => onOpen("edit")}
            >
              <Pencil aria-hidden />
            </ActionButton>
            <ActionButton
              variant="ghost"
              size="icon-sm"
              label={`Rename ${folder.name}`}
              onClick={() => onOpen("rename")}
            >
              <FolderPen aria-hidden />
            </ActionButton>
            <ActionButton
              variant="ghost"
              size="icon-sm"
              label={`Delete ${folder.title}`}
              onClick={() => onOpen("delete")}
            >
              <Trash2 className="text-destructive" aria-hidden />
            </ActionButton>
          </>
        ) : null}
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
                    <Code>ragdown_reindex</Code> only.
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

const Env = ({ name }: { name: string }) => <Code>{name}</Code>;
