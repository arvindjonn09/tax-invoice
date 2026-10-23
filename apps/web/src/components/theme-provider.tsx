"use client";
import { ThemeProvider as Provider } from "next-themes";
import type { ReactNode } from "react";
export function ThemeProvider({
  children,
  nonce,
}: {
  children: ReactNode;
  nonce?: string | undefined;
}) {
  return (
    <Provider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
      {...(nonce ? { nonce } : {})}
    >
      {children}
    </Provider>
  );
}
