import { ThemeToggle } from "@/components/theme-toggle";
export default function Home() {
  return (
    <main className="foundation">
      <ThemeToggle />
      <p>JobFlow · Foundation</p>
      <h1>A clear view of every job.</h1>
      <p>
        Job management, invoicing and profitability for Australian contractors.
      </p>
      <aside className="rounded-lg border bg-card p-6 text-card-foreground">
        <h2>Implementation in progress</h2>
        <p>
          This is the application scaffold. Customer records, authentication and
          financial workflows are not available yet.
        </p>
      </aside>
    </main>
  );
}
