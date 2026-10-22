import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { ThemeProvider } from "@/components/theme-provider";
export const metadata: Metadata = {
  title: "JobFlow",
  description: "Job management for Australian contractors",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU" className={GeistSans.variable} suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
