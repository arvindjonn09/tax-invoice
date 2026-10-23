import type { Metadata } from "next";
import { InvitationForm } from "./invitation-form";
export const metadata: Metadata = {
  title: "Accept invitation · JobFlow",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function InvitationPage() {
  return (
    <main className="foundation">
      <h1>Join your JobFlow team</h1>
      <p>Use the invitation link shared privately by your company owner.</p>
      <InvitationForm />
    </main>
  );
}
