import ts from "typescript";
import { dirname, resolve } from "node:path";
import { readdirSync } from "node:fs";
const paths = [
  "tsconfig.json",
  ...["apps", "packages"].flatMap((root) =>
    readdirSync(root).map((name) => `${root}/${name}/tsconfig.json`),
  ),
];
for (const path of paths) {
  const file = ts.readConfigFile(path, ts.sys.readFile);
  if (file.error) throw new Error(`Cannot read ${path}`);
  const parsed = ts.parseJsonConfigFileContent(
    file.config,
    ts.sys,
    dirname(resolve(path)),
  );
  for (const flag of [
    "strict",
    "noImplicitAny",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "noImplicitThis",
    "alwaysStrict",
    "strictBuiltinIteratorReturn",
  ]) {
    if ((parsed.options[flag] ?? parsed.options.strict) !== true)
      throw new Error(`${path}: ${flag} must be enabled`);
  }
}
