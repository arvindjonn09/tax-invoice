import { AuthzError } from "@jobflow/authz";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { UserAccess } from "@/features/users/user-access";
import { requireActor } from "@/server/authz";
import { PATH_HEADER } from "@/server/routes/public";
import { loginFor } from "@/server/routes/safe-next";

export default async function UsersPage() {
  try {
    await requireActor("user.manage");
  } catch (error) {
    if (error instanceof AuthzError) {
      if (error.status === 401)
        redirect(loginFor((await headers()).get(PATH_HEADER)));
      notFound();
    }
    throw error;
  }
  return (
    <>
      <PageHeader
        title="User access"
        description="Invite your team and manage who can access this company."
        breadcrumbs={[
          { label: "JobFlow", href: "/home" },
          { label: "User access" },
        ]}
      />
      <UserAccess />
    </>
  );
}
