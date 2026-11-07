import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROLES, can } from "../../packages/authz/src/index";

// #61: every API route, method and the permission it requires, with the
// roles that hold it, generated from the code. docs/security/route-matrix.md
// is this output; tests/unit/route-matrix.test.ts fails when they drift.

const API = join(import.meta.dirname, "../../apps/web/src/app/api");
export const MATRIX_DOC = join(
  import.meta.dirname,
  "../../docs/security/route-matrix.md",
);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : /^route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

export type RouteEntry = {
  route: string;
  method: string;
  permission: string | null;
  /** Behind withOperator: platform operators only (ADR 0004 D5). */
  operator?: boolean;
};

export function routeEntries(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const path of files(API)) {
    const source = readFileSync(path, "utf8");
    const route = `/api/${relative(API, path)
      .replaceAll("\\", "/")
      .replace(/\/?route\.[a-z]+$/, "")}`;
    // A permission in a constant couldn't be listed, so it's refused (#260).
    if (/withPolicy\(\s*[^"\s]/.test(source))
      throw new Error(`${route}: give withPolicy a literal permission`);
    for (const match of source.matchAll(
      /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*withPolicy\(\s*"([a-z_.]+)"/g,
    ))
      entries.push({ route, method: match[1]!, permission: match[2]! });
    for (const match of source.matchAll(
      /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*withOperator\(/g,
    ))
      entries.push({
        route,
        method: match[1]!,
        permission: null,
        operator: true,
      });
    for (const match of source.matchAll(
      /export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b(?!\s*=\s*with(?:Policy|Operator))/g,
    ))
      entries.push({ route, method: match[1]!, permission: null });
  }
  return entries.sort(
    (a, b) =>
      a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
  );
}

export function matrixMarkdown(entries = routeEntries()): string {
  const rows = entries.map(({ route, method, permission, operator }) => {
    const roles = operator
      ? "platform operator only (withOperator)"
      : permission
        ? ROLES.filter((role) => can(role, permission)).join(", ")
        : "public (see route-policy.test.ts)";
    return `| \`${route}\` | ${method} | ${permission ? `\`${permission}\`` : "—"} | ${roles} |`;
  });
  return [
    "# API route permission matrix (#61)",
    "",
    "Generated from the route files and `packages/authz/src/policy.ts` by `pnpm exec tsx tests/helpers/route-matrix.ts --write`. `tests/unit/route-matrix.test.ts` fails if this file is out of date. Every route is deny-by-default (`withPolicy`); each handler also checks company and object scope.",
    "",
    "| Route | Method | Permission | Roles |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

if (process.argv.includes("--write"))
  writeFileSync(MATRIX_DOC, matrixMarkdown());
