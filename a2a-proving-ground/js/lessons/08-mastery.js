/* Track 8 — Mastery: the end-to-end proving ground, and the final exam. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  const FAULTS = [
    { v: "tamper", label: "Card tampered in transit", kind: "stop" },
    { v: "version", label: "Client sends A2A-Version 0.5", kind: "stop" },
    { v: "expired", label: "Cached token has expired", kind: "heal" },
    { v: "scope", label: "Token lacks deploy:prod", kind: "stop" },
    { v: "timeout", label: "Gateway idle timeout 15 s", kind: "heal" },
    { v: "notaskid", label: "Resume forgets the taskId", kind: "stop" },
    { v: "replica", label: "Resume hits a replica with no shared store", kind: "stop" },
    { v: "canceled", label: "Someone cancels the task before approval", kind: "stop" },
  ];

  PG.lesson({
    id: "playground",
    track: "mastery",
    title: "The proving ground",
    short: "Proving ground run",
    thesis: "One production deploy, end to end, every concept in order: discover, verify, pick a transport, authenticate, stream through a gateway, pause for a human, resume, deliver. Then break it on purpose.",
    refs: "Everything: §3 operations · §7 auth · §8 discovery · §9 JSON-RPC · §13 security",
    brief: `
      <h2>The scenario</h2>
      <p>Your client agent must deploy <code>checkout-api 2.14.0</code> to production through the release agent at <code>agents.example.com</code>, behind an A2A-aware gateway, with a human approval in the middle.</p>
      <h2>The steps</h2>
      <ol>
        <li>Fetch the Agent Card from the well-known URI.</li>
        <li>Verify its signature before trusting anything in it.</li>
        <li>Choose the first supported interface from <code>supportedInterfaces</code>.</li>
        <li>Read <code>securitySchemes</code>: OAuth2 client credentials.</li>
        <li>Get a scoped token from the authorization server.</li>
        <li><code>SendStreamingMessage</code> with <code>Authorization</code> and <code>A2A-Version: 1.0</code>; watch readiness and the scan stream in until the task pauses in <code>INPUT_REQUIRED</code>.</li>
        <li>A human approves.</li>
        <li>Resume on the <strong>same taskId</strong>; receive the rollout report as an artifact and <code>COMPLETED</code>.</li>
      </ol>
      <h2>Fault injection</h2>
      <p>Turn faults on to see how each concept fails in practice. Two of them a well-built client heals on its own: an expired token is refreshed and retried, and a stream cut by a proxy is re-attached with <code>SubscribeToTask</code>. The rest stop the run, with the fix explained.</p>`,
    lab: function (bench, api) {
      const lab = PG.lab(bench, "Deploy checkout-api 2.14.0 to production", "Lab · end-to-end run");
      const on = {};
      const stage = PG.stage(lab.body, {
        size: "tall",
        actors: [
          { id: "client", role: "client", label: "Your client agent", sub: "ops-concierge", x: 11, y: 48 },
          { id: "auth", role: "auth", label: "Auth server", sub: "auth.example.com", x: 42, y: 12 },
          { id: "gw", role: "proxy", label: "A2A gateway", sub: "agents.example.com", x: 52, y: 48 },
          { id: "agent", role: "server", label: "Release agent", sub: "replica A", x: 88, y: 48 },
          { id: "human", role: "user", label: "Approver", sub: "alice", x: 11, y: 88 },
        ],
        links: [["client", "auth"], ["client", "gw"], ["gw", "agent"], ["human", "client"]],
      });
      const STEP_NAMES = ["Discover the card", "Verify the signature", "Choose the interface", "Read auth requirements", "Get a token", "Stream the request", "Human approval", "Resume and complete"];
      const steps = h("ol", { class: "steps" });
      const stepEls = STEP_NAMES.map(function (n) { const li = h("li", {}, h("span", { text: n }), h("span", { class: "small muted" })); steps.appendChild(li); return li; });
      const faultBox = h("div", { class: "row" });
      FAULTS.forEach(function (f) {
        faultBox.appendChild(PG.switch("fault-" + f.v, f.label + (f.kind === "heal" ? " (self-heals)" : ""), false, function (v) { on[f.v] = v; }));
      });
      const verdict = h("div", { class: "result", text: "Choose any faults, then run." });
      const stateBox = h("div", { class: "row" }, h("span", { class: "small muted", text: "Task:" }), h("span", { class: "chip mono", text: "none yet" }));
      const run = h("button", { class: "btn primary", type: "button", text: "Run the deploy" });
      const wire = PG.wire(lab.body, { title: "Every exchange" });
      lab.body.insertBefore(h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "Faults" }), faultBox, h("div", { class: "row" }, run), stateBox), stage.el);
      lab.body.insertBefore(h("div", { class: "grid2" }, steps, verdict), wire.el);

      function mark(i, cls, note) {
        stepEls[i].className = cls;
        stepEls[i].lastChild.textContent = note || "";
      }
      function setState(id, st) {
        stateBox.innerHTML = "";
        stateBox.append(h("span", { class: "small muted", text: "Task:" }), h("span", { class: "chip mono", text: id }), PG.stateChip(st));
      }
      function stop(i, msg) {
        stage.hold("client", "gw", false); stage.hold("gw", "agent", false);
        mark(i, "fail", "stopped");
        verdict.className = "result err";
        verdict.innerHTML = msg;
      }

      run.addEventListener("click", async function () {
        run.disabled = true;
        wire.clear();
        stepEls.forEach(function (_, i) { mark(i, "", ""); });
        verdict.className = "result"; verdict.textContent = "Running…";
        stage.caption("");
        stage.link("client", "gw", ""); stage.link("gw", "agent", "");
        try { await play(); } finally { if (api.alive()) run.disabled = false; }
      });

      async function play() {
        const alive = api.alive;
        const card = PG.clone(PG.cards.release);
        card.signatures = [{ protected: PG.b64url(JSON.stringify({ alg: "ES256", typ: "JOSE", kid: "release-key-1", jku: "https://agents.example.com/.well-known/jwks.json" })), signature: PG.b64url(PG.hex(64)) }];
        const taskId = "task-" + PG.hex(3), ctx = "ctx-" + PG.hex(3);

        /* 1 discover */
        mark(0, "run");
        stage.caption("GET the card from the well-known URI.");
        wire.add({ actor: "client", label: "GET https://agents.example.com/.well-known/agent-card.json", http: { start: "GET /.well-known/agent-card.json HTTP/1.1", headers: { Host: "agents.example.com", Accept: "application/json" } } });
        if (!(await stage.send("client", "gw", "GET card"))) return;
        const served = PG.clone(card);
        if (on.tamper) served.supportedInterfaces[0].url = "https://agents-example.evil.test/a2a/release";
        wire.add({ kind: "in", actor: "server", label: "Agent Card · signed", status: "200", http: SPEC.res(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300", ETag: '"2.3.0"' }), body: served, hl: on.tamper ? ["supportedInterfaces"] : ["signatures"] });
        await stage.send("gw", "client", "card");
        if (!alive()) return;
        mark(0, "pass", "200");

        /* 2 verify */
        mark(1, "run");
        stage.caption("Strip signatures, canonicalize with JCS, verify with release-key-1.");
        await PG.sleep(700);
        if (!alive()) return;
        if (on.tamper) {
          wire.add({ kind: "note", actor: "client", label: "✗ Signature invalid: the canonical card differs from what release-key-1 signed", status: "reject", tone: "err" });
          return stop(1, "<b>Stopped at verification.</b> Someone rewrote <span class='mono'>supportedInterfaces[0].url</span> in transit. Because the client verified before trusting, it never sent a token to the attacker's host. Fix: nothing to fix on the client; this is the check doing its job.");
        }
        wire.add({ kind: "note", actor: "client", label: "✓ Signature valid (ES256, kid release-key-1)", status: "valid" });
        mark(1, "pass", "ES256 ✓");

        /* 3 interface */
        mark(2, "run");
        const iface = card.supportedInterfaces[0];
        wire.add({ kind: "note", actor: "client", label: "Client supports JSONRPC + HTTP+JSON → first match in card order: " + iface.protocolBinding + " at " + iface.url });
        await PG.sleep(350);
        mark(2, "pass", iface.protocolBinding);

        /* 4 auth requirements */
        mark(3, "run");
        wire.add({ kind: "note", actor: "client", label: "securitySchemes.platformOAuth: OAuth2 clientCredentials at auth.example.com; card requires deploy:read, deployment_execution requires deploy:write" });
        await PG.sleep(350);
        mark(3, "pass", "OAuth2 CC");

        /* 5 token */
        mark(4, "run");
        const scopes = on.scope ? "deploy:read deploy:write" : "deploy:read deploy:write deploy:prod";
        let tokenExpired = !!on.expired;
        if (!tokenExpired) {
          stage.caption("Client credentials grant for a scoped, short-lived token.");
          wire.add({ actor: "client", label: "POST /oauth2/token · client_credentials · scope=" + scopes, http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "auth.example.com", "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic <base64(client_id:client_secret)>" } }, body: "grant_type=client_credentials&scope=" + encodeURIComponent(scopes) });
          if (!(await stage.send("client", "auth", "POST /token"))) return;
          wire.add({ kind: "in", actor: "auth", label: "access_token · expires_in 300", status: "200", http: SPEC.res(200), body: { access_token: "eyJhbGciOiJSUzI1NiJ9.…", token_type: "Bearer", expires_in: 300, scope: scopes } });
          await stage.send("auth", "client", "token");
          mark(4, "pass", "scopes: " + scopes.split(" ").length);
        } else {
          wire.add({ kind: "note", actor: "client", label: "Using a cached token (it expired 2 minutes ago)" });
          mark(4, "pass", "cached");
        }
        if (!alive()) return;

        /* 6 stream */
        mark(5, "run");
        const version = on.version ? "0.5" : "1.0";
        const hdrs = { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.…", "A2A-Version": version, Accept: "text/event-stream" };
        const req = SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", ["Deploy checkout-api 2.14.0 to production"]) });
        stage.caption("SendStreamingMessage through the gateway.");
        wire.add({ actor: "client", label: "SendStreamingMessage · A2A-Version " + version, http: SPEC.post("/a2a/release", hdrs), body: req });
        if (!(await stage.send("client", "gw", "SendStreamingMessage"))) return;
        if (tokenExpired) {
          wire.add({ kind: "in", actor: "proxy", label: "Gateway: token expired", status: "401", http: SPEC.res(401, { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token expired"' }) });
          await stage.send("gw", "client", "401", { tone: "err" });
          stage.caption("Self-heal: refresh the token with client credentials and retry once.");
          wire.add({ actor: "client", label: "POST /oauth2/token · refresh via client_credentials", http: { start: "POST /oauth2/token HTTP/1.1", headers: { Host: "auth.example.com" } }, body: "grant_type=client_credentials&scope=" + encodeURIComponent(scopes) });
          if (!(await stage.send("client", "auth", "refresh"))) return;
          await stage.send("auth", "client", "new token");
          tokenExpired = false;
          mark(4, "pass", "refreshed after 401");
          wire.add({ actor: "client", label: "SendStreamingMessage · retry with fresh token", http: SPEC.post("/a2a/release", hdrs), body: req });
          if (!(await stage.send("client", "gw", "retry"))) return;
        }
        if (on.version) {
          wire.add({ kind: "in", actor: "server", label: "VersionNotSupportedError: agent serves 0.3 and 1.0", status: "-32009", http: SPEC.res(200), body: SPEC.rpcErr("VersionNotSupportedError", 1, "VERSION_NOT_SUPPORTED"), open: true });
          await stage.send("gw", "client", "-32009", { tone: "err" });
          return stop(5, "<b>Stopped: version mismatch.</b> The client asked for A2A 0.5, which this interface doesn't serve. Fix: send the version from the chosen <span class='mono'>supportedInterfaces</span> entry (1.0), and don't silently fall back.");
        }
        if (!(await stage.send("gw", "agent", "SendStreamingMessage"))) return;
        stage.hold("client", "gw", true, "server"); stage.hold("gw", "agent", true, "server");
        const ev = function (label, sse) { wire.add({ kind: "evt", actor: "server", label: label, sse: sse }); };
        ev("task · SUBMITTED", [{ task: SPEC.task(taskId, ctx, "SUBMITTED") }]);
        setState(taskId, "SUBMITTED");
        await stage.send("agent", "client", "task", { dur: 600 });
        ev("statusUpdate · WORKING · readiness ready, risk high", [SPEC.statusUpdate(taskId, ctx, "WORKING", "Readiness: ready (tier-1, risk high)")]);
        setState(taskId, "WORKING");
        await stage.send("agent", "client", "WORKING", { dur: 600 });
        ev("statusUpdate · WORKING · compliance scan running", [SPEC.statusUpdate(taskId, ctx, "WORKING", "Compliance scan running (SOC2, PCI)…")]);
        if (!alive()) return;
        if (on.timeout) {
          await PG.sleep(600);
          wire.add({ kind: "note", actor: "proxy", label: "Gateway closed the stream after 15 s of silence during the scan", status: "cut", tone: "err" });
          stage.link("client", "gw", "cut");
          stage.caption("Self-heal: the task is still running, so re-attach with SubscribeToTask.");
          await PG.sleep(500);
          wire.add({ actor: "client", label: "SubscribeToTask · " + taskId, http: SPEC.post("/a2a/release", hdrs), body: SPEC.rpc("SubscribeToTask", { id: taskId }), hl: ["id"] });
          stage.link("client", "gw", "");
          if (!(await stage.send("client", "gw", "SubscribeToTask"))) return;
          await stage.send("gw", "agent", "SubscribeToTask");
          stage.hold("client", "gw", true, "server");
          ev("task snapshot · WORKING (re-attached)", [{ task: SPEC.task(taskId, ctx, "WORKING") }]);
          await stage.send("agent", "client", "snapshot", { dur: 600 });
        }
        if (!alive()) return;
        ev("statusUpdate · INPUT_REQUIRED · approval needed (CHG-2041)", [SPEC.statusUpdate(taskId, ctx, "INPUT_REQUIRED", "Production deploy needs human approval. Ticket CHG-2041. Approve?")]);
        setState(taskId, "INPUT_REQUIRED");
        await stage.send("agent", "client", "INPUT_REQUIRED", { tone: "server" });
        stage.hold("client", "gw", false); stage.hold("gw", "agent", false);
        mark(5, "pass", on.timeout ? "re-attached once" : "paused for input");
        if (!alive()) return;

        /* 7 approval */
        mark(6, "run");
        stage.caption("The client surfaces the approval to a human.");
        if (!(await stage.send("client", "human", "approve CHG-2041?"))) return;
        await stage.send("human", "client", "approved");
        mark(6, "pass", "alice approved");
        if (on.canceled) {
          wire.add({ kind: "note", actor: "user", label: "Meanwhile another operator called CancelTask on " + taskId });
          setState(taskId, "CANCELED");
        }

        /* 8 resume */
        mark(7, "run");
        const resumeMsg = SPEC.msg("user", [{ data: { approved: true, ticket: "CHG-2041", decidedBy: "alice" }, mediaType: "application/json" }], on.notaskid ? {} : { taskId: taskId, contextId: ctx });
        wire.add({ actor: "client", label: "SendStreamingMessage · resume" + (on.notaskid ? " (no taskId!)" : " · taskId " + taskId), http: SPEC.post("/a2a/release", hdrs), body: SPEC.rpc("SendStreamingMessage", { message: resumeMsg }), hl: ["taskId"] });
        if (!(await stage.send("client", "gw", "resume"))) return;
        if (on.replica) {
          stage.set("agent", { label: "Release agent" });
          stage.actors.agent.node.querySelector(".a-sub").textContent = "replica B";
        }
        if (!(await stage.send("gw", "agent", "resume"))) return;
        stage.hold("client", "gw", true, "server"); stage.hold("gw", "agent", true, "server");
        if (on.notaskid) {
          const other = "task-" + PG.hex(3);
          ev("task · SUBMITTED (a brand-new task " + other + ")", [{ task: SPEC.task(other, ctx, "SUBMITTED") }]);
          await stage.send("agent", "client", "new task", { tone: "err" });
          return stop(7, "<b>Stopped: the approval went nowhere.</b> Without <span class='mono'>taskId</span> the agent treated the approval as a new request and created task " + other + ". The original task is still waiting in INPUT_REQUIRED. Fix: always resume on the paused task's id.");
        }
        if (on.replica) {
          wire.add({ kind: "in", actor: "server", label: "Replica B: TaskNotFoundError", status: "-32001", http: SPEC.res(200), body: SPEC.rpcErr("TaskNotFoundError"), open: true });
          await stage.send("agent", "client", "-32001", { tone: "err" });
          return stop(7, "<b>Stopped: task lost between replicas.</b> The task lives in replica A's memory and the resume landed on B. Fix: a shared task store, or an A2A-aware gateway routing on taskId.");
        }
        if (on.canceled) {
          wire.add({ kind: "in", actor: "server", label: "UnsupportedOperationError: task is CANCELED", status: "-32004", http: SPEC.res(200), body: SPEC.rpcErr("UnsupportedOperationError", 1, "TASK_IN_TERMINAL_STATE"), open: true });
          await stage.send("agent", "client", "-32004", { tone: "err" });
          return stop(7, "<b>Stopped: the task was already terminal.</b> Terminal tasks are immutable, so the approval can't revive it. Fix: start a new task in the same context with <span class='mono'>referenceTaskIds</span>, and make cancellation visible to approvers.");
        }
        if (on.scope) {
          ev("statusUpdate · REJECTED · token lacks deploy:prod", [{ statusUpdate: { taskId: taskId, contextId: ctx, status: { state: "TASK_STATE_REJECTED", message: SPEC.msg("agent", ["Deployment to production requires scope deploy:prod."]) } } }]);
          setState(taskId, "REJECTED");
          await stage.send("agent", "client", "REJECTED", { tone: "err" });
          return stop(7, "<b>Stopped: authorized for the call, not for the action.</b> The token was valid, so the request got through, but the production rollout needs <span class='mono'>deploy:prod</span>. Fix: request the scope the skill declares in its securityRequirements.");
        }
        ev("statusUpdate · WORKING · canary 10% → 50% → 100%", [SPEC.statusUpdate(taskId, ctx, "WORKING", "Canary 10% → 50% → 100%")]);
        setState(taskId, "WORKING");
        await stage.send("agent", "client", "WORKING", { dur: 600 });
        ev("artifactUpdate · rollout-report.json (lastChunk)", [{ artifactUpdate: { taskId: taskId, contextId: ctx, artifact: { artifactId: "art-" + PG.hex(2), name: "rollout-report.json", parts: [{ data: { service: "checkout-api", version: "2.14.0", environment: "production", errorRate: 0.0002, ticket: "CHG-2041" }, mediaType: "application/json" }] }, lastChunk: true } }]);
        await stage.send("agent", "client", "artifact", { dur: 600 });
        ev("statusUpdate · COMPLETED (stream closes)", [SPEC.statusUpdate(taskId, ctx, "COMPLETED")]);
        setState(taskId, "COMPLETED");
        await stage.send("agent", "client", "COMPLETED");
        stage.hold("client", "gw", false); stage.hold("gw", "agent", false);
        if (!alive()) return;
        mark(7, "pass", "COMPLETED");
        stage.caption("Deployed. Every step followed the spec.");
        const healed = [on.expired && "refreshed an expired token", on.timeout && "re-attached a cut stream"].filter(Boolean);
        verdict.className = "result ok";
        verdict.innerHTML = "<b>Deployed.</b> Card verified, interface chosen, token scoped, stream consumed, human approved, task resumed on its id, artifact delivered." + (healed.length ? " The client also " + healed.join(" and ") + " without giving up." : "");
      }
    },
    quiz: [
      { q: "Why verify the card's signature before requesting a token?",
        opts: ["Tokens are cheaper after verification", "So you never send credentials to an endpoint an attacker substituted", "The spec requires tokens to be signed", "It speeds up discovery"],
        a: 1, why: "A tampered card could point at an attacker's host. Verifying first means your token only goes where the real provider said." },
      { q: "The stream is cut by a proxy while the task is WORKING. The right client move?",
        opts: ["Resend the original message", "SubscribeToTask with the task id", "CancelTask and start over", "Wait for a push notification you never registered"],
        a: 1, why: "SubscribeToTask re-attaches to the running task. Resending would start a duplicate deployment." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Final exam
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "exam",
    track: "mastery",
    title: "Final checkpoint",
    short: "Final checkpoint",
    thesis: "Nineteen questions across every track. Pass them all to complete the course. Each explanation links the idea back to the spec.",
    refs: "All lessons",
    brief: `
      <p>Take it cold. If you miss one, read the explanation, revisit the lesson, and come back.</p>
      <div class="note"><span class="note-label">Your progress</span><div id="exam-progress"></div></div>
      <p class="small muted">Progress is stored only in this browser. <button class="btn small" type="button" id="reset-progress">Reset my progress</button></p>`,
    lab: function (bench) {
      const box = document.getElementById("exam-progress");
      function paint() {
        if (!box) return;
        box.innerHTML = "";
        const t = h("table", { class: "tbl" }, h("tbody", {}, PG.lessons.filter(function (l) { return l.id !== "exam"; }).map(function (l) {
          return h("tr", {}, h("td", {}, h("a", { href: "#" + l.id, text: l.short || l.title })),
            h("td", {}, h("span", { class: "chip " + (PG.progress.done[l.id] ? "ok" : PG.progress.seen[l.id] ? "info" : ""), text: PG.progress.done[l.id] ? "passed" : PG.progress.seen[l.id] ? "visited" : "not started" })));
        })));
        box.appendChild(h("div", { class: "table-wrap" }, t));
      }
      paint();
      const rb = document.getElementById("reset-progress");
      if (rb) rb.addEventListener("click", function () { PG.resetProgress(); paint(); PG.toast("Progress reset"); });
      const a = PG.lab(bench, "Protocol cheat sheet", "Reference");
      a.body.append(
        h("div", { class: "table-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Operation", "JSON-RPC", "HTTP+JSON"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", {}, SPEC.methods.map(function (m) { return h("tr", {}, h("td", { text: m.op }), h("td", { class: "mono", text: m.jsonrpc }), h("td", { class: "mono", text: m.rest })); })))),
        h("div", { class: "row" }, SPEC.states.map(function (s) { return PG.stateChip(s); })),
        h("div", { class: "table-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Error", "JSON-RPC", "HTTP"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", {}, SPEC.errors.map(function (e) { return h("tr", {}, h("td", { class: "mono", text: e.name }), h("td", { class: "mono", text: String(e.code) }), h("td", { class: "mono", text: e.http })); })))));
    },
    quiz: [
      { q: "Which field set is required in every 1.0 Agent Card?",
        opts: ["name, url, protocolVersion, skills", "name, description, supportedInterfaces, version, capabilities, defaultInputModes, defaultOutputModes, skills", "name, securitySchemes, skills", "name, provider, signatures"],
        a: 1, why: "Per a2a.proto AgentCard. url and protocolVersion moved into supportedInterfaces." },
      { q: "How does a client ask for a specific skill?",
        opts: ["params.skillId", "It can't; it describes the goal in a message and the agent chooses", "A2A-Skill header", "GetSkill RPC"],
        a: 1, why: "Skills are discovery metadata. Messages carry no skill field." },
      { q: "A client wants to avoid re-downloading an unchanged card. It sends…",
        opts: ["If-None-Match with the cached ETag", "A2A-Version: cached", "GetExtendedAgentCard", "A HEAD request to /message:send"],
        a: 0, why: "Standard HTTP revalidation; an unchanged card returns 304." },
      { q: "SendMessage with default configuration returns when…",
        opts: ["the task is created", "the task is terminal or interrupted", "the first artifact arrives", "after 60 s"],
        a: 1, why: "Blocking by default; returnImmediately: true changes that." },
      { q: "Which state asks the client for credentials mid-task?",
        opts: ["INPUT_REQUIRED", "AUTH_REQUIRED", "REJECTED", "SUBMITTED"],
        a: 1, why: "AUTH_REQUIRED is in-task authorization, with a status message explaining what's needed." },
      { q: "A valid token without the needed scope should get…",
        opts: ["401", "403", "404", "-32004"],
        a: 1, why: "Authenticated but not permitted: 403." },
      { q: "Bob's agent asks for Alice's task. A well-scoped server answers…",
        opts: ["403", "TaskNotFoundError", "the task", "UnsupportedOperationError"],
        a: 1, why: "Treat inaccessible as not found so ids can't be probed." },
      { q: "A request arrives with no A2A-Version header. The agent assumes…",
        opts: ["1.0", "0.3", "the newest version", "an error"],
        a: 1, why: "Empty means 0.3, for backward compatibility." },
      { q: "Which middlebox can rate-limit new tasks separately from cancellations on a JSON-RPC agent?",
        opts: ["An L4 mesh", "A plain HTTP proxy", "An A2A-aware gateway", "None of them"],
        a: 2, why: "Only a proxy that parses the JSON-RPC method knows which call is which." },
      { q: "An extension marked required: true wasn't activated. The agent returns…",
        opts: ["-32008 ExtensionSupportRequiredError", "-32004", "It ignores the extension", "401"],
        a: 0, why: "Required extensions must be activated via A2A-Extensions." },
      { q: "Where does the agent authenticate when POSTing to your push webhook?",
        opts: ["It doesn't", "Authorization header built from TaskPushNotificationConfig.authentication", "In the StreamResponse body", "With its Agent Card signature"],
        a: 1, why: "Agents MUST include the credentials you registered; you MUST validate them." },
      { q: "What does canonicalization (JCS) buy card signatures?",
        opts: ["Smaller cards", "Key order and whitespace don't change the signature; values do", "Encryption", "Faster verification"],
        a: 1, why: "Verifiers canonicalize before checking, so only real changes break the signature." },
      { q: "After a pod restart the task is found but the resume ends COMPLETED with “Function call not found”. What wasn't durable?",
        opts: ["The task store", "The agent framework's session holding the paused call", "The Agent Card", "The gateway"],
        a: 1, why: "Two stores back one paused task. Losing the session makes the resume complete with an error as its answer." },
      { q: "An orchestrator's task is canceled. Under plain A2A, the task it opened on another agent…",
        opts: ["is canceled too", "keeps running unless the orchestrator forwards CancelTask", "fails", "is deleted"],
        a: 1, why: "Each hop owns its own task; propagation is the orchestrator's job." },
      { q: "The concierge needs to call the specialist for Alice. Which token should it send?",
        opts: ["Alice's own token", "One from an RFC 8693 exchange: sub alice, aud deployment_agent, act ops_concierge", "Its own service token, no user", "None; mTLS is enough"],
        a: 1, why: "Audience-bound to the next hop, user preserved, actor recorded, scopes never widened." },
      { q: "Both agents export spans but you see two traces for one request. What's missing?",
        opts: ["A collector", "traceparent carried across the A2A hop (injected out, extracted in)", "Sampling", "gRPC"],
        a: 1, why: "Exporting is not propagating: the trace context must cross the hop." },
      { q: "A web page streams SendStreamingMessage. Which browser API reads it?",
        opts: ["EventSource", "fetch() with the response body read as a stream, plus an SSE parser", "WebSocket", "XMLHttpRequest sync mode"],
        a: 1, why: "EventSource is GET-only and can't set headers or send a JSON body." },
      { q: "A UI answers an ADK approval gate by sending the text “approved”. What happens?",
        opts: ["The gate resumes", "It is a new turn; the pending call stays unanswered", "A2A rejects it", "The task is canceled"],
        a: 1, why: "Resume with a function_response data part whose id matches the pending call, on the same task." },
      { q: "Where should a production web UI's agent tokens live?",
        opts: ["localStorage", "Server-side in a backend-for-frontend; the page holds an HttpOnly session cookie", "In the Agent Card", "In each message's metadata"],
        a: 1, why: "Nothing a script can read; the BFF also receives push webhooks the browser can't." },
    ],
  });
})();
