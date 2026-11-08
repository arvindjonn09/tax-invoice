import { getDatabase } from "../auth";
import type { DocumentDeps } from "./handlers";
import { scannerFromEnvironment } from "./scanner";
import { type ObjectStore, storeFromEnvironment } from "./store";

let store: ObjectStore | null | undefined;

let scanning: ReturnType<typeof scannerFromEnvironment> | undefined;

export const documentDeps: DocumentDeps = {
  scanner: () => (scanning ??= scannerFromEnvironment()),
  db: getDatabase,
  store: () => (store === undefined ? (store = storeFromEnvironment()) : store),
  secret: () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
    return secret;
  },
};
