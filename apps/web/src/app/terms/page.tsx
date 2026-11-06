import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL_DETAILS } from "@/content/legal/details";
import { TERMS_VERSION, legalTextIsPlaceholder } from "@/server/account/terms";
import { supportEmail } from "@/server/email";

export const metadata: Metadata = { title: "Terms of Service · JobFlow" };

export default function Page() {
  const { legalName, abn, state, effectiveDate } = LEGAL_DETAILS;
  const email = supportEmail();
  return (
    <LegalPage
      title="Terms of Service"
      version={TERMS_VERSION}
      effectiveDate={effectiveDate}
      draft={legalTextIsPlaceholder()}
    >
      <p>
        These terms are an agreement between {legalName} (ABN {abn}) (
        &quot;we&quot;, &quot;us&quot;) and the business or person who creates a
        JobFlow company (&quot;you&quot;). By creating an account or using
        JobFlow, you agree to them.
      </p>

      <h2>What JobFlow does</h2>
      <p>
        JobFlow helps Australian trade and service businesses manage customers,
        jobs, quotes, invoices, payments, supplier bills, expenses, timesheets
        and subcontractors. It calculates GST, produces tax invoices and
        prepares a draft GST/BAS summary, and it shows job profitability.
      </p>
      <p>
        JobFlow doesn&apos;t lodge anything with the Australian Taxation Office,
        and it doesn&apos;t handle payroll, superannuation, PAYG withholding or
        Single Touch Payroll.
      </p>

      <h2>Not tax or financial advice</h2>
      <p>
        JobFlow is a software tool. It doesn&apos;t give tax, accounting, legal
        or financial advice. You&apos;re responsible for the information you
        enter, for checking the accuracy of anything JobFlow produces before you
        rely on it, and for meeting your own tax and record-keeping obligations.
        GST/BAS figures are drafts. We recommend having them reviewed by your
        registered tax or BAS agent before you lodge.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be at least 18 and able to enter into this agreement.</li>
        <li>Give accurate details, and keep your password private.</li>
        <li>
          You&apos;re responsible for what happens under your company, including
          the people you invite and the roles you give them.
        </li>
        <li>Tell us promptly if you think your account has been misused.</li>
      </ul>

      <h2>Free trial</h2>
      <p>
        New companies get a 30-day free trial. When it ends, your company
        becomes read-only: you can still view and export your records, but you
        can&apos;t add or change them until the trial is extended or another
        arrangement is in place. We don&apos;t ask for card details during the
        trial, and we&apos;ll tell you the price and terms before you&apos;re
        ever charged.
      </p>

      <h2>Your data</h2>
      <p>
        You keep ownership of the data you enter. You give us permission to
        store and process it only to run JobFlow for you, keep it secure and
        support you.{" "}
        <strong>
          We don&apos;t sell your data or your users&apos; data to anyone, in
          any form.
        </strong>{" "}
        Our{" "}
        <Link className="text-link underline" href="/privacy">
          Privacy Policy
        </Link>{" "}
        explains how personal information is handled.
      </p>
      <p>
        You must have the right to enter any personal information you add about
        your customers, staff and subcontractors, and you&apos;re responsible
        for your own privacy obligations to them.
      </p>

      <h2>Records and exports</h2>
      <p>
        Issued invoices and approved financial records can&apos;t be edited or
        deleted. They&apos;re corrected with credit notes, voids and reversals,
        so your history stays accurate. Company owners can export their
        company&apos;s records. Some records are kept for a minimum period even
        if you stop using JobFlow, as explained in the Privacy Policy.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Don&apos;t break the law or infringe anyone&apos;s rights.</li>
        <li>
          Don&apos;t try to reach another company&apos;s data, get around
          security or access limits, or disrupt the service.
        </li>
        <li>Don&apos;t upload malicious files.</li>
        <li>Don&apos;t resell JobFlow without our written agreement.</li>
      </ul>
      <p>
        We can suspend or end access if these terms are seriously breached or
        where we need to protect the service or other users. Where it&apos;s
        reasonable, we&apos;ll tell you first and give you a chance to export
        your records.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep JobFlow available and your data safe, but we can&apos;t
        promise uninterrupted or error-free service. The site is briefly
        unavailable during maintenance. Keep your own copies of records you must
        hold by law. We may change or improve features. If we change these terms
        in a way that matters to you, we&apos;ll tell you, and we may ask you to
        accept the new version to keep using JobFlow.
      </p>

      <h2>Australian Consumer Law and liability</h2>
      <p>
        Nothing in these terms excludes rights you have under the Australian
        Consumer Law that can&apos;t legally be excluded. To the extent the law
        allows, we aren&apos;t liable for indirect or consequential loss, or for
        loss of profit, revenue or data, and our total liability is limited to
        the greater of the amount you paid us in the previous 12 months and AUD
        $100.
      </p>

      <h2>Ending</h2>
      <p>
        You can stop using JobFlow at any time. To close your company, email{" "}
        <a className="text-link underline" href={`mailto:${email}`}>
          {email}
        </a>
        . Export your records first. These terms are governed by the laws of{" "}
        {state}, and you and we submit to the courts of that place.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? Email{" "}
        <a className="text-link underline" href={`mailto:${email}`}>
          {email}
        </a>
        .
      </p>
    </LegalPage>
  );
}
