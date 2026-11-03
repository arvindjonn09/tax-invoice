// Original line icons for the landing page (#240); decorative only.
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const icons = {
  customers: (
    <Icon>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </Icon>
  ),
  quote: (
    <Icon>
      <path d="M6 2.5h9l4 4v15H6z" />
      <path d="M14.5 2.5v4.5H19M9 12h7M9 16h5" />
    </Icon>
  ),
  job: (
    <Icon>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M3 12.5h18" />
    </Icon>
  ),
  team: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Icon>
  ),
  contractor: (
    <Icon>
      <path d="M4 15h16v3H4zM6 15a6 6 0 0 1 12 0" />
      <path d="M12 6V4" />
    </Icon>
  ),
  invoice: (
    <Icon>
      <path d="M5 2.5h14v19l-3-2-2 2-2-2-2 2-2-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Icon>
  ),
  reports: (
    <Icon>
      <path d="M3.5 20.5h17" />
      <path d="M6.5 16.5v-4M11 16.5V8M15.5 16.5v-6M20 16.5V5" />
    </Icon>
  ),
  gst: (
    <Icon>
      <path d="M19 5 5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </Icon>
  ),
  shield: (
    <Icon>
      <path d="M12 2.5 4 5.5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10v-6z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Icon>
  ),
  lock: (
    <Icon>
      <rect x="4.5" y="10.5" width="15" height="11" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </Icon>
  ),
  history: (
    <Icon>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 3.5V8H8M12 7.5V12l3 2" />
    </Icon>
  ),
  check: (
    <Icon>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  ),
  arrow: (
    <Icon>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  ),
} as const;
