import { getDatabase } from "../auth";
import type { DocumentDeps } from "./handlers";
import { type ObjectStore, storeFromEnvironment } from "./store";

let store: ObjectStore | null | undefined;

export const documentDeps: DocumentDeps = {
  db: getDatabase,
  store: () => (store === undefined ? (store = storeFromEnvironment()) : store),
  secret: () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
    return secret;
  },
};
