import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  createFolder,
  deleteDoc,
  deleteFolder,
  getBacklinks,
  getDoc,
  getFile,
  getStatus,
  listDocs,
  listFolders,
  moveDoc,
  resolveLink,
  saveDoc,
  searchDocs,
  updateFolder,
  uploadDoc,
} from "@/lib/api";

/**
 * Polled, because the index follows the folder on its own: a file saved in an editor shows up
 * here without anyone pressing anything. Fast while a sync is running, slow once it is not.
 */
export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: (query) =>
      query.state.data?.syncing || query.state.data?.ready === false ? 2_000 : 15_000,
  });

/** Polled like the docs, so a folder made on disk shows up in the sidebar by itself. */
export const useFolders = () =>
  useQuery({ queryKey: ["folders"], queryFn: listFolders, refetchInterval: 15_000 });

export const useDocs = (folder: string) =>
  useQuery({
    queryKey: ["docs", folder],
    queryFn: () => listDocs(folder),
    refetchInterval: 15_000,
  });

export const useDoc = (path: string | undefined) =>
  useQuery({
    queryKey: ["doc", path],
    queryFn: () => getDoc(path ?? ""),
    enabled: path !== undefined,
    refetchInterval: 15_000,
  });

/** Polled with the doc, since any note in the folder may start or stop linking to it. */
export const useBacklinks = (path: string) =>
  useQuery({
    queryKey: ["backlinks", path],
    queryFn: () => getBacklinks(path),
    refetchInterval: 15_000,
  });

/** Hybrid recall in one folder. Nothing is asked until there is a query. */
export const useSearch = (folder: string, q: string, tag: string | undefined) =>
  useQuery({
    queryKey: ["search", folder, q, tag],
    queryFn: () => searchDocs({ folder, q, tag, top_k: 20 }),
    enabled: q.trim() !== "",
    placeholderData: (previous) => previous,
  });

/** The query behind a wikilink, shared so the click reads what the render already asked. */
export const resolveQuery = (from: string, link: string) => ({
  queryKey: ["resolve", from, link],
  queryFn: () => resolveLink(from, link),
  staleTime: 30_000,
});

export const useResolve = (from: string, link: string) => useQuery(resolveQuery(from, link));

export const fileQuery = (path: string) => ({
  queryKey: ["file", path],
  queryFn: () => getFile(path),
  staleTime: 60_000,
});

/**
 * A file inside a folder as an object URL, for an `<img>`. The URL is made from the fetched blob
 * and revoked when the blob changes or the component goes, so none of them outlive their image.
 */
export function useFileUrl(path: string | undefined) {
  const file = useQuery({ ...fileQuery(path ?? ""), enabled: path !== undefined });
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.data) return;
    const next = URL.createObjectURL(file.data);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(undefined);
    };
  }, [file.data]);
  return { url, isError: file.isError, isPending: file.isPending };
}

/**
 * The server answers a write after the index has synced, so everything it touched is stale.
 *
 * @param gone a path that no longer exists: its queries are left alone rather than refetched into a
 *   404 while the page is still on it.
 */
function useInvalidateDocs() {
  const client = useQueryClient();
  return (gone?: string) =>
    Promise.all(
      [["docs"], ["doc"], ["status"], ["folders"], ["search"], ["resolve"], ["backlinks"]].map(
        (queryKey) =>
          client.invalidateQueries({
            queryKey,
            predicate: (query) => gone === undefined || query.queryKey[1] !== gone,
          }),
      ),
    );
}

export const useUploadDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: uploadDoc, onSettled: () => invalidate() });
};

export const useSaveDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: saveDoc, onSettled: () => invalidate() });
};

export const useMoveDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: moveDoc,
    onSettled: (moved, _error, { from }) => invalidate(moved ? from : undefined),
  });
};

export const useDeleteDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: deleteDoc, onSettled: () => invalidate() });
};

export const useCreateFolder = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: createFolder, onSettled: () => invalidate() });
};

export const useUpdateFolder = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: updateFolder, onSettled: () => invalidate() });
};

export const useDeleteFolder = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: deleteFolder, onSettled: () => invalidate() });
};
