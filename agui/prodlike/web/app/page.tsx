"use client";

// A CopilotKit app the way teams build them: the CopilotKit provider pointed at
// the runtime route, the stock chat component, and an agent that shares state
// with the page (useCoAgent). Nothing here knows about replicas or ledgers.
//
// The right-hand panel is instrumentation only: it reads what the SHARED store
// holds for this thread (session turns + incidents) through the load balancer.

import { CopilotKit, useCoAgent } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCallback, useEffect, useState } from "react";

type DeskState = { environment: string };

type Turn = { author: string; text: string; served_by: string | null };
type Incident = {
  id: number; service: string; environment: string; severity: string;
  summary: string; opened_by_pod: string; repeat: boolean;
};
type Audit = {
  session?: {
    exists: boolean; ag_ui_adk: string; served_by: string; events: number;
    user_turns: number; turns: Turn[]; duplicates: { text: string; times: number }[];
    ledger_markers: number;
  };
  incidents?: { incidents: Incident[] };
  error?: string;
};

function newThreadId() {
  return "desk-" + crypto.randomUUID().slice(0, 12);
}

export default function Page() {
  const [thread, setThread] = useState<string | null>(null);

  // Keep the thread in the URL so a page refresh stays on the same thread,
  // as a real app restoring a conversation would.
  useEffect(() => {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("thread") || newThreadId();
    url.searchParams.set("thread", t);
    window.history.replaceState(null, "", url);
    setThread(t);
  }, []);

  if (!thread) return null;
  return (
    // key: a new thread is a fresh CopilotKit session (empty chat).
    <CopilotKit key={thread} runtimeUrl="/api/copilotkit" agent="support_desk" threadId={thread}>
      <Desk
        thread={thread}
        onNewThread={() => {
          const t = newThreadId();
          const url = new URL(window.location.href);
          url.searchParams.set("thread", t);
          window.history.replaceState(null, "", url);
          setThread(t);
        }}
      />
    </CopilotKit>
  );
}

function Desk({ thread, onNewThread }: { thread: string; onNewThread: () => void }) {
  // Shared state between this page and the agent. Changing it and calling
  // run() is how a CopilotKit app lets the agent react to something the user
  // did in the UI. The run carries the whole conversation and nothing new.
  const { state, setState, run, running } = useCoAgent<DeskState>({
    name: "support_desk",
    initialState: { environment: "production" },
  });
  const [audit, setAudit] = useState<Audit>({});

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/audit?thread=${thread}`, { cache: "no-store" });
      setAudit(await r.json());
    } catch (e) {
      setAudit({ error: String(e) });
    }
  }, [thread]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const s = audit.session;
  const incidents = audit.incidents?.incidents ?? [];
  const repeatedIncidents = incidents.filter((i) => i.repeat).length;
  const dupTexts = new Set((s?.duplicates ?? []).map((d) => d.text));
  const broken = (s?.duplicates.length ?? 0) > 0 || repeatedIncidents > 0;

  return (
    <>
      <header>
        <h1>Support desk</h1>
        <span className="muted">CopilotKit → runtime → load balancer → 3 ADK replicas → one Postgres</span>
        <span className="mono muted">thread {thread}</span>
      </header>
      <main>
        <section className="chat">
          <CopilotChat
            labels={{
              title: "Support desk",
              initial: 'Try "how is checkout-api?", then "checkout-api is down, open an incident".',
            }}
          />
        </section>
        <section>
          <h2>On-call console</h2>
          <div className="row">
            <label htmlFor="env">Environment</label>
            <select
              id="env"
              value={state?.environment ?? "production"}
              disabled={running}
              onChange={async (e) => {
                setState({ ...(state ?? { environment: "production" }), environment: e.target.value });
                await run();
              }}
            >
              <option value="production">production</option>
              <option value="staging">staging</option>
            </select>
            <button disabled={running} onClick={() => run()} title="What an app's Retry button does after a dropped stream: run again with the same conversation">
              Retry last run
            </button>
            <button onClick={onNewThread}>New conversation</button>
          </div>
          <p className="help">
            Switching the environment shares it with the agent and re-runs it (<span className="mono">useCoAgent().run()</span>):
            the whole conversation, nothing new. <b>Retry</b> sends the same thing, as after a dropped stream.
          </p>

          <h2>What the shared store holds</h2>
          {audit.error && <div className="note err">Audit unavailable: {audit.error}</div>}
          {s && !s.exists && <div className="note">No session yet. Ask something.</div>}
          {s?.exists && (
            <div className={"note " + (broken ? "err" : "ok")}>
              {broken
                ? `Duplicated work: ${s.duplicates.map((d) => `“${d.text.slice(0, 60)}” ×${d.times}`).join("; ") || "none in chat"}` +
                  (repeatedIncidents ? `; ${repeatedIncidents} repeated incident(s): on-call paged again` : "") +
                  ". A replica that had not processed that message treated the re-sent history as new (ag-ui#2603)."
                : `${s.user_turns} message(s), each processed once (${s.events} session events).`}
              <div className="mono muted">
                ag-ui-adk {s.ag_ui_adk} · ledger entries in the shared session: {s.ledger_markers}
                {s.ledger_markers === 0 ? " (kept in each pod's memory)" : ""}
              </div>
            </div>
          )}
          <div className="list">
            {(s?.turns ?? []).map((t, i) => (
              <div key={i} className={t.author === "user" && dupTexts.has(t.text) ? "bad" : ""}>
                {t.author === "user" ? "user · " : <>agent <span className="pod">{t.served_by ?? "?"}</span> · </>}
                {t.text}
              </div>
            ))}
          </div>

          <h2>Incidents opened</h2>
          {incidents.length === 0 && <div className="help">None for this thread.</div>}
          <div className="list">
            {incidents.map((i) => (
              <div key={i.id} className={i.repeat ? "bad" : ""}>
                <span className="mono">INC-{String(i.id).padStart(4, "0")}</span> {i.severity} {i.service} ({i.environment}) by{" "}
                <span className="pod">{i.opened_by_pod}</span>
                {i.repeat ? " — REPEAT" : ""}
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
