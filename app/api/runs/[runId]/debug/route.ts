import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await (ctx as unknown as { params: Promise<{ runId: string }> }).params;

  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const leads = await prisma.lead.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
  const events = await prisma.logEvent.findMany({ where: { runId }, orderBy: { createdAt: "asc" }, take: 300 });

  return NextResponse.json({ run, leads, events });
}
