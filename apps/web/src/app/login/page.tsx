import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · JobFlow" };

export default function LoginPage() {
  return (
    <main className="foundation">
      <h1>Sign in to JobFlow</h1>
      <p>Use the email and password your company owner set up for you.</p>
      <section className="rounded-lg border bg-card p-6 text-card-foreground">
        <LoginForm />
      </section>
    </main>
  );
}
