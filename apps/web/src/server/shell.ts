import type { Role } from "@jobflow/authz";
import type { NavLink } from "@/components/shell/sidebar-nav";
import { navigationFor } from "./navigation";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  accountant: "Accountant",
  employee: "Employee",
  subcontractor: "Subcontractor",
};

export function navLinksFor(role: Role): NavLink[] {
  return navigationFor(role).map(({ slug, label, icon }) => ({
    href: `/${slug}`,
    label,
    icon,
  }));
}
