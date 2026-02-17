import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rowsToCsv, toCsvRow } from "@/server/export/csv";

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await (ctx as unknown as { params: Promise<{ runId: string }> }).params;
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "verified";

  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const where =
    type === "verified"
      ? { runId, quality_status: "VERIFIED" }
      : type === "needs_review"
        ? { runId, quality_status: { in: ["NEEDS_REVIEW", "INCOMPLETE"] } }
        : { runId };

  const leads = await prisma.lead.findMany({ where: where as any, orderBy: { createdAt: "asc" } });
  const rows = leads.map(toCsvRow);
  const csv = rowsToCsv(rows);
  const csvWithBom = "\ufeff" + csv;

  const filename = type === "verified" ? "verified.csv" : type === "needs_review" ? "needs_review.csv" : "all.csv";

  return new Response(csvWithBom, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${filename}`
    }
  });
}
