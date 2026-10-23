import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider } from "@/components/theme-provider";
export const metadata: Metadata = {
  title: "JobFlow",
  description: "Job management for Australian contractors",
};
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Reading the per-request CSP nonce (src/proxy.ts) also makes every page
  // render dynamically, which nonces require.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en-AU" className={GeistSans.variable} suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
