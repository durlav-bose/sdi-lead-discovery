import { prisma } from "./prisma";

export async function logEvent(params: {
  runId: string;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  data?: unknown;
}) {
  const { runId, level, stage, message, data } = params;
  await prisma.logEvent.create({
    data: {
      runId,
      level,
      stage,
      message,
      data: data as any
    }
  });
}
