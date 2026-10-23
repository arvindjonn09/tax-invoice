"use client";
import { useEffect, useState } from "react";
export function useRemote<T>(url: string) {
  const [revision, setRevision] = useState(0);
  const key = `${url}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    url: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Couldn't load this information. Try again.");
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setResult({ key, url, data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({
            key,
            url,
            error:
              "Couldn't load this information. Check your connection and try again.",
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
export type Customer = {
  id: string;
  name: string;
  abn: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  archivedAt: string | null;
};
export type Contact = {
  id: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  archivedAt: string | null;
};
export type Location = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  accessNotes: string | null;
  archivedAt: string | null;
};
