import { Link, Outlet } from "@tanstack/react-router";
import { FileText, Library, Lock } from "lucide-react";
import { ActionButton } from "@/components/action-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { clearToken, requireAuth } from "@/lib/auth";
import { formatAgo, formatCount } from "@/lib/format";
import { useStatus } from "@/lib/queries";

const NAV = [{ to: "/", label: "Documents", icon: FileText }] as const;

/** What the index is doing, at the foot of the sidebar: the one thing every page wants to know. */
function IndexStatus() {
  const status = useStatus();
  const data = status.data;

  if (status.isPending) return <Skeleton className="h-8 w-full" />;
  if (!data) return <p className="text-destructive text-xs">Server unreachable</p>;

  const line = !data.ready
    ? "Loading the model…"
    : data.syncing
      ? "Indexing…"
      : data.last_sync
        ? `Synced ${formatAgo(Date.parse(data.last_sync.at))}`
        : data.role === "reader"
          ? "Reading another process's index"
          : "Idle";

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium" role="status">
        <span
          aria-hidden
          className={
            data.ready && !data.syncing
              ? "size-1.5 rounded-full bg-emerald-500"
              : "size-1.5 animate-pulse rounded-full bg-amber-500"
          }
        />
        {line}
      </p>
      {data.ready ? (
        <p className="text-muted-foreground">
          {formatCount(data.files ?? 0, "file")} · {formatCount(data.chunks ?? 0, "chunk")}
        </p>
      ) : null}
      {data.embedder ? (
        <p className="truncate text-muted-foreground" title={data.docs_dir}>
          {data.embedder}
        </p>
      ) : null}
    </div>
  );
}

function LockButton() {
  const status = useStatus();
  if (!status.data?.auth_required) return null;
  return (
    <ActionButton
      variant="ghost"
      size="icon-sm"
      label="Lock"
      hint="Forget the stored token"
      side="right"
      onClick={() => {
        clearToken();
        requireAuth();
      }}
    >
      <Lock aria-hidden />
    </ActionButton>
  );
}

export function AppShell() {
  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-4 py-4 font-semibold text-sm tracking-tight">
          <Library className="size-4 shrink-0" aria-hidden />
          ragdown
        </div>
        <nav className="flex flex-col gap-1 px-2" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              activeProps={{ className: "bg-accent font-medium text-accent-foreground" }}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t px-4 py-3">
          <IndexStatus />
          <div className="flex items-center gap-1">
            <div className="flex-1">
              <ThemeToggle />
            </div>
            <LockButton />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Under `md` the sidebar's furniture moves to a bar: one destination needs no rail. */}
        <header className="flex items-center gap-2 border-b px-4 py-2 md:hidden">
          <Library className="size-4 shrink-0" aria-hidden />
          <span className="font-semibold text-sm">ragdown</span>
          <div className="ml-auto flex items-center gap-1">
            <LockButton />
            <div className="w-24">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto md:overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
