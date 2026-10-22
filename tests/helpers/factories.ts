// No clock, network, randomness, actual personal identifiers or global counter.
// A factory per test makes the same sequence reproducible regardless of test order.
export function syntheticFactory(seed = 1) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff)
    throw new Error("Factory seed must be a positive uint32");
  let sequence = 0;
  const id = () => {
    sequence += 1;
    if (sequence > 0xffffffff) throw new Error("Synthetic sequence exhausted");
    return `${seed.toString(16).padStart(8, "0")}-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
  };
  return {
    id,
    user() {
      const userId = id();
      return {
        id: userId,
        email: `synthetic-${userId}@example.test`,
        name: "Synthetic Test User",
      };
    },
    company(createdBy: string) {
      return {
        id: id(),
        name: "Synthetic Test Company",
        createdBy,
        isDemo: true,
      };
    },
    membership(companyId: string, userId: string) {
      return {
        id: id(),
        companyId,
        userId,
        createdBy: userId,
        role: "owner" as const,
      };
    },
  };
}
