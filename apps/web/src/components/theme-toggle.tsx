"use client";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
const subscribe = () => () => {};
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="theme-preference">Appearance</label>
      <select
        id="theme-preference"
        className="rounded-sm border border-input bg-card px-4 text-card-foreground"
        value={mounted ? theme : "light"}
        disabled={!mounted}
        onChange={(event) => setTheme(event.target.value)}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </div>
  );
}
