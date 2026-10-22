import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Uploading CodeQL results alone does not fail the workflow for findings.
// Fail closed if analysis produced no report, failed, or found any issue.
const directory = process.argv[2];
if (!directory) throw new Error("A SARIF directory is required");
const files = readdirSync(directory).filter((file) => file.endsWith(".sarif"));
if (!files.length) throw new Error("No SARIF reports produced");
for (const file of files) {
  const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
  if (report.version !== "2.1.0" || !report.runs?.length)
    throw new Error("Invalid SARIF report");
  for (const run of report.runs) {
    if (!Array.isArray(run.results))
      throw new Error("Missing analysis results");
    if (run.invocations?.some((invocation) => !invocation.executionSuccessful))
      throw new Error("Static analysis did not complete successfully");
    if (run.results.length)
      throw new Error("Static-analysis findings require review");
  }
}
console.log("Static analysis passed without findings");
