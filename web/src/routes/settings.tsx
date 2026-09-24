import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { CardLayout } from "@/components/card-layout";
import { ConfirmButton } from "@/components/confirm-button";
import { PageLayout } from "@/components/page-layout";
import { QueryError } from "@/components/query-state";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "@/components/ui/icons";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { ThemePicker } from "@/components/ui/theme-picker";
import type { Status } from "@/lib/api";
import { clearToken, getToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useStatus } from "@/lib/queries";

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
        // Under `md` the sidebar is gone, and its Documents link with it.
        <Link to="/" className="inline-flex items-center gap-1 md:hidden">
          <ArrowLeft className="size-3.5" aria-hidden />
          Documents
        </Link>
      }
      content={
        <div className="flex flex-col gap-8 py-6">
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
              label="Docs folder"
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
