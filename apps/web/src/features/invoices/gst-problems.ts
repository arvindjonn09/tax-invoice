/**
 * #302: a draft is priced as if registered, so a Taxable line shows its GST
 * while editing. When the company isn't registered for GST on the issue
 * (or send) date, each Taxable line is a problem linked to its GST field,
 * shown before Issue or Send rather than "No problems". The server still
 * refuses at issue; this only says so first.
 */
export function unregisteredGstProblems(
  lines: readonly { taxCode: string }[],
  registered: boolean,
  date: string,
  action: "issue" | "send",
): Record<string, string> {
  if (registered) return {};
  const problems: Record<string, string> = {};
  lines.forEach((line, index) => {
    if (line.taxCode === "TAXABLE_10")
      problems[`lines.${index}.taxCode`] =
        `Line ${index + 1} is Taxable, but the company isn't registered for GST on ${date}. Choose another GST treatment, or ${action} on a date in a registered period.`;
  });
  return problems;
}
