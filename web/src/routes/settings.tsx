import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { CardLayout } from "@/components/card-layout";
import { ConfirmButton } from "@/components/confirm-button";
import {
  CreateFolder,
  DeleteFolder,
  McpConfig,
  McpOffHint,
  RenameFolder,
} from "@/components/folder-actions";
import { PageLayout } from "@/components/page-layout";
import { QueryError, QueryState } from "@/components/query-state";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, TriangleAlert } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { ThemePicker } from "@/components/ui/theme-picker";
import { useToast } from "@/components/ui/toast";
import type { Folder, Status } from "@/lib/api";
import { clearToken, getToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useFolders, useStatus, useUpdateFolder } from "@/lib/queries";

/**
 * What this browser remembers, and how the server was started. The server's half is read-only:
 * it comes from environment variables at start, so each row names the variable that changes it.
 */
export function SettingsPage() {
  const status = useStatus();

  useEffect(() => {
    document.title = "Settings · ragdown";
  }, []);

  return (
    <PageLayout
      title="Settings"
      description="How this browser shows ragdown, and how the server is set up."
      width="prose"
      breadcrumbs={
        // Under `md` the sidebar is gone, and its folder links with it.
        <Link to="/" className="inline-flex items-center gap-1 md:hidden">
          <ArrowLeft className="size-3.5" aria-hidden />
          Documents
        </Link>
      }
      content={
        <div className="flex flex-col gap-8 py-6">
          <FoldersSection
            writable={status.data?.ready === true && status.data.read_only === false}
          />
          <Section
            title="This browser"
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
          <Section
            title="Server"
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
        </div>
      }
    />
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

  return (
    <Section
      title="Folders"
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
            <FolderCard key={folder.name} folder={folder} writable={writable} />
          ))}
        </div>
      }
    />
  );
}

function FolderCard({ folder, writable }: { folder: Folder; writable: boolean }) {
  const update = useUpdateFolder();
  const toast = useToast();
  const save = (patch: { title?: string; mcp?: boolean }, done: string) =>
    update.mutate(
      { name: folder.name, patch },
      {
        onSuccess: () => toast(done, "success"),
        onError: (error) => toast(`Could not update ${folder.name}: ${error.message}`),
      },
    );

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
        <div className="flex flex-col">
          <Row
            label="Serve over MCP"
            hint={
              folder.mcp ? (
                <>
                  Agents reach it at <code className="text-xs">{folder.mcp_path}</code>.
                </>
              ) : (
                "Off, it is searchable here but agents never see it."
              )
            }
            value={
              <Switch
                aria-label={`Serve ${folder.title} over MCP`}
                checked={folder.mcp}
                disabled={!writable || update.isPending}
                onCheckedChange={(mcp) =>
                  save({ mcp }, mcp ? `${folder.title} is on MCP` : `${folder.title} is human-only`)
                }
              />
            }
          />
          <Row
            label="Title"
            hint="How the folder is shown here and to agents. Empty, the name."
            value={
              <TitleInput
                folder={folder}
                disabled={!writable || update.isPending}
                onSave={(title) => save({ title }, "Title saved")}
              />
            }
          />
        </div>
      }
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

/** Saved on Enter or on leaving the field; Escape puts the saved title back. */
function TitleInput({
  folder,
  disabled,
  onSave,
}: {
  folder: Folder;
  disabled: boolean;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState(folder.title);
  useEffect(() => setDraft(folder.title), [folder.title]);
  const commit = () => {
    const title = draft.trim();
    if (title === folder.title || (title === "" && folder.title === folder.name)) return;
    onSave(title);
  };
  return (
    <Input
      aria-label={`Title of ${folder.name}`}
      className="h-8 w-48"
      value={draft}
      placeholder={folder.name}
      disabled={disabled}
      onChangeText={setDraft}
      onSubmitEditing={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDraft(folder.title);
      }}
      onBlur={commit}
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
          <div className="flex flex-col">
            <Row label="Token required" value={<YesNo value />} />
            <Row
              label="Stored in this browser"
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
            />
          </div>
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
          <div className="flex flex-col">
            <Row
              label="Docs directory"
              hint={<Env name="RAGDOWN_DOCS_DIR" />}
              value={<code className="break-all text-xs">{status.docs_dir ?? "—"}</code>}
            />
            <Row
              label="Embedder"
              hint={
                <>
                  <Env name="RAGDOWN_EMBEDDER" />. A new one rebuilds the index, and wants its own
                  hook minimum score.
                </>
              }
              value={status.embedder ?? "—"}
            />
            <Row
              label="Role"
              hint={
                status.role === "reader"
                  ? "Another process on this folder owns the index; this one reads it."
                  : "This process owns the index and keeps it in sync with the folder."
              }
              value={status.role ?? "—"}
            />
            <Row
              label="Read-only"
              hint={
                <>
                  <Env name="RAGDOWN_READ_ONLY" />. On, the MCP write tools are hidden.
                </>
              }
              value={status.read_only === undefined ? "—" : <YesNo value={status.read_only} />}
            />
            <Row
              label="Watch the folder"
              hint={
                <>
                  <Env name="RAGDOWN_WATCH" />. Off, the index syncs at start and on{" "}
                  <code>ragdown_reindex</code> only.
                </>
              }
              value={<YesNo value={status.settings.watch} />}
            />
            <Row
              label="Indexed"
              value={
                status.ready
                  ? `${formatCount(status.files ?? 0, "file")} · ${formatCount(status.chunks ?? 0, "chunk")}`
                  : "—"
              }
            />
            <Row
              label="Last sync"
              hint={
                sync
                  ? `${sync.added} added, ${sync.updated} updated, ${sync.removed} removed`
                  : undefined
              }
              value={
                sync ? (
                  <time dateTime={sync.at} title={new Date(sync.at).toLocaleString()}>
                    {formatAgo(Date.parse(sync.at))}
                  </time>
                ) : (
                  "—"
                )
              }
            />
          </div>
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
          What <code>ragdown_context</code> injects before each prompt when the hook passes no
          arguments of its own.
        </>
      }
      loading={loading}
      content={
        settings ? (
          <div className="flex flex-col">
            <Row
              label="Sections per prompt"
              hint={<Env name="RAGDOWN_HOOK_TOP_K" />}
              value={settings.hook.top_k}
            />
            <Row
              label="Minimum score"
              hint={
                <>
                  <Env name="RAGDOWN_HOOK_MIN_SCORE" />. Cosine similarity, on the embedder's own
                  scale.
                </>
              }
              value={settings.hook.min_score}
            />
            <Row
              label="Minimum share of the best hit"
              hint={
                <>
                  <Env name="RAGDOWN_HOOK_MIN_RATIO" />. 0 turns it off.
                </>
              }
              value={settings.hook.min_ratio}
            />
            <Row
              label="Characters per prompt"
              hint={<Env name="RAGDOWN_HOOK_MAX_CHARS" />}
              value={settings.hook.max_chars.toLocaleString()}
            />
            <Row
              label="Characters per search hit"
              hint={
                <>
                  <Env name="RAGDOWN_TEXT_LIMIT" />. For the search tools' text output.
                </>
              }
              value={settings.text_limit.toLocaleString()}
            />
          </div>
        ) : null
      }
    />
  );
}

function Row({
  label,
  hint,
  value,
  action,
}: {
  label: string;
  hint?: ReactNode;
  value: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {hint ? <ItemDescription>{hint}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="max-w-1/2 text-right tabular-nums">
        {value}
        {action}
      </ItemActions>
    </Item>
  );
}

const YesNo = ({ value }: { value: boolean }) => <span>{value ? "Yes" : "No"}</span>;

const Env = ({ name }: { name: string }) => <code className="text-xs">{name}</code>;
