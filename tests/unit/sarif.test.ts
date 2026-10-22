import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  ["clean", { version: "2.1.0", runs: [{ results: [] }] }, 0],
  [
    "finding",
    { version: "2.1.0", runs: [{ results: [{ ruleId: "test" }] }] },
    1,
  ],
  ["missing results", { version: "2.1.0", runs: [{}] }, 1],
  ["empty runs", { version: "2.1.0", runs: [] }, 1],
  [
    "failed invocation",
    {
      version: "2.1.0",
      runs: [{ results: [], invocations: [{ executionSuccessful: false }] }],
    },
    1,
  ],
  ["no report", undefined, 1],
])(
  "SARIF gate rejects incomplete or unsafe analysis: %s",
  (_name, report, status) => {
    const directory = mkdtempSync(join(tmpdir(), "jobflow-sarif-"));
    try {
      if (report)
        writeFileSync(
          join(directory, "analysis.sarif"),
          JSON.stringify(report),
        );
      const result = spawnSync(process.execPath, [
        "scripts/check-sarif.mjs",
        directory,
      ]);
      expect(result.status).toBe(status);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
