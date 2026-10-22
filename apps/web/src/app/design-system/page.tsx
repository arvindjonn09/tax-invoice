import Link from "next/link";
import { MoneyDisplay } from "@/components/money-display";
import { StatusPill, type Status } from "@/components/status-pill";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
export default function DesignSystem() {
  return (
    <main className="foundation">
      <Link href="/">Back to foundation</Link>
      <section
        aria-label="Design preview"
        className="rounded-lg border bg-warning p-4 text-warning-foreground"
      >
        <strong>Design preview — not real data</strong>
        <p>Static component samples. Financial actions are unavailable.</p>
      </section>
      <h1>Design system foundations</h1>
      <ThemeToggle />
      <section className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
        <h2>Money presentation</h2>
        <p>
          Sample authoritative amounts in AUD. No tax calculation is performed.
        </p>
        <ul className="space-y-2">
          <li>
            <MoneyDisplay cents={250000} basis="ex GST" />
          </li>
          <li>
            <MoneyDisplay cents={-1500} basis="incl GST" />
          </li>
          <li>
            <MoneyDisplay cents={0} basis="ex GST" />
          </li>
          <li>
            <MoneyDisplay unavailable basis="incl GST" />
          </li>
        </ul>
      </section>
      <section className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
        <h2>Written statuses</h2>
        <div className="flex flex-wrap gap-2">
          {(
            [
              "draft",
              "active",
              "completed",
              "paid",
              "pending",
              "overdue",
              "void",
            ] as Status[]
          ).map((status) => (
            <StatusPill key={status} status={status} />
          ))}
        </div>
        <p>Paid describes settlement only; it does not describe profit.</p>
      </section>
      <section className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
        <h2>Button samples</h2>
        <p>Samples are disabled because no financial actions are available.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled>Issue invoice (sample)</Button>
          <Button variant="outline" disabled>
            Save draft (sample)
          </Button>
        </div>
        <Button asChild>
          <Link href="/">Return to foundation</Link>
        </Button>
      </section>
    </main>
  );
}
