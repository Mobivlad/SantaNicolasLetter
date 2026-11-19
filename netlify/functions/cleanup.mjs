// Daily: deletes expired links (after 31 January) and old per-address counters
import { cleanup } from "../lib/store.mjs";

export default async () => {
  const removed = await cleanup();
  console.log(`cleanup: removed ${removed} records`);
};

export const config = { schedule: "@daily" };
