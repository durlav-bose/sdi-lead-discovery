import { Queue } from "bullmq";
import { redis } from "./redis";

export const leadQueue = new Queue("lead-discovery", { connection: redis });

export type QueueJobName =
  | "discover"
  | "qualify"
  | "enrich"
  | "finalize";

export type DiscoverJobData = { runId: string };
