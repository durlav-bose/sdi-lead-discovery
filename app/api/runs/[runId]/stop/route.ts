import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/lib/log";

export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await (ctx as unknown as { params: Promise<{ runId: string }> }).params;

  await prisma.run.update({
    where: { id: runId },
    data: { stopRequested: true, status: "STOP_REQUESTED" }
  });

  await logEvent({ runId, level: "warn", stage: "system", message: "Stop requested by user" });

  return NextResponse.json({ ok: true });
}
