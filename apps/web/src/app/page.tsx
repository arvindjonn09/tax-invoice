import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { FlowDiagram, GrowBars, JobTrack } from "@/components/landing/anime";
import { icons } from "@/components/landing/icons";
import { SiteHeader } from "@/components/landing/site-header";
import {
  LandingMotion,
  LiftCard,
  Reveal,
  ScrollProgress,
} from "@/components/landing/motion";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title:
    "JobFlow · Job management, invoicing and GST for Australian contractors",
  description:
    "Quotes, jobs, contractors, tax invoices and a draft GST/BAS summary in one place, with job profit worked out on GST-exclusive amounts.",
};

const nav = [
  { href: "#why", label: "Why JobFlow" },
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#gst", label: "GST and profit" },
  { href: "#faq", label: "FAQ" },
];

const reasons = [
  {
    problem: "Profit hidden in spreadsheets",
    outcome:
      "See gross profit for every job, customer and month, from what you have actually invoiced and spent.",
    icon: icons.reports,
  },
  {
    problem: "GST muddled into revenue",
    outcome:
      "Amounts are kept to the cent with GST separate, so recoverable GST never inflates revenue, cost or profit.",
    icon: icons.gst,
  },
  {
    problem: "Contractors seeing too much",
    outcome:
      "Subcontractors see only their own offers, jobs and bills, never your prices, margins or other contractors' rates.",
    icon: icons.shield,
  },
  {
    problem: "Invoices changed after they are sent",
    outcome:
      "Issued invoices are locked. Corrections go through credit notes and voids, with a full audit history.",
    icon: icons.lock,
  },
];

const steps = [
  ["Request", "Log the enquiry, the customer and the service location."],
  ["Quote", "Price lines with their GST treatment, an expiry and approval."],
  ["Job", "Turn the approved quote into a job and schedule site visits."],
  [
    "Assign",
    "Send work to employees or offer it to contractors at agreed rates.",
  ],
  ["Invoice", "Issue tax invoices, record part payments and credit notes."],
  ["Report", "Review job profit, who owes what and a draft GST/BAS summary."],
] as const;

const features = [
  {
    title: "Customers and sites",
    body: "Multiple contacts and service locations per customer, ABNs and full job history.",
    icon: icons.customers,
  },
  {
    title: "Quotes and variations",
    body: "Line items with GST treatment, expiry dates, approvals and one-step conversion to a job.",
    icon: icons.quote,
  },
  {
    title: "Jobs and scheduling",
    body: "Unique job numbers, status timeline, multiple site visits and supporting documents.",
    icon: icons.job,
  },
  {
    title: "Timesheets and expenses",
    body: "Hours at the cost rate that applied on the day, receipts attached and approvals required.",
    icon: icons.team,
  },
  {
    title: "Contractor offers and bills",
    body: "Fixed or hourly offers, recorded acceptance, approved bills and part payments.",
    icon: icons.contractor,
  },
  {
    title: "Tax invoices and payments",
    body: "Numbered on issue, PDF copies, due dates, part receipts, credit notes and voids.",
    icon: icons.invoice,
  },
  {
    title: "Reports and exports",
    body: "Profit by job, customer and month, money owed to and by you, and CSV exports for your accountant.",
    icon: icons.reports,
  },
  {
    title: "Draft GST/BAS summary",
    body: "G1, 1A and 1B with drill-down, cash or accruals basis and period lock, ready for review.",
    icon: icons.gst,
  },
];

const trust = [
  {
    title: "Access by role",
    body: "Owner, manager, accountant, employee and subcontractor each see only what their work needs. Checked on the server, every time.",
    icon: icons.shield,
  },
  {
    title: "Nothing silently edited",
    body: "Issued and approved records are never changed or deleted. Every correction leaves a trail.",
    icon: icons.history,
  },
  {
    title: "Private documents",
    body: "Photos, receipts and site reports are stored privately and opened through short-lived links.",
    icon: icons.lock,
  },
  {
    title: "Made for Australia",
    body: "Australian dollars to the cent, ABN checks, Australian dates and GST built in from day one.",
    icon: icons.check,
  },
];

const faqs = [
  {
    q: "Who is JobFlow for?",
    a: "Australian trades and service businesses that quote work, schedule employees and subcontractors, and invoice customers.",
  },
  {
    q: "Does JobFlow lodge my BAS?",
    a: "No. It prepares a draft GST/BAS summary (G1, 1A and 1B) with drill-down for your accountant or registered tax agent to review and lodge.",
  },
  {
    q: "Does it run payroll?",
    a: "No. Timesheets record hours and job cost. Payroll, PAYG withholding, Single Touch Payroll and superannuation are not included.",
  },
  {
    q: "Can my subcontractors use it?",
    a: "Yes. They get their own sign-in that shows only their offers, jobs, bills and completion evidence.",
  },
  {
    q: "What if I am not registered for GST?",
    a: "JobFlow issues plain invoices without GST and still tracks profit on every job. Your registration dates are kept, so earlier records stay correct.",
  },
  {
    q: "How do I get started?",
    a: "Public sign-up with a free 30-day trial is coming soon. Email admin@shivomsangha.com for early access.",
  },
];

function Amount({ children }: { children: ReactNode }) {
  return <span className="money font-semibold">{children}</span>;
}

function SectionHeading({
  id,
  eyebrow,
  title,
  intro,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro: string;
}) {
  return (
    <Reveal className="mx-auto max-w-3xl text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-link">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="mt-2 scroll-mt-24 text-3xl font-semibold tracking-tight sm:text-4xl"
      >
        {title}
      </h2>
      <p className="mt-4 text-lg text-muted-foreground">{intro}</p>
    </Reveal>
  );
}

function Track() {
  const stages = ["Quote approved", "Work done", "Invoice issued", "Paid"];
  return (
    <JobTrack>
      <div className="relative">
        <svg
          aria-hidden="true"
          className="absolute inset-x-0 top-2.5 h-1 w-full"
          viewBox="0 0 100 2"
          preserveAspectRatio="none"
        >
          <path
            d="M12.5 1H87.5"
            className="stroke-border"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            data-draw
            d="M12.5 1H87.5"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset="1"
            className="stroke-primary"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <ol className="relative grid grid-cols-4 text-center text-xs sm:text-sm">
          {stages.map((stage) => (
            <li key={stage} className="flex flex-col items-center gap-2">
              <span
                data-step
                aria-hidden="true"
                className="block size-6 rounded-full border-4 border-card bg-primary"
              />
              <span>{stage}</span>
            </li>
          ))}
        </ol>
      </div>
    </JobTrack>
  );
}

function SampleJob() {
  const rows: [string, string, boolean?][] = [
    ["Invoiced revenue (ex GST)", "$2,500.00"],
    ["GST on the invoice (collected for the ATO)", "$250.00"],
    ["Invoice total (incl GST)", "$2,750.00"],
    ["Incurred job cost (ex GST)", "$750.00"],
    ["Gross job profit (invoiced basis)", "$1,750.00", true],
  ];
  return (
    <figure
      aria-labelledby="sample-job-caption"
      className="rounded-2xl border bg-card p-6 text-card-foreground shadow-[0_8px_24px_rgb(15_23_42/0.16)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">Sample job · Kitchen rewire</p>
        <span className="rounded-full border border-success-foreground bg-success px-3 py-0.5 text-sm font-medium text-success-foreground">
          ✓ Paid
        </span>
      </div>
      <div className="mt-6">
        <Track />
      </div>
      <dl className="mt-6 divide-y divide-border/40 text-sm">
        {rows.map(([label, value, strong]) => (
          <div
            key={label}
            className={cn(
              "flex items-baseline justify-between gap-4 py-2",
              strong && "text-base font-semibold",
            )}
          >
            <dt>{label}</dt>
            <dd>
              <Amount>{value}</Amount>
            </dd>
          </div>
        ))}
      </dl>
      <figcaption
        id="sample-job-caption"
        className="mt-4 text-sm text-muted-foreground"
      >
        Illustrative figures for a sample job. Margin 70.0% (invoiced basis).
        GST collected is never counted as revenue or profit.
      </figcaption>
    </figure>
  );
}

function Bar({
  label,
  segments,
}: {
  label: string;
  segments: { label: string; amount: string; width: string; tone: string }[];
}) {
  return (
    <div>
      <p className="text-sm font-semibold">{label}</p>
      <div className="mt-2 flex h-12 overflow-hidden rounded-lg border">
        {segments.map((segment) => (
          <div
            key={segment.label}
            data-bar
            aria-hidden="true"
            className={cn("h-full origin-left", segment.width, segment.tone)}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-sm border", segment.tone)}
            />
            {segment.label}: <Amount>{segment.amount}</Amount>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Home() {
  const linkButton = buttonVariants();
  const outlineButton = buttonVariants({ variant: "outline" });
  return (
    <LandingMotion>
      <ScrollProgress />
      <SiteHeader sections={nav} />

      <main id="main">
        <section
          aria-labelledby="hero-title"
          className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:px-6 lg:grid-cols-2 lg:py-24"
        >
          <div className="landing-rise">
            <p className="inline-flex rounded-full border bg-info px-3 py-1 text-sm font-medium text-info-foreground">
              Built for Australian trades and service businesses
            </p>
            <h1
              id="hero-title"
              className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
            >
              Know what every job really made.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground">
              JobFlow brings quotes, jobs, contractors, timesheets, tax invoices
              and GST into one place, and works out profit on GST-exclusive
              amounts, so the margin you see is the margin you keep.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/signup" className={linkButton}>
                Sign up
              </Link>
              <Link href="/login" className={outlineButton}>
                Sign in
              </Link>
            </div>
            <p className="mt-6 text-sm text-muted-foreground">
              New here? Sign up to request early access; a free 30-day trial
              starts when public sign-up opens.{" "}
              <a className="text-link underline" href="#how">
                See how it works
              </a>
              .
            </p>
          </div>
          <div className="landing-rise landing-rise-delay">
            <SampleJob />
          </div>
        </section>

        <section
          aria-labelledby="why"
          className="bg-card py-20 text-card-foreground"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <SectionHeading
              id="why"
              eyebrow="Why JobFlow"
              title="Stop guessing which jobs make money"
              intro="Most small contractors find out a job lost money months later. JobFlow fixes the four things that hide the real numbers."
            />
            <ul className="mt-12 grid gap-6 md:grid-cols-2">
              {reasons.map((reason, index) => (
                <li key={reason.problem}>
                  <Reveal delay={index * 0.08} className="h-full">
                    <LiftCard className="flex h-full gap-4 rounded-2xl border bg-background p-6 text-foreground">
                      <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-info text-info-foreground">
                        {reason.icon}
                      </span>
                      <div>
                        <h3 className="text-lg font-semibold">
                          {reason.problem}
                        </h3>
                        <p className="mt-2 text-muted-foreground">
                          {reason.outcome}
                        </p>
                      </div>
                    </LiftCard>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="how" className="py-20">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <SectionHeading
              id="how"
              eyebrow="How it works"
              title="From first call to final payment"
              intro="One record follows the work all the way through, so nothing is typed twice and every dollar lands on the right job."
            />
            <FlowDiagram>
              <div className="relative mt-14">
                <svg
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 hidden h-12 w-full lg:block"
                  viewBox="0 0 1200 48"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M100 24C150 4 250 4 300 24S450 44 500 24S650 4 700 24S850 44 900 24S1050 4 1100 24"
                    fill="none"
                    className="stroke-border"
                    strokeWidth="2"
                    strokeDasharray="6 6"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    data-draw
                    d="M100 24C150 4 250 4 300 24S450 44 500 24S650 4 700 24S850 44 900 24S1050 4 1100 24"
                    fill="none"
                    pathLength={1}
                    strokeDasharray="1"
                    strokeDashoffset="1"
                    className="stroke-primary"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <ol className="relative grid gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 lg:gap-4">
                  {steps.map(([title, body], index) => (
                    <li
                      key={title}
                      data-step
                      className="flex flex-col items-center text-center"
                    >
                      <span className="grid size-12 place-items-center rounded-full border-4 border-background bg-primary text-lg font-bold text-primary-foreground">
                        {index + 1}
                      </span>
                      <h3 className="mt-4 font-semibold">{title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {body}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            </FlowDiagram>
          </div>
        </section>

        <section
          aria-labelledby="features"
          className="bg-card py-20 text-card-foreground"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <SectionHeading
              id="features"
              eyebrow="Features"
              title="Everything a growing contractor needs"
              intro="Built around how trade and service work actually runs, from the quote to the accountant."
            />
            <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature, index) => (
                <li key={feature.title}>
                  <Reveal delay={(index % 4) * 0.08} className="h-full">
                    <LiftCard className="h-full rounded-2xl border bg-background p-6 text-foreground">
                      <span className="grid size-11 place-items-center rounded-xl bg-info text-info-foreground">
                        {feature.icon}
                      </span>
                      <h3 className="mt-4 font-semibold">{feature.title}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {feature.body}
                      </p>
                    </LiftCard>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="gst" className="py-20">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 md:px-6 lg:grid-cols-2">
            <Reveal>
              <p className="text-sm font-semibold uppercase tracking-wide text-link">
                GST and profit
              </p>
              <h2
                id="gst"
                className="mt-2 scroll-mt-24 text-3xl font-semibold tracking-tight sm:text-4xl"
              >
                GST stays out of your profit
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                GST you collect belongs to the ATO, and GST you can claim back
                isn&apos;t a cost. JobFlow keeps both out of your margins.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Enter prices ex or incl GST and always see both.",
                  "Each line keeps its own treatment: taxable, GST-free, input taxed or out of scope.",
                  "GST you can't claim back counts as job cost; GST you can claim back doesn't.",
                  "Not registered for GST? You get plain invoices and the same profit view.",
                ].map((point) => (
                  <li key={point} className="flex gap-3">
                    <span className="mt-0.5 shrink-0 text-link">
                      {icons.check}
                    </span>
                    {point}
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.1}>
              <figure
                aria-labelledby="gst-caption"
                className="rounded-2xl border bg-card p-6 text-card-foreground"
              >
                <GrowBars>
                  <div className="space-y-8">
                    <Bar
                      label="Invoice total: $2,750.00 incl GST"
                      segments={[
                        {
                          label: "Revenue (ex GST)",
                          amount: "$2,500.00",
                          width: "w-[90.91%]",
                          tone: "bg-primary",
                        },
                        {
                          label: "GST for the ATO",
                          amount: "$250.00",
                          width: "w-[9.09%]",
                          tone: "bg-warning",
                        },
                      ]}
                    />
                    <Bar
                      label="Revenue: $2,500.00 ex GST"
                      segments={[
                        {
                          label: "Job cost (ex GST)",
                          amount: "$750.00",
                          width: "w-[30%]",
                          tone: "bg-muted",
                        },
                        {
                          label: "Gross profit",
                          amount: "$1,750.00",
                          width: "w-[70%]",
                          tone: "bg-success",
                        },
                      ]}
                    />
                  </div>
                </GrowBars>
                <figcaption
                  id="gst-caption"
                  className="mt-6 text-sm text-muted-foreground"
                >
                  Illustrative sample job. The GST/BAS summary is a draft for
                  your accountant or registered tax agent; JobFlow does not
                  lodge with the ATO.
                </figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        <section
          aria-labelledby="trust"
          className="bg-card py-20 text-card-foreground"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <SectionHeading
              id="trust"
              eyebrow="Security and records"
              title="Your records, kept properly"
              intro="Financial records you can stand behind, with access you control."
            />
            <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {trust.map((item, index) => (
                <li key={item.title}>
                  <Reveal delay={index * 0.08} className="h-full">
                    <div className="h-full rounded-2xl border bg-background p-6 text-foreground">
                      <span className="text-link">{item.icon}</span>
                      <h3 className="mt-3 font-semibold">{item.title}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {item.body}
                      </p>
                    </div>
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="faq" className="py-20">
          <div className="mx-auto max-w-3xl px-4 md:px-6">
            <SectionHeading
              id="faq"
              eyebrow="FAQ"
              title="Questions, answered"
              intro="What JobFlow does, and what it deliberately leaves to the professionals."
            />
            <div className="mt-10 space-y-4">
              {faqs.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-2xl border bg-card p-6 text-card-foreground"
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {faq.q}
                    <span
                      aria-hidden="true"
                      className="text-xl transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-muted-foreground">{faq.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="cta" className="px-4 pb-20 md:px-6">
          <Reveal className="mx-auto max-w-6xl rounded-3xl bg-primary px-6 py-14 text-center text-primary-foreground md:px-12">
            <h2
              id="cta"
              className="text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              Ready to see every job clearly?
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg">
              Create an account for your business, or sign in if you already
              have one.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/signup"
                className={buttonVariants({ variant: "outline" })}
              >
                Sign up
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center rounded-sm px-4 py-2 font-medium text-primary-foreground underline"
              >
                Sign in
              </Link>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-border/40">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between md:px-6">
          <p>© 2026 JobFlow. Job management for Australian contractors.</p>
          <p className="max-w-xl">
            GST/BAS figures are drafts for review by your accountant or
            registered tax agent. JobFlow does not lodge with the ATO and does
            not provide payroll, PAYG withholding, STP or superannuation.
          </p>
        </div>
      </footer>
    </LandingMotion>
  );
}
