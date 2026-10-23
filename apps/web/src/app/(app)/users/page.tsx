import { AuthzError } from "@jobflow/authz";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { UserAccess } from "@/features/users/user-access";
import { requireActor } from "@/server/authz";

export default async function UsersPage() {
  try {
    await requireActor("user.manage");
  } catch (error) {
    if (error instanceof AuthzError) {
      if (error.status === 401) redirect("/login");
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
