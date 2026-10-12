// What the shared store really holds for a thread, for the audit panel. Reads
// go through the same load balancer, so any replica may answer: the point is
// that the session and the incidents table are shared, the ledger (0.8.0) is not.
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const ADK_URL = process.env.ADK_URL ?? "http://127.0.0.1:8300";

export async function GET(req: NextRequest) {
  const thread = req.nextUrl.searchParams.get("thread") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(thread)) {
    return Response.json({ error: "bad thread id" }, { status: 400 });
  }
  try {
    const [session, incidents] = await Promise.all([
      fetch(`${ADK_URL}/debug/threads/${thread}`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`${ADK_URL}/debug/incidents?thread=${thread}`, { cache: "no-store" }).then((r) => r.json()),
    ]);
    return Response.json({ session, incidents });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
