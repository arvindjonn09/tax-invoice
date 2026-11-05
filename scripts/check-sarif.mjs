import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Uploading CodeQL results alone does not fail the workflow for findings.
// Fail closed if analysis produced no report, failed, or found any issue,
// except owner-approved exceptions in .github/codeql-exceptions.json, each
// bound to one rule in one file (docs/security/static-analysis-exceptions.md).
const directory = process.argv[2];
if (!directory) throw new Error("A SARIF directory is required");
const exceptionsFile = new URL(
  "../.github/codeql-exceptions.json",
  import.meta.url,
);
const exceptions = existsSync(exceptionsFile)
  ? JSON.parse(readFileSync(exceptionsFile, "utf8"))
  : [];
for (const exception of exceptions) {
  if (
    !exception.rule ||
    !exception.path ||
    !exception.reason ||
    !exception.approvedBy
  )
    throw new Error(
      "Each CodeQL exception needs rule, path, reason and approvedBy",
    );
}
const excepted = (result) => {
  const paths = (result.locations ?? []).map(
    (location) => location.physicalLocation?.artifactLocation?.uri,
  );
  return (
    paths.length > 0 &&
    paths.every((path) =>
      exceptions.some(
        (exception) =>
          exception.rule === result.ruleId && exception.path === path,
      ),
    )
  );
};
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
    const findings = run.results.filter((result) => !excepted(result));
    for (const result of run.results.filter(excepted))
      console.log(`Approved exception: ${result.ruleId}`);
    if (findings.length) {
      for (const result of findings)
        console.error(
          `${result.ruleId} ${result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "?"}`,
        );
      throw new Error("Static-analysis findings require review");
    }
  }
}
console.log("Static analysis passed without unapproved findings");
