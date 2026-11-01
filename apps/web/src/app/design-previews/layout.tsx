import type { ReactNode } from "react";
import { requireDesignPreviews } from "@/server/design/gate";

// Decided per request from the runtime environment, never at build time.
export const dynamic = "force-dynamic";

/** Static design samples: 404 in production (#61). */
export default function Layout({ children }: { children: ReactNode }) {
  requireDesignPreviews();
  return children;
}
