import { useQuery } from "@tanstack/react-query";
import { getDoc, getStatus, listDocs } from "@/lib/api";

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
