"use client";

import {
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useId,
} from "react";
import { Button } from "@/components/ui/button";

/**
 * #226 / S9 AC5: whether the signed-in company is read-only, from the server
 * (actor.access). The server stays authoritative (403 company_read_only);
 * this only keeps the UI from offering dead ends.
 */
export type CompanyAccess = { readOnly: boolean; reason: string };

const AccessContext = createContext<CompanyAccess>({
  readOnly: false,
  reason: "",
});

export function CompanyAccessProvider({
  value,
  children,
}: {
  value: CompanyAccess;
  children: ReactNode;
}) {
  return (
    <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
  );
}

export function useCompanyAccess(): CompanyAccess {
  return useContext(AccessContext);
}

/** The role may write AND the company isn't read-only. */
export function useWritable(allowed: boolean): boolean {
  const { readOnly } = useCompanyAccess();
  return allowed && !readOnly;
}

/**
 * A create or edit action. Hidden when the role can't write at all; when the
 * company is read-only it stays visible and focusable but disabled
 * (`aria-disabled`), with a one-line reason linked by aria-describedby.
 */
export function WriteAction({
  allowed,
  label,
  children,
}: {
  allowed: boolean;
  label: string;
  children: ReactElement;
}) {
  const { readOnly, reason } = useCompanyAccess();
  const id = useId();
  if (!allowed) return null;
  if (!readOnly) return children;
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        type="button"
        aria-disabled="true"
        aria-describedby={id}
        className="cursor-not-allowed opacity-60"
        onClick={(event) => event.preventDefault()}
      >
        {label}
      </Button>
      <span id={id} className="text-sm text-muted-foreground">
        {reason}
      </span>
    </span>
  );
}

/** The one-line reason above a form that can't be saved right now. */
export function ReadOnlyNotice() {
  const { readOnly, reason } = useCompanyAccess();
  if (!readOnly) return null;
  return (
    <p className="rounded-md border border-danger-foreground bg-danger p-3 text-danger-foreground">
      <span aria-hidden="true">🔒 </span>
      {reason}
    </p>
  );
}
