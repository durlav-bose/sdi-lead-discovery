import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await (ctx as unknown as { params: Promise<{ runId: string }> }).params;

  const encoder = new TextEncoder();

  let lastCreatedAt = new Date(0);

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`retry: 1500\n\n`));

      try {
        while (true) {
          const events = await prisma.logEvent.findMany({
            where: {
              runId,
              createdAt: { gt: lastCreatedAt }
            },
            orderBy: { createdAt: "asc" },
            take: 50
          });

          for (const ev of events) {
            lastCreatedAt = ev.createdAt;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "event", payload: ev })}\n\n`));
          }

          // periodic tick for UI refresh (run/leads)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "tick", payload: { t: Date.now() } })}\n\n`));

          await sleep(1200);
        }
      } catch {
        // client disconnected
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
