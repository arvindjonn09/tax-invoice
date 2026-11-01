"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: loaded by require() from @next/eslint-plugin-next */
// Development-only stand-in for fast-glob, used through a pnpm override by
// @next/eslint-plugin-next, whose only call is
// globSync(rootDir, { onlyDirectories: true }) to find the Next.js root from
// the ESLint `settings.next.rootDir`. Node's built-in fs.globSync covers that
// without fast-glob → micromatch → braces (GHSA-vfj7-8cjw-p6xm, no fixed
// version). Any other use fails loudly rather than guessing.
const { globSync: nodeGlobSync } = require("node:fs");
const path = require("node:path");

// Trailing slashes, trimmed without a regular expression (no backtracking on
// long runs of "/").
function trimSlashes(value) {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function globSync(pattern, options = {}) {
  const extra = Object.keys(options).filter((key) => key !== "onlyDirectories");
  if (typeof pattern !== "string" || !options.onlyDirectories || extra.length)
    throw new Error(
      "fast-glob-shim supports only globSync(pattern, { onlyDirectories: true })",
    );
  const trailingSlash = pattern.endsWith("/");
  const absolute = path.isAbsolute(pattern);
  const cwd = process.cwd();
  return nodeGlobSync(trimSlashes(pattern), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const shown = (absolute ? full : path.relative(cwd, full) || ".")
        .split(path.sep)
        .join("/");
      return trailingSlash ? `${shown}/` : shown;
    });
}

module.exports = { globSync, sync: globSync };
