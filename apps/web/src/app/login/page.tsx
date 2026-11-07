import type { Metadata } from "next";
import Link from "next/link";
import { safeNextPath } from "@/server/routes/safe-next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · JobFlow" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { next } = await searchParams;
  // Return to the page asked for, if it's a path on this site (S1 AC2).
  const target = safeNextPath(Array.isArray(next) ? next[0] : next);
  return (
    <main className="foundation">
      <h1>Sign in to JobFlow</h1>
      <p>Use the email and password for your JobFlow account.</p>
      <section className="rounded-lg border bg-card p-6 text-card-foreground">
        <LoginForm next={target} />
        <p>
          <Link
            href="/forgot-password"
            className="inline-flex min-h-11 items-center text-link underline"
          >
            Forgot your password?
          </Link>
        </p>
      </section>
      <p>
        New to JobFlow?{" "}
        <Link href="/signup" className="text-link font-semibold underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}
