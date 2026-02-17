import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "@/lib/redis";
import { runLeadDiscovery } from "@/server/pipeline";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/lib/log";

const worker = new Worker(
  "lead-discovery",
  async (job) => {
    const runId = (job.data as any).runId as string;
    try {
      await runLeadDiscovery(runId);
    } catch (e: any) {
      await prisma.run.update({ where: { id: runId }, data: { status: "FAILED" } }).catch(() => {});
      await logEvent({
        runId,
        level: "error",
        stage: "system",
        message: "Run failed",
        data: { error: String(e?.message ?? e) }
      }).catch(() => {});
      throw e;
    }
  },
  { connection: redis }
);

worker.on("completed", (job) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker] failed job ${job?.id}`, err);
});

// eslint-disable-next-line no-console
console.log("[worker] lead-discovery worker running...");
