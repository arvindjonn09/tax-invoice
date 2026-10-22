import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";

export const metadata: Metadata = { title: "Account · JobFlow" };
export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}

export default async function AccountPage() {
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    await headers(),
  );
  if (resolution.status === "signed-out") redirect("/login");
  return (
    <main className="foundation">
      <h1>Your account</h1>
      <section className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
        {resolution.status === "active" ? (
          <p>
            Signed in. Acting as <strong>{resolution.actor.role}</strong> in
            your company.
          </p>
        ) : resolution.status === "choose-company" ? (
          <p>
            You belong to several companies. Company selection arrives with the
            app shell.
          </p>
        ) : (
          <p>Your account is not a member of any active company yet.</p>
        )}
        <form action={signOut}>
          <button
            type="submit"
            className="min-h-11 rounded-sm border border-input px-4"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
