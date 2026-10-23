"use client";
import { useEffect, useState } from "react";
class RemoteError extends Error {
  constructor(readonly status: number) {
    super("Request failed");
  }
}
export function useRemote<T>(url: string | null) {
  const [revision, setRevision] = useState(0);
  const key = `${url}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    url: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new RemoteError(response.status);
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setResult({ key, url, data });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const denied =
          failure instanceof RemoteError &&
          [401, 403, 404].includes(failure.status);
        const error = denied
          ? "This information is no longer available to you. Refresh or sign in again."
          : "Couldn't load this information. Check your connection and try again.";
        setResult((previous) => {
          const data =
            !denied && previous?.url === url ? previous.data : undefined;
          return { key, url, error, ...(data === undefined ? {} : { data }) };
        });
      });
    return () => controller.abort();
  }, [url, key]);
  return {
    data: result?.url === url ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    reload: () => setRevision((value) => value + 1),
  };
}
