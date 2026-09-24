import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteDoc, getDoc, getStatus, listDocs, uploadDoc } from "@/lib/api";

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

export const useDocs = () =>
  useQuery({ queryKey: ["docs"], queryFn: listDocs, refetchInterval: 15_000 });

export const useDoc = (path: string | undefined) =>
  useQuery({
    queryKey: ["doc", path],
    queryFn: () => getDoc(path ?? ""),
    enabled: path !== undefined,
    refetchInterval: 15_000,
  });

/** The server answers a write after the index has synced, so everything it touched is stale. */
function useInvalidateDocs() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [["docs"], ["doc"], ["status"]].map((queryKey) => client.invalidateQueries({ queryKey })),
    );
}

export const useUploadDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: uploadDoc, onSettled: invalidate });
};

export const useDeleteDoc = () => {
  const invalidate = useInvalidateDocs();
  return useMutation({ mutationFn: deleteDoc, onSettled: invalidate });
};
