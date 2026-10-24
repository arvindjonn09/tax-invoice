"use client";
import { useEffect, useState } from "react";

/** Safety cap: 50 pages of 100 rows. */
const MAX_PAGES = 50;

/**
 * Every row of a paged list (`?page`, `pageSize=100`), fetched page by page.
 * Allocation screens filter what's owing in the browser, so they must see
 * all of a customer's invoices or a supplier's bills, not just the newest
 * page. `truncated` is true if the cap was hit.
 */
export function useAllPages<T>(url: string | null, key: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    revision: number;
    rows?: T[];
    truncated?: boolean;
    error?: string;
  }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void (async () => {
      const rows: T[] = [];
      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const separator = url.includes("?") ? "&" : "?";
          const response = await fetch(
            `${url}${separator}page=${page}&pageSize=100`,
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error(String(response.status));
          const body = (await response.json()) as Record<string, unknown> & {
            total: number;
            pageSize: number;
          };
          rows.push(...((body[key] as T[] | undefined) ?? []));
          if (page * body.pageSize >= body.total) {
            setResult({ url, revision, rows, truncated: false });
            return;
          }
        }
        setResult({ url, revision, rows, truncated: true });
      } catch {
        if (controller.signal.aborted) return;
        setResult({
          url,
          revision,
          error:
            "Couldn't load what's owing. Check your connection and try again.",
        });
      }
    })();
    return () => controller.abort();
  }, [url, key, revision]);
  const current =
    result?.url === url && result.revision === revision ? result : undefined;
  return {
    rows: current?.rows,
    truncated: current?.truncated ?? false,
    error: current?.error,
    reload: () => setRevision((value) => value + 1),
  };
}
