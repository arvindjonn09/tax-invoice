import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · JobFlow" };

export default function LoginPage() {
  return (
    <main className="foundation">
      <h1>Sign in to JobFlow</h1>
      <p>Use the email and password for your JobFlow account.</p>
      <section className="rounded-lg border bg-card p-6 text-card-foreground">
        <LoginForm />
      </section>
      <p>
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="text-link underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
