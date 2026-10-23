// Australian Business Number checksum (ATO "Format of the ABN"):
// subtract 1 from the first digit, weight the 11 digits by
// 10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, sum, and the total must divide by 89.
const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

/** Digits only, or null if the input has anything but digits and spaces. */
export function normaliseAbn(input: string): string | null {
  const trimmed = input.trim();
  if (!/^[\d ]+$/.test(trimmed)) return null;
  const digits = trimmed.replaceAll(" ", "");
  return /^\d{11}$/.test(digits) ? digits : null;
}

/** True only for 11 digits (spaces allowed) that pass the ATO checksum. */
export function isValidAbn(input: string): boolean {
  const digits = normaliseAbn(input);
  if (!digits || digits[0] === "0") return false;
  const sum = WEIGHTS.reduce(
    (total, weight, index) =>
      total + weight * (Number(digits[index]) - (index === 0 ? 1 : 0)),
    0,
  );
  return sum % 89 === 0;
}

/** "NN NNN NNN NNN", the format printed on tax invoices. */
export function formatAbn(digits: string): string {
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 11)}`;
}
