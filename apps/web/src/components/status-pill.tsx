import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
const statuses = {
  draft: { tone: "bg-muted text-muted-foreground", icon: "○", label: "Draft" },
  active: { tone: "bg-info text-info-foreground", icon: "→", label: "Active" },
  completed: {
    tone: "bg-success text-success-foreground",
    icon: "✓",
    label: "Completed",
  },
  paid: {
    tone: "bg-success text-success-foreground",
    icon: "✓",
    label: "Paid",
  },
  pending: {
    tone: "bg-warning text-warning-foreground",
    icon: "◷",
    label: "Pending",
  },
  overdue: {
    tone: "bg-danger text-danger-foreground",
    icon: "!",
    label: "Overdue",
  },
  void: { tone: "bg-danger text-danger-foreground", icon: "×", label: "Void" },
} as const;
export type Status = keyof typeof statuses;
export function StatusPill({
  status,
  label,
  icon,
  className,
}: {
  status: Status;
  label?: string;
  icon?: ReactNode;
  className?: string;
}) {
  const value = statuses[status];
  return (
    <span
      className={cn(
        "status-pill inline-flex items-center gap-1 rounded-full px-4 py-2 text-sm",
        value.tone,
        className,
      )}
    >
      <span aria-hidden="true">{icon ?? value.icon}</span>
      <span>{label ?? value.label}</span>
    </span>
  );
}
