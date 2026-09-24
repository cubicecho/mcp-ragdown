import { Navigate, useNavigate } from "@tanstack/react-router";
import { Folder } from "@/components/app-icons";
import { CreateFolder } from "@/components/folder-actions";
import { QueryError } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getLastFolder } from "@/lib/folders";
import { formatCount } from "@/lib/format";
import { useFolders, useStatus } from "@/lib/queries";

/**
 * `/` is not a page of its own: it opens the folder last used in this browser, else the first one.
 * Only with no folder at all does it draw anything, and then it is the way to make the first.
 */
export function HomePage() {
  const folders = useFolders();
  const status = useStatus();
  const navigate = useNavigate();

  if (folders.isError)
    return (
      <div className="p-6">
        <QueryError
          error={folders.error}
          onRetry={() => void folders.refetch()}
          what="the folders"
        />
      </div>
    );
  if (folders.isPending)
    return (
      <div className="flex flex-col gap-3 p-6" aria-busy>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
    );

  const list = folders.data.folders;
  const last = getLastFolder();
  const pick = list.find((folder) => folder.name === last) ?? list[0];
  if (pick) return <Navigate to="/f/$folder" params={{ folder: pick.name }} replace />;

  const loose = folders.data.loose_files.length;
  const writable = status.data?.ready === true && status.data.read_only === false;
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-8 text-center">
      <Folder className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="font-medium">No folders yet</p>
      <p className="max-w-sm text-muted-foreground text-sm">
        Notes live in top-level folders of the docs directory, each with its own search and its own
        MCP address.
        {loose > 0
          ? ` The ${formatCount(loose, "Markdown file")} directly in the docs directory ${loose === 1 ? "is" : "are"} not indexed until moved into one.`
          : null}
      </p>
      {writable ? (
        <CreateFolder
          trigger={
            <Button>
              <Plus aria-hidden /> Create folder
            </Button>
          }
          onCreated={(folder) =>
            void navigate({ to: "/f/$folder", params: { folder: folder.name } })
          }
        />
      ) : null}
    </div>
  );
}
