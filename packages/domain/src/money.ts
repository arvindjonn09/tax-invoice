/**
 * AUD amounts are integer cents held as `bigint`, so floating-point money cannot
 * type-check anywhere in the domain. Convert at the boundary with `toCents`.
 */
export type Cents = bigint;

/** Convert an integer number of cents (e.g. from JSON or the database) to `Cents`. */
export function toCents(value: number | bigint): Cents {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Money must be a safe integer number of cents");
  }
  return BigInt(value);
}

/** Integer division rounded to the nearest unit, halves away from zero (R3). */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("Denominator must be positive");
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const rounded =
    (magnitude % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0n);
}

/** A rational fraction 0 ≤ numerator/denominator ≤ 1 (e.g. creditable business use). */
export type Fraction = { numerator: bigint; denominator: bigint };

export const WHOLE: Fraction = { numerator: 1n, denominator: 1n };
export const NONE: Fraction = { numerator: 0n, denominator: 1n };

export function assertFraction(fraction: Fraction): Fraction {
  if (
    fraction.denominator <= 0n ||
    fraction.numerator < 0n ||
    fraction.numerator > fraction.denominator
  ) {
    throw new RangeError("Fraction must be between 0 and 1");
  }
  return fraction;
}

/** amount × fraction, rounded to the cent with `divideRounded`. */
export function multiplyByFraction(amount: Cents, fraction: Fraction): Cents {
  assertFraction(fraction);
  return divideRounded(amount * fraction.numerator, fraction.denominator);
}

/**
 * Split `amount` across `weights` exactly (largest remainder; ties go to the
 * earlier weight, i.e. the stable line order). The parts always sum to `amount`.
 */
export function allocateProRata(
  amount: Cents,
  weights: readonly bigint[],
): Cents[] {
  if (amount < 0n) throw new RangeError("Allocated amount must be >= 0");
  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError("Weights must be >= 0");
  }
  const total = sum(weights);
  if (total === 0n) throw new RangeError("Weights must not all be zero");
  const parts = weights.map((weight) => (amount * weight) / total);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (amount * weight) % total,
  }));
  let left = amount - sum(parts);
  remainders.sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const { index } of remainders) {
    if (left === 0n) break;
    parts[index] = (parts[index] as bigint) + 1n;
    left -= 1n;
  }
  return parts;
}
