import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PATH_HEADER } from "@/server/routes/public";
import { loginFor } from "@/server/routes/safe-next";

export const metadata: Metadata = { title: "Account · JobFlow" };
export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}

export default async function AccountPage() {
  const requestHeaders = await headers();
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    requestHeaders,
  );
  if (resolution.status === "signed-out")
    redirect(loginFor(requestHeaders.get(PATH_HEADER)));
  if (resolution.status === "unverified") redirect("/verify-email/pending");
  const userId =
    resolution.status === "active"
      ? resolution.actor.userId
      : resolution.userId;
  const companies = await getDatabase().membership.count({
    where: { userId, isActive: true },
  });
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
            You belong to several companies.{" "}
            <Link className="text-link underline" href="/choose-company">
              Choose a company
            </Link>
            .
          </p>
        ) : (
          <p>Your account is not a member of any active company yet.</p>
        )}
        {/* The account menu (S12 AC3, #223). */}
        <nav aria-label="Account menu">
          <ul className="flex flex-wrap gap-4">
            {companies > 1 ? (
              <li>
                <Link
                  className="inline-flex min-h-11 items-center text-link underline"
                  href="/choose-company"
                >
                  Switch company
                </Link>
              </li>
            ) : null}
            {companies > 0 ? (
              <li>
                <Link
                  className="inline-flex min-h-11 items-center text-link underline"
                  href="/onboarding?another=1"
                >
                  Create a company
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
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
