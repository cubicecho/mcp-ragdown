import { Navigate, useNavigate } from "@tanstack/react-router";
import { CreateFolder } from "@/components/folder-actions";
import { EmptyState } from "@/components/page";
import { QueryError } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Folder, Plus } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getLastFolder } from "@/lib/folders";
import { formatCount } from "@/lib/format";
import { useFolders, useWritable } from "@/lib/queries";

/**
 * `/` is not a page of its own: it opens the folder last used in this browser, else the first one.
 * Only with no folder at all does it draw anything, and then it is the way to make the first.
 */
export function HomePage() {
  const folders = useFolders();
  const writable = useWritable();
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
  return (
    <EmptyState
      className="h-full min-h-60"
      icon={Folder}
      level={1}
      title="No folders yet"
      description={
        <>
          Notes live in top-level folders of the docs directory, each with its own search and its
          own MCP address.
          {loose > 0
            ? ` The ${formatCount(loose, "Markdown file")} directly in the docs directory ${loose === 1 ? "is" : "are"} not indexed until moved into one.`
            : null}
        </>
      }
      action={
        writable ? (
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
        ) : undefined
      }
    />
  );
}
