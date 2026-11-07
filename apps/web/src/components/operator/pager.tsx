import Link from "next/link";

const LINK = "inline-flex min-h-11 items-center font-semibold underline";

/** The page number from `?page=`, from 1 to 1000. */
export function pageFrom(value: string | string[] | undefined): number {
  const raw = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : 1;
}

/** Previous and next links; "next" only when this page was full. */
export function Pager({
  page,
  full,
  href,
}: {
  page: number;
  full: boolean;
  href: (page: number) => string;
}) {
  if (page === 1 && !full) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-6">
      {page > 1 ? (
        <Link href={href(page - 1)} className={LINK}>
          Previous page
        </Link>
      ) : null}
      <span>Page {page}</span>
      {full ? (
        <Link href={href(page + 1)} className={LINK}>
          Next page
        </Link>
      ) : null}
    </nav>
  );
}
