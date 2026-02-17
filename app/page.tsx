"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Run = {
  id: string;
  status: string;
  createdAt: string;
  searchIndustry: string;
  searchLocation: string;
  searchDetailedCtx: string;
  targetLeadCount: number;
};

type Lead = {
  id: string;
  company_name: string | null;
  company_website: string | null;
  company_email: string | null;
  company_phone: string | null;
  quality_status: "VERIFIED" | "NEEDS_REVIEW" | "INCOMPLETE";
};

type LogEvent = {
  id: string;
  createdAt: string;
  level: string;
  stage: string;
  message: string;
};

export default function Page() {
  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("");
  const [detailed, setDetailed] = useState("");
  const [customChecks, setCustomChecks] = useState("");
  const [count, setCount] = useState(25);

  const [run, setRun] = useState<Run | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Detailed context is optional (used as URL seeds in dev)
  const canStart = industry.trim().length > 0 && location.trim().length > 0;

  async function refresh(runId: string) {
    const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    const data = await res.json();
    setRun(data.run);
    setLeads(data.leads);
  }

  async function startRun() {
    setLoading(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchIndustry: industry,
          searchLocation: location,
          searchDetailedCtx: detailed,
          customChecksRaw: customChecks,
          targetLeadCount: count
        })
      });
      const data = await res.json();
      await refresh(data.runId);
      startSse(data.runId);
    } finally {
      setLoading(false);
    }
  }

  function startSse(runId: string) {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const es = new EventSource(`/api/runs/${runId}/events`);
    eventSourceRef.current = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; payload: any };
        if (msg.type === "event") {
          setLogs((prev) => [...prev, msg.payload].slice(-500));
        }
        if (msg.type === "tick") {
          refresh(runId);
        }
      } catch {}
    };
    es.onerror = () => {
      // auto-reconnect handled by browser
    };
  }

  async function stopRun() {
    if (!run) return;
    await fetch(`/api/runs/${run.id}/stop`, { method: "POST" });
    await refresh(run.id);
  }

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  const stats = useMemo(() => {
    const v = leads.filter((l) => l.quality_status === "VERIFIED").length;
    const r = leads.filter((l) => l.quality_status === "NEEDS_REVIEW").length;
    const i = leads.filter((l) => l.quality_status === "INCOMPLETE").length;
    return { v, r, i };
  }, [leads]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ margin: 0 }}>SDI Lead Discovery</h1>

      <div className="card">
        <div className="grid">
          <div>
            <label>Target industry</label>
            <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Building maintenance" />
          </div>
          <div>
            <label>Target location</label>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Zürich / CH" />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <label>Detailed target context (optional)</label>
            <textarea
              value={detailed}
              onChange={(e) => setDetailed(e.target.value)}
              placeholder="Optional: constraints, notes, or paste a few company URLs as seeds (dev mode)."
            />
            <div className="small">If you paste URLs here, they will be used as discovery seeds.</div>
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <label>Custom checks (optional, one per line)</label>
            <textarea value={customChecks} onChange={(e) => setCustomChecks(e.target.value)} placeholder="Has booking calendar (boolean)
Uses Shopify (boolean)" />
          </div>

          <div>
            <label>Target lead count</label>
            <input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} min={1} max={2000} />
          </div>

          <div className="row" style={{ alignItems: "end" }}>
            <button disabled={!canStart || loading} onClick={startRun}>
              {loading ? "Starting..." : "Start"}
            </button>
            <button className="danger" disabled={!run || run.status !== "RUNNING"} onClick={stopRun}>
              Stop
            </button>
            {run ? <span className="small">Run: {run.id} | Status: {run.status}</span> : <span className="small">No run yet</span>}
          </div>
        </div>
      </div>

      {run && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <span className={"badge ok"}>VERIFIED {stats.v}</span>
              <span className={"badge warn"}>NEEDS_REVIEW {stats.r}</span>
              <span className={"badge bad"}>INCOMPLETE {stats.i}</span>
            </div>
            <div className="row">
              <a href={`/api/runs/${run.id}/export?type=verified`}><button className="secondary">Download verified.csv</button></a>
              <a href={`/api/runs/${run.id}/export?type=needs_review`}><button className="secondary">Download needs_review.csv</button></a>
            </div>
          </div>

          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Company</th>
                  <th>Website</th>
                  <th>Email</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className={"badge " + (l.quality_status === "VERIFIED" ? "ok" : l.quality_status === "NEEDS_REVIEW" ? "warn" : "bad")}>
                        {l.quality_status}
                      </span>
                    </td>
                    <td>{l.company_name ?? ""}</td>
                    <td>{l.company_website ? <a href={l.company_website} target="_blank">{l.company_website}</a> : ""}</td>
                    <td>{l.company_email ?? ""}</td>
                    <td>{l.company_phone ?? ""}</td>
                  </tr>
                ))}
                {leads.length === 0 && (
                  <tr>
                    <td colSpan={5} className="small">No leads yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="small" style={{ marginBottom: 8 }}>Live log (SSE)</div>
            <div className="log">
              {logs.map((e) => (
                <div key={e.id}>
                  [{new Date(e.createdAt).toLocaleTimeString()}] {e.level.toUpperCase()} {e.stage}: {e.message}
                </div>
              ))}
              {logs.length === 0 && <div>Waiting…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
