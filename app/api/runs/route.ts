import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { leadQueue } from "@/lib/queue";
import { parseCustomChecks } from "@/server/customChecks";
import { z } from "zod";

const BodySchema = z.object({
  searchIndustry: z.string().min(1),
  searchLocation: z.string().min(1),
  searchDetailedCtx: z.string().optional().default(""),
  customChecksRaw: z.string().optional().default(""),
  targetLeadCount: z.number().int().min(1).max(2000).optional().default(25)
});

export async function POST(req: Request) {
  const json = await req.json();
  const body = BodySchema.parse(json);

  const parsed = parseCustomChecks(body.customChecksRaw);

  const run = await prisma.run.create({
    data: {
      searchIndustry: body.searchIndustry,
      searchLocation: body.searchLocation,
      searchDetailedCtx: body.searchDetailedCtx,
      customChecksRaw: parsed.raw,
      customChecksJson: parsed.checks as any,
      targetLeadCount: body.targetLeadCount,
      status: "QUEUED"
    }
  });

  await leadQueue.add("discover", { runId: run.id }, { removeOnComplete: true, removeOnFail: 100 });

  return NextResponse.json({ runId: run.id });
}
