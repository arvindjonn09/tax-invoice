import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { repositoryRoot } from "./environment.mjs";
import { join } from "node:path";

try {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV === "production"
  )
    throw new Error("Local environment generation is forbidden in production");
  const password = randomBytes(24).toString("hex");
  const minioPassword = randomBytes(24).toString("hex");
  const authSecret = randomBytes(32).toString("hex");
  const environment = `# Generated local credentials; never commit or use in production.\nAPP_ENV=development\nPOSTGRES_USER=jobflow\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=jobflow\nPOSTGRES_PORT=5432\nDATABASE_URL=postgresql://jobflow:${password}@127.0.0.1:5432/jobflow\nTEST_DATABASE_URL=postgresql://jobflow:${password}@127.0.0.1:5432/jobflow_test\nMINIO_ROOT_USER=jobflow-local\nMINIO_ROOT_PASSWORD=${minioPassword}\nMINIO_API_PORT=9000\nMINIO_CONSOLE_PORT=9001\nBETTER_AUTH_SECRET=${authSecret}\nBETTER_AUTH_URL=http://localhost:3000\n`;
  writeFileSync(join(repositoryRoot, ".env"), environment, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created private local .env; existing files are never overwritten",
  );
} catch {
  console.error(
    "Cannot create local .env: production mode or an existing file; no file was overwritten",
  );
  process.exitCode = 1;
}
