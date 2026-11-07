import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { legalDetails } from "@/content/legal/details";
import {
  PRIVACY_VERSION,
  legalTextIsPlaceholder,
} from "@/server/account/terms";
import { supportEmail } from "@/server/email";

export const metadata: Metadata = { title: "Privacy Policy · JobFlow" };

export default function Page() {
  const { legalName, abn, hostingLocation, effectiveDate } = legalDetails();
  const email = supportEmail();
  const mail = (
    <a className="text-link underline" href={`mailto:${email}`}>
      {email}
    </a>
  );
  return (
    <LegalPage
      title="Privacy Policy"
      version={PRIVACY_VERSION}
      effectiveDate={effectiveDate}
      draft={legalTextIsPlaceholder()}
    >
      <p>
        {legalName} (ABN {abn}) runs JobFlow. This policy explains how we handle
        personal information, in line with the Australian Privacy Principles.
      </p>

      <h2>We don&apos;t sell your data</h2>
      <p>
        <strong>
          We don&apos;t sell, rent or trade personal information or business
          data to any third party, in any manner.
        </strong>{" "}
        We don&apos;t use it for advertising, and JobFlow has no advertising or
        analytics trackers.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account details:</strong> name, email address, password
          (stored only as a secure hash), role and company.
        </li>
        <li>
          <strong>Business records you enter:</strong> company details and ABN,
          customers, contacts and sites, jobs, quotes, invoices, payments,
          bills, expenses, contractors, employees and their hourly cost rates,
          timesheets, and uploaded files such as receipts and work photos.
        </li>
        <li>
          <strong>Technical records:</strong> IP address, browser details,
          sign-in and security events, and an audit history of changes.
        </li>
        <li>
          <strong>Messages:</strong> anything you send us, such as a request to
          extend a trial.
        </li>
      </ul>
      <p>
        Your company may enter information about other people, such as
        customers, staff and subcontractors. That company decides what&apos;s
        entered and is responsible for its own privacy obligations to them. If
        you&apos;re one of those people, you may want to contact that company
        first.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To provide JobFlow and show you your company&apos;s records.</li>
        <li>
          To send service emails, such as links to set a password and notices
          about your trial.
        </li>
        <li>
          To keep accounts secure, prevent abuse and investigate problems.
        </li>
        <li>To respond to you, and to meet our legal obligations.</li>
      </ul>
      <p>
        We don&apos;t use it for anything else unless you agree or the law
        requires or allows it. We don&apos;t send marketing emails.
      </p>

      <h2>Who can see it</h2>
      <p>
        Inside a company, access depends on the role its owner gives each
        person. Companies can&apos;t see each other&apos;s data. We access your
        data only when needed to run or support the service, or if the law
        requires it.
      </p>
      <p>We use these service providers, only so that JobFlow can run:</p>
      <ul>
        <li>
          <strong>Cloudflare</strong>, for network protection and the &quot;not
          a robot&quot; check. It handles traffic through its global network, so
          information may pass through other countries.
        </li>
        <li>
          <strong>Zoho</strong>, to send email through its Australian service.
        </li>
        <li>
          <strong>Have I Been Pwned</strong>, to check whether a new password
          has appeared in a data breach. Only a small part of a hash of the
          password is sent, never the password or your email address.
        </li>
      </ul>
      <p>
        JobFlow, its file storage and its backups are self-hosted on our own
        servers in {hostingLocation}. We may also disclose information if the
        law requires it.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Issued invoices and approved financial records are kept and can&apos;t
        be deleted, because businesses must be able to rely on them. Other
        business records are kept for at least 5 years after their last change,
        and employee records for at least 7 years. After that we delete or
        de-identify information we no longer need, when it&apos;s reasonable to
        do so.
      </p>

      <h2>Security</h2>
      <p>
        We protect information with measures such as hashed passwords, access
        limits for each role, private file storage, encrypted connections and
        audit records. No system is completely secure. If a breach is likely to
        cause serious harm, we&apos;ll notify affected people and the Office of
        the Australian Information Commissioner as the law requires.
      </p>

      <h2>Cookies</h2>
      <p>
        We use essential cookies to keep you signed in and to protect sign-up
        and sign-in forms. We don&apos;t use advertising or tracking cookies.
      </p>

      <h2>Your choices</h2>
      <p>
        You can ask to see or correct the personal information we hold about
        you, and we&apos;ll respond within a reasonable time. Company owners can
        export their company&apos;s records. Email {mail}.
      </p>

      <h2>Complaints</h2>
      <p>
        If you have a privacy complaint, email {mail} and we&apos;ll respond
        within 30 days. If you&apos;re not satisfied, you can contact the Office
        of the Australian Information Commissioner at{" "}
        <a className="text-link underline" href="https://www.oaic.gov.au">
          oaic.gov.au
        </a>
        .
      </p>

      <h2>Changes</h2>
      <p>
        We&apos;ll update this policy when our practices change, and tell you
        about changes that matter. The version shown above is the current one.
      </p>
    </LegalPage>
  );
}
