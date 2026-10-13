/* Track 7 — Mastery: the full run with every switch, and the exam. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  PG.lesson({
    id: "playground",
    track: "mastery",
    title: "The full run",
    short: "Playground",
    thesis: "One request from a person to a production change, with every piece from the course in it: sign-in, discovery, cached lists, a tool call, a confirmation through MRTR, progress, a dropped stream, and replicas. Flip the switches and see which pieces each one exercises.",
    refs: "Everything in tracks 1–6",
    brief: `
      <h2>What happens, in order</h2>
      <ol>
        <li><strong>Sign in</strong> (if required): 401 → metadata → PKCE → token for this server.</li>
        <li><strong>Discover</strong>: <code>server/discover</code> (cached for an hour), then <code>tools/list</code> (cached for 5 minutes).</li>
        <li><strong>Read</strong>: the model calls <code>get_service_status</code>. Read-only, trusted server: no confirmation.</li>
        <li><strong>Act</strong>: the model calls <code>rollback_release</code>. The server answers <code>input_required</code>; you confirm; the client retries with a new id.</li>
        <li><strong>Long work</strong>: progress arrives on the retry's stream. If the stream drops, the client re-issues the call; an idempotency key stops it rolling back twice.</li>
      </ol>
      <p>Switch to the <strong>legacy era</strong> to see the same job with <code>initialize</code>, a session, and the server calling the client back on an open stream. With more than one replica and no sticky routing, watch where it breaks.</p>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Roll back checkout-api, end to end", "Lab · everything on");
      const opt = { era: "modern", auth: true, confirm: true, drop: false, replicas: 3, sticky: false };
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "user", role: "user", label: "You", sub: "alice", x: 11, y: 12 },
          { id: "client", role: "client", label: "Host + client", sub: "ops-console", x: 14, y: 58, glyph: "H" },
          { id: "auth", role: "auth", label: "Auth server", sub: "", x: 46, y: 12 },
          { id: "r1", role: "server", label: "replica 1", x: 86, y: 30 },
          { id: "r2", role: "server", label: "replica 2", x: 86, y: 58 },
          { id: "r3", role: "server", label: "replica 3", x: 86, y: 86 },
        ],
        links: [["user", "client"], ["client", "auth"], ["client", "r1"], ["client", "r2"], ["client", "r3"]],
      });
      const wire = PG.wire(a.body);
      const steps = PG.steps(a.body, ["Sign in", "Discover + list tools", "Read: get_service_status", "Act: rollback_release (+ confirmation)", "Progress and result"]);
      const stats = h("div", { class: "score" });
      const verdict = h("div", { class: "result", text: "Set the switches, then run." });
      const run = h("button", { class: "btn primary", type: "button", text: "Run" });
      function paintReplicas() { ["r1", "r2", "r3"].forEach(function (r, i) { stage.set(r, { dim: i >= opt.replicas }); stage.badge(r, null); }); }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([{ v: "modern", label: "2026-07-28" }, { v: "legacy", label: "Legacy 2025-11-25" }], "modern", function (v) { opt.era = v; }, "Era"),
          PG.seg([{ v: 1, label: "1 replica" }, { v: 3, label: "3 replicas" }], 3, function (v) { opt.replicas = Number(v); paintReplicas(); }, "Replicas")),
        h("div", { class: "row" },
          PG.switch("pg-auth", "Requires sign-in", true, function (v) { opt.auth = v; }),
          PG.switch("pg-confirm", "Rollback needs confirmation", true, function (v) { opt.confirm = v; }),
          PG.switch("pg-drop", "Drop the stream mid-rollback", false, function (v) { opt.drop = v; }),
          PG.switch("pg-sticky", "Sticky routing (legacy)", false, function (v) { opt.sticky = v; })),
        h("div", { class: "row" }, run), verdict, stats), stage.el);
      paintReplicas();

      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); steps.reset(); paintReplicas();
        const legacy = opt.era === "legacy";
        let id = 0, msgs = 0, rr = 0, session = null, broken = null;
        const pickReplica = function () {
          if (legacy && opt.sticky && session) return session.on;
          return ["r1", "r2", "r3"][(rr++) % opt.replicas];
        };
        async function hop(from, to, label, tone) { msgs++; return stage.send(from, to, label, { tone: tone, dur: 650 }); }
        async function req(method, params, label, extra) {
          id++;
          const to = pickReplica();
          const body = legacy ? SPEC.rpc(method, params, id, { noMeta: true }) : SPEC.rpc(method, params, id, extra);
          const hdrs = legacy ? SPEC.post(null, null, session ? { "Mcp-Session-Id": session.id } : null, { legacy: true }) : SPEC.post(method, params && (params.name || params.uri));
          if (!(await hop("client", to, label || method))) return null;
          wire.add({ actor: "client", label: method + (params && params.name ? " · " + params.name : "") + " → " + to.replace("r", "replica ") + " · id " + id, http: hdrs, body: body });
          if (legacy && method !== "initialize" && (!session || session.on !== to)) {
            await hop(to, "client", "404 session", "err");
            wire.add({ kind: "in", actor: "server", label: "404 · session " + (session ? session.id : "?") + " unknown on " + to.replace("r", "replica "), status: "404", http: SPEC.res(404), body: SPEC.err(id, -32600, "Session not found") });
            broken = "Legacy session lived on " + (session ? session.on.replace("r", "replica ") : "?") + "; this request reached " + to.replace("r", "replica ") + ". Turn on sticky routing, use 1 replica, or switch to 2026-07-28.";
            return null;
          }
          return { id: id, to: to };
        }
        async function res(r, result, label, opts) {
          opts = opts || {};
          await hop(r.to, "client", label || "result", opts.tone);
          wire.add({ kind: opts.kind || "in", actor: "server", label: label || "result", status: opts.status || "200", tone: opts.statusTone, http: opts.http || SPEC.res(200), body: opts.sse ? undefined : (opts.body || SPEC.ok(r.id, result, { legacy: legacy })), sse: opts.sse });
        }

        /* 1 · sign in */
        steps.mark(0, "run");
        if (opt.auth) {
          await hop("client", "r1", "no token", "client");
          await hop("r1", "client", "401", "err");
          wire.add({ kind: "in", actor: "server", label: "401 · resource_metadata", status: "401", http: SPEC.res(401, "none", { "WWW-Authenticate": 'Bearer resource_metadata="https://release-tools.example.com/.well-known/oauth-protected-resource/mcp"' }) });
          await hop("client", "auth", "PKCE · resource");
          await hop("auth", "user", "sign in");
          await hop("user", "auth", "consent");
          await hop("auth", "client", "token");
          wire.add({ kind: "note", label: "Token issued for https://release-tools.example.com/mcp (audience), scope releases:read releases:write." });
          steps.mark(0, "pass");
        } else steps.mark(0, "pass", "Sign in · <span class='muted'>skipped (no auth required)</span>");
        if (!api.alive()) return;

        /* 2 · discover / initialize, list */
        steps.mark(1, "run");
        if (legacy) {
          const r = await req("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: {} }, clientInfo: SPEC.clientInfo }, "initialize");
          session = { id: "sess-" + PG.hex(4), on: r.to };
          stage.badge(r.to, "session");
          await res(r, { protocolVersion: "2025-11-25", capabilities: SPEC.serverCaps, serverInfo: SPEC.serverInfo }, "initialize result + Mcp-Session-Id", { http: SPEC.res(200, "json", { "Mcp-Session-Id": session.id }) });
          await hop("client", session.on, "initialized"); wire.add({ actor: "client", label: "notifications/initialized", body: SPEC.notif("notifications/initialized") });
        } else {
          const r = await req("server/discover", {}, "server/discover");
          await res(r, SPEC.discoverResult(), "discover · cached 1 h");
        }
        const rl = await req("tools/list", {}, "tools/list");
        if (!rl) return finish();
        await res(rl, { tools: SPEC.tools.map(function (t) { return { name: t.name, annotations: t.annotations }; }), ttlMs: 300000, cacheScope: "private" }, "4 tools · cached 5 min");
        steps.mark(1, "pass");

        /* 3 · read */
        steps.mark(2, "run");
        stage.badge("client", "model → get_service_status");
        const r3 = await req("tools/call", { name: "get_service_status", arguments: { service: "checkout-api" } });
        if (!r3) return finish();
        const st = { service: "checkout-api", version: "2.14.0", replicas: 6, errorRate: 0.047 };
        await res(r3, { content: [{ type: "text", text: JSON.stringify(st) }], structuredContent: st, isError: false }, "error rate 4.7%");
        stage.badge("client", null);
        steps.mark(2, "pass");

        /* 4 · act */
        steps.mark(3, "run");
        stage.badge("client", "model → rollback_release");
        const args = { service: "checkout-api", to_version: "2.13.2", idempotency_key: "rb-" + PG.hex(3) };
        const r4 = await req("tools/call", { name: "rollback_release", arguments: args });
        if (!r4) return finish();
        let retryParams = { name: "rollback_release", arguments: args };
        if (opt.confirm) {
          if (legacy) {
            await res(r4, null, "SSE: server request elicitation/create", { kind: "evt", http: SPEC.res(200, "sse"), sse: [{ jsonrpc: "2.0", id: 900, method: "elicitation/create", params: { message: "Confirm production rollback?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } } } }] });
            stage.hold("client", r4.to, true, "server");
            await hop("client", "user", "confirm?"); await hop("user", "client", "accept");
            id++;
            const to = pickReplica();
            await hop("client", to, "answer to 900");
            wire.add({ actor: "client", label: "POST response to server request 900 → " + to.replace("r", "replica "), http: SPEC.post(null, null, { "Mcp-Session-Id": session.id }, { legacy: true }), body: { jsonrpc: "2.0", id: 900, result: { action: "accept", content: { confirm: true } } } });
            if (to !== r4.to) {
              stage.hold("client", r4.to, false);
              await hop(to, "client", "404", "err");
              wire.add({ kind: "in", actor: "server", label: "404 · " + to.replace("r", "replica ") + " has no request 900 waiting", status: "404", http: SPEC.res(404) });
              broken = "The server held the rollback open in memory on " + r4.to.replace("r", "replica ") + ", waiting for your answer, and your answer went to " + to.replace("r", "replica ") + ". This is what MRTR fixed.";
              return finish();
            }
            await hop(to, "client", "202");
            stage.hold("client", r4.to, false);
          } else {
            const state = SPEC.requestState({ sub: "alice", exp: "+5m", req: "rollback_release" });
            await res(r4, { resultType: "input_required", inputRequests: { confirm: { method: "elicitation/create", params: { mode: "form", message: "Confirm production rollback?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } } } }, requestState: state }, "input_required", { status: "input_required", tone: "proxy" });
            await hop("client", "user", "confirm?"); await hop("user", "client", "accept");
            retryParams = { name: "rollback_release", arguments: args, inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, requestState: state };
          }
        }
        steps.mark(3, "pass");

        /* 5 · progress + result */
        steps.mark(4, "run");
        let r5 = legacy && opt.confirm ? r4 : await req("tools/call", retryParams, opt.confirm ? "retry · new id" : "tools/call");
        if (!r5) return finish();
        const prog = function (p) { return SPEC.notif("notifications/progress", { progressToken: "rb", progress: p, total: 3, message: ["draining", "switching", "verifying"][p - 1] }); };
        if (opt.drop && !legacy) {
          await res(r5, null, "SSE: progress 1/3 … connection lost", { kind: "evt", tone: "err", http: SPEC.res(200, "sse"), sse: [prog(1)] });
          wire.add({ kind: "note", label: "Stream broke. No resume in 2026-07-28: re-issue the same call with a new id. Same idempotency_key, so the server continues the one rollback instead of starting another." });
          r5 = await req("tools/call", retryParams, "re-issue · new id");
          if (!r5) return finish();
        }
        await res(r5, null, "SSE: progress 1/3, 2/3, 3/3, result", { kind: "evt", http: SPEC.res(200, "sse"), sse: [prog(1), prog(2), prog(3), SPEC.ok(r5.id, { content: [{ type: "text", text: "checkout-api rolled back to 2.13.2" }], isError: false }, { legacy: legacy })] });
        stage.badge("client", null);
        steps.mark(4, "pass");
        finish();

        function finish() {
          if (!api.alive()) return;
          if (broken) { const i = steps.el.querySelectorAll("li.run"); if (i.length) i[i.length - 1].className = "fail"; }
          stats.innerHTML = "";
          stats.append(h("span", { class: "chip mono", text: msgs + " hops" }), h("span", { class: "chip mono", text: id + " JSON-RPC requests" }),
            h("span", { class: "chip mono", text: legacy ? "1 session to keep alive" : "0 sessions" }));
          PG.setResult(verdict, broken ? "err" : "ok", broken || (legacy
            ? "Worked, because every request reached the replica holding the session" + (opt.replicas === 1 ? " (there's only one)." : " (sticky routing).")
            : "Done. Every request carried its own version and capabilities; the confirmation and the retry needed nothing from any replica's memory."));
          run.disabled = false;
          stage.badge("client", null);
        }
      });
    },
    quiz: [
      { q: "In the legacy run with 3 replicas and no sticky routing, why does it break?",
        opts: ["The token expired", "The session lives in one replica's memory and the next request reaches another", "Elicitation wasn't declared", "The tool name was wrong"],
        a: 1, why: "Legacy sessions pin a client to one replica. Even with sticky routing, a server-to-client request held open in memory is lost if that replica restarts. 2026-07-28 removes both." },
      { q: "In the 2026-07-28 run, what lets the re-issued rollback after a dropped stream be safe?",
        opts: ["Last-Event-ID", "An idempotency key in the arguments, so the server recognises the repeat", "The session id", "A longer timeout"],
        a: 1, why: "Re-issuing is a new request; idempotency makes the repeat harmless." },
      { q: "Which result in the run should be cacheScope private?",
        opts: ["server/discover", "tools/list, if it depends on who is calling", "tools/call", "notifications/progress"],
        a: 1, why: "A per-caller tool list must not be shared by a cache." },
    ],
  });

  PG.lesson({
    id: "exam",
    track: "mastery",
    title: "Final exam",
    short: "Exam",
    thesis: "Twenty questions across the whole course. Pass them all to complete the proving ground.",
    refs: "MCP specification 2026-07-28",
    brief: `
      <h2>Before you start</h2>
      <p>Every question has one best answer, and each explanation names the lesson to revisit. Take your time; you can retry as often as you like.</p>
      <div class="note"><span class="note-label">Tip</span>Most mistakes come from carrying a legacy-era habit into 2026-07-28: expecting a session, a handshake, a server-to-client request, or a resumable stream.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Quick reference", "Error codes · removed in 2026-07-28");
      const t = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { text: "Code" }), h("th", { text: "Name" }), h("th", { text: "When" }))),
        h("tbody", {}, SPEC.errors.concat(SPEC.errorsLegacy).map(function (e) { return h("tr", {}, h("td", { class: "mono", text: String(e.code) }), h("td", { text: e.name }), h("td", { text: e.when })); })));
      a.body.append(h("div", { class: "table-wrap" }, t), h("p", { class: "small muted", text: SPEC.errorRanges }));
      const t2 = h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, h("th", { text: "Removed" }), h("th", { text: "Instead" }))),
        h("tbody", {}, SPEC.removed.map(function (r) { return h("tr", {}, h("td", { class: "mono", text: r.m }), h("td", { text: r.why })); })));
      a.body.append(h("div", { class: "table-wrap" }, t2));
    },
    quiz: [
      { q: "What replaced the initialize handshake?",
        opts: ["A login request", "protocolVersion and clientCapabilities in every request's _meta", "The Mcp-Session-Id header", "server/discover, which is now mandatory before any request"],
        a: 1, why: "Stateless requests (Stateless _meta). server/discover is mandatory for servers to implement, optional for clients to call." },
      { q: "A modern server gets protocolVersion 2027-01-01. What does it return?",
        opts: ["-32601", "-32022 with data.supported", "-32020", "It uses its newest version"],
        a: 1, why: "UnsupportedProtocolVersion (Discover & versions)." },
      { q: "The model sends scale_service with replicas: 500 (max 50). Best server response?",
        opts: ["-32602", "isError: true with a message stating the allowed range", "Clamp to 50 silently", "-32603"],
        a: 1, why: "Value errors are tool execution errors the model can fix (Tools)." },
      { q: "Annotations from a server you don't trust should be:",
        opts: ["Followed", "Treated as untrusted; ask the user", "Inverted", "Logged only"],
        a: 1, why: "Annotations & approval." },
      { q: "How does a stateless server keep a release plan between calls?",
        opts: ["Mcp-Session-Id", "A handle returned by one tool and passed to the next, stored in a shared store", "In requestState", "It can't"],
        a: 1, why: "Handles." },
      { q: "A resource URI doesn't exist. 2026-07-28 code?",
        opts: ["-32002", "-32602", "-32601", "404 with no body"],
        a: 1, why: "Resources." },
      { q: "Who controls prompts?",
        opts: ["The model", "The user", "The server", "The gateway"],
        a: 1, why: "Prompts." },
      { q: "An admin-only tool list is returned with cacheScope public. What can go wrong?",
        opts: ["Nothing", "A shared cache serves it to non-admins", "The list can't be paginated", "ttlMs is ignored"],
        a: 1, why: "Caching & pages." },
      { q: "nextCursor is absent. That means:",
        opts: ["Error", "End of the list", "Try again", "Page size is zero"],
        a: 1, why: "Caching & pages." },
      { q: "On the MRTR retry, which must change?",
        opts: ["The method", "The JSON-RPC id", "The requestState", "The tool name"],
        a: 1, why: "New id; requestState echoed unchanged (MRTR)." },
      { q: "A server wants the user's payment details. Which mechanism?",
        opts: ["Form elicitation", "URL elicitation", "Sampling", "A prompt"],
        a: 1, why: "Sensitive data must not use form mode (Elicitation)." },
      { q: "Which feature is deprecated in 2026-07-28?",
        opts: ["Tools", "Sampling", "Resources", "Progress"],
        a: 1, why: "Sampling, roots and logging are deprecated (Deprecated features)." },
      { q: "A notification POSTed over Streamable HTTP gets:",
        opts: ["200 {}", "202 Accepted, no body", "204", "An SSE stream"],
        a: 1, why: "Streamable HTTP." },
      { q: "Mcp-Param-Region: eu-west1 but arguments.region is us-east1. The server:",
        opts: ["Uses the body", "Uses the header", "Rejects with 400 / -32020", "Uses both"],
        a: 2, why: "HeaderMismatch (Streamable HTTP)." },
      { q: "A stdio server writes \"Starting…\" to stdout. Result?",
        opts: ["Fine", "The client sees a line that isn't JSON-RPC and fails to parse", "It goes to the log", "It's treated as a notification"],
        a: 1, why: "stdout is for MCP messages only (stdio)." },
      { q: "An SSE response stream breaks mid-call. The client:",
        opts: ["Resumes with Last-Event-ID", "Re-issues the request with a new id", "Waits for the subscription stream", "Calls tasks/result"],
        a: 1, why: "Progress & cancel." },
      { q: "The first message on a subscriptions/listen stream is:",
        opts: ["notifications/subscriptions/acknowledged", "A progress notification", "The result", "A ping"],
        a: 0, why: "Subscriptions." },
      { q: "The authorization server metadata lacks code_challenge_methods_supported. The client:",
        opts: ["Uses plain", "Refuses to proceed", "Skips PKCE", "Uses DCR"],
        a: 1, why: "OAuth flow." },
      { q: "An MCP server calls a third-party API with the token it received from the client. This is:",
        opts: ["Best practice", "Token passthrough, which is forbidden", "Step-up", "Fine if scopes match"],
        a: 1, why: "Scopes & passthrough." },
      { q: "A tool's description changed after you approved it. The host should:",
        opts: ["Use the new one", "Notice via a pinned hash and ask the user to review", "Delete the server", "Ignore listChanged"],
        a: 1, why: "Threats: rug pull." },
    ],
  });
})();
