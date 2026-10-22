# ADR 0001: Modular monolith and workspace scaffold

Status: proposed for review under issue #8. Date: 22 October 2026.

## Context
JobFlow needs tenant isolation, auditable financial operations and one shared GST/profit domain. The existing architecture specifies a modular monolith. This change establishes boundaries without implementing later issues.

## Decision
Use Node.js 24.x (selected by .nvmrc in development and CI), pnpm 9.15.4, Next.js 16.4.2 App Router, React 19.3.1, TypeScript 5.9.3, ESLint 9, Prettier 3, Vitest 5 and Playwright 1.64.1. Exact resolved dependency versions are recorded in pnpm-lock.yaml. Runtime dependencies are pinned. Node 24 was used for local verification.

The app lives in apps/web. Reserved workspace packages are database, domain, authz and shared-types. Packages expose TypeScript sources; Next.js compilation is the application build boundary. Each package extends the root strict configuration. The typecheck command also inspects effective compiler options to reject local strict-mode overrides.

PostgreSQL/Prisma and Docker are introduced in #9, authentication in its subsequent foundation issue, and Tailwind/shadcn in the design-system issue. No schema, credentials, financial logic or copied UI components are introduced here. These later choices remain as specified in ARCHITECTURE.md.

The public /api/health endpoint is liveness only: no database probe or configuration disclosure. Business routes must receive authentication and server-side object authorisation before introduction.

## Alternatives
A single package is simpler initially but hides the shared-domain and authorisation boundaries. Microservices add operational and transactional complexity without benefit for the initial company. Both were rejected.

## Consequences
One installation and lockfile cover all packages. Tests are split into unit, route-level integration and browser suites; database integration arrives with #9. The placeholder is intentionally not the dashboard preview. External fonts are avoided, so build does not depend on a font service. CI runs verification; branch protection and the complete security pipeline remain #10.

## References
- https://nextjs.org/docs/app/getting-started/installation
- https://www.typescriptlang.org/tsconfig/strict.html
- https://vitest.dev/guide/
- ../ARCHITECTURE.md
