// #330: E2E runs against a production build, and every production build
// requires the upload scanner (#136). Playwright starts this fake clamd
// before the app (playwright.config.ts). It answers PING and reports only the
// fake-only TEST_MARKER and EICAR as infected, like the integration tests.
import { startFakeClamd } from "../helpers/fake-clamd";

const port = Number(process.env.JOBFLOW_E2E_CLAMD_PORT ?? 3311);
const clamd = await startFakeClamd(port);
console.log(`fake clamd listening on 127.0.0.1:${clamd.port}`);
const stop = () => void clamd.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
