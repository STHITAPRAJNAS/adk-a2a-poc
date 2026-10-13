/* Track 1 — Foundations: who talks to whom, the three primitives, the
 * stateless request, and how client and server agree on a version. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  PG.track("foundations", "Foundations", "Hosts, clients and servers; tools, resources and prompts; why every request now stands alone; and how both sides agree on a version.");
  PG.track("server", "Server features", "What a server offers: tools with schemas and results, annotations and approvals, state through handles, resources, prompts, caching and pages.");
  PG.track("asking", "Asking the client", "When a server needs something mid-request: Multi Round-Trip Requests, elicitation forms and links, and the deprecated sampling, roots and logging.");
  PG.track("transports", "Transports & long work", "Streamable HTTP and its headers, stdio, progress and cancellation, and the subscription stream for change notifications.");
  PG.track("security", "Security", "OAuth for remote servers, scopes and step-up, why tokens never pass through, and the attacks that are specific to tool-using models.");
  PG.track("production", "MCP in production", "Where MCP stops and A2A starts, gateways and replicas, and testing a server against the spec.");
  PG.track("mastery", "Mastery", "One full run with every piece switched on, then the exam.");

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Host, client, server
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "actors",
    track: "foundations",
    title: "One host, many clients, one server each",
    short: "Host, client, server",
    thesis: "The host is the app you use. Inside it, one MCP client per server holds one connection. A server sees only what its own client sends it: never the conversation, never the other servers.",
    refs: "Spec 2026-07-28 · Architecture · Overview · Design principles",
    brief: `
      <h2>Three roles</h2>
      <ul>
        <li><strong>Host</strong>: the application the user sees (an IDE, a chat app, an agent runtime). It owns the model, the conversation, the user's consent, and decides what each server is allowed to see.</li>
        <li><strong>Client</strong>: a connector the host creates for <em>one</em> server. Host-to-client is in-process; client-to-server is MCP.</li>
        <li><strong>Server</strong>: a program that offers tools, resources and prompts. It can be a local process (stdio) or a remote service (Streamable HTTP).</li>
      </ul>
      <div class="note spec"><span class="note-label">Spec</span>Each client has a 1:1 relationship with one server. Servers should not be able to read the whole conversation or see into other servers. The host enforces those boundaries and the user's consent.</div>
      <h2>What crosses the wire</h2>
      <p>MCP messages are JSON-RPC 2.0: requests with an <code>id</code>, results or errors with the same <code>id</code>, and notifications with no <code>id</code>. Ids are strings or integers and <strong>must not be <code>null</code></strong>.</p>
      <p>The model never talks to a server. The host shows the model a list of tools; when the model asks for one, the host's client sends <code>tools/call</code> with just the arguments. That is all the server learns.</p>
      <div class="note"><span class="note-label">MCP and A2A</span>MCP connects an agent to its <em>tools and data</em>. A2A connects an agent to <em>another agent</em> that has its own goals and model. The ops concierge in this repo would use MCP to read a runbook and A2A to ask the release agent to do a release.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Follow one request through the host", "Lab · host · clients · servers");
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "user", role: "user", label: "You", sub: "operator", x: 12, y: 15 },
          { id: "host", role: "client", label: "Host app", sub: "ops-console + model", x: 30, y: 52, glyph: "H" },
          { id: "c1", role: "client", label: "Client ①", sub: "→ release-tools", x: 56, y: 25 },
          { id: "c2", role: "client", label: "Client ②", sub: "→ git-server", x: 56, y: 79 },
          { id: "s1", role: "server", label: "release-tools", sub: "MCP server", x: 87, y: 25 },
          { id: "s2", role: "server", label: "git-server", sub: "MCP server", x: 87, y: 79 },
        ],
        links: [["user", "host"], ["host", "c1"], ["host", "c2"], ["c1", "s1"], ["c2", "s2"]],
      });
      const seen = { s1: [], s2: [] };
      const views = h("div", { class: "grid2" });
      const v1 = h("div", { class: "stack" }), v2 = h("div", { class: "stack" });
      views.append(h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "What release-tools saw" }), v1),
        h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "What git-server saw" }), v2));
      function paintViews() {
        [[v1, seen.s1], [v2, seen.s2]].forEach(function (p) {
          p[0].innerHTML = "";
          if (!p[1].length) p[0].appendChild(h("div", { class: "result", text: "Nothing. It was never asked." }));
          p[1].forEach(function (m) { p[0].appendChild(PG.pre(m.params, ["arguments"])); });
        });
      }
      const wire = PG.wire(a.body, { title: "Wire (client ① ↔ release-tools)" });
      const run = h("button", { class: "btn primary", type: "button", text: "Ask: “is checkout-api healthy? roll it back if not”" });
      a.body.insertBefore(h("div", { class: "row" }, run), stage.el);
      a.body.appendChild(views);
      paintViews();
      run.addEventListener("click", async function () {
        run.disabled = true; wire.clear(); seen.s1 = []; seen.s2 = []; paintViews();
        stage.caption("<b>You ask the host.</b> The conversation, your name and the model all stay inside the host.");
        if (!(await stage.send("user", "host", "“roll back if unhealthy”"))) return;
        await PG.sleep(300);
        stage.caption("<b>The model picks a tool.</b> It saw a list of tools from both servers; it wants <code>get_service_status</code>.");
        stage.badge("host", "model: call get_service_status");
        await PG.sleep(900);
        if (!api.alive()) return;
        const req1 = SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "checkout-api" } }, 1);
        seen.s1.push(req1);
        if (!(await stage.send("host", "c1", "tools/call"))) return;
        wire.add({ actor: "client", label: "tools/call · get_service_status", http: SPEC.post("tools/call", "get_service_status"), body: req1, hl: ["arguments"],
          note: "Only the tool name and its arguments. No chat history, no user prompt, nothing from git-server." });
        if (!(await stage.send("c1", "s1", "tools/call"))) return;
        const status = { service: "checkout-api", version: "2.14.0", replicas: 6, errorRate: 0.047 };
        if (!(await stage.send("s1", "c1", "result"))) return;
        wire.add({ kind: "in", actor: "server", label: "result · error rate 4.7%", status: "200", http: SPEC.res(200),
          body: SPEC.ok(1, { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status, isError: false }) });
        await stage.send("c1", "host", "result");
        stage.badge("host", "model: 4.7% > 2% → roll back");
        stage.caption("<b>The host asks you first.</b> Rolling back is destructive, so the host shows you the call and its arguments before sending it.");
        await PG.sleep(700);
        if (!(await stage.send("host", "user", "approve rollback?"))) return;
        await PG.sleep(400);
        if (!(await stage.send("user", "host", "approve"))) return;
        const req2 = SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" } }, 2);
        seen.s1.push(req2);
        await stage.send("host", "c1", "tools/call");
        wire.add({ actor: "client", label: "tools/call · rollback_release", http: SPEC.post("tools/call", "rollback_release"), body: req2, hl: ["arguments"] });
        if (!(await stage.send("c1", "s1", "tools/call"))) return;
        await stage.send("s1", "c1", "result");
        wire.add({ kind: "in", actor: "server", label: "result · rolled back to 2.13.2", status: "200", http: SPEC.res(200),
          body: SPEC.ok(2, { content: [{ type: "text", text: "checkout-api rolled back to 2.13.2" }], isError: false }) });
        await stage.send("c1", "host", "result");
        stage.badge("host", null);
        stage.caption("<b>Done.</b> release-tools saw two calls with arguments. git-server saw nothing at all: compare the two panels below.");
        paintViews();
        run.disabled = false;
      });

      const b = PG.lab(bench, "Which side owns it?", "Lab · host or server");
      PG.sorter(b.body, [
        { t: "The conversation history", a: "Host", why: "The host keeps it. A server gets only the arguments of calls made to it." },
        { t: "Asking the user before a destructive tool runs", a: "Host", why: "Consent is the host's job. Servers can't see the user." },
        { t: "Checking the caller may roll back checkout-api", a: "Server", why: "The server enforces its own access control on every call." },
        { t: "Choosing which tool to call next", a: "Host", why: "The model inside the host decides; the server only executes." },
        { t: "Validating that <code>replicas</code> is between 0 and 50", a: "Server", why: "Servers must validate inputs; never trust that the model or client did." },
        { t: "Deciding whether git-server may see release-tools' result", a: "Host", why: "Servers are isolated from each other; only the host could pass data across, and it should do so deliberately." },
      ], ["Host", "Server"]);
    },
    quiz: [
      { q: "How many servers does one MCP client talk to?",
        opts: ["Exactly one", "As many as the host configures", "One per tool", "Any server in the registry"],
        a: 0, why: "Each client holds a 1:1 connection to one server. A host with five servers runs five clients." },
      { q: "What does a server learn when the model calls one of its tools?",
        opts: ["The full conversation so far", "The tool name and the arguments the client sends", "The other servers' tool lists", "The user's identity, always"],
        a: 1, why: "Only what the client puts in the request. Identity reaches the server only through authorization (a token), not by default." },
      { q: "Which JSON-RPC id is invalid in MCP?",
        opts: ["<code>1</code>", "<code>\"call-7\"</code>", "<code>null</code>", "<code>0</code>"],
        a: 2, why: "MCP requires a string or integer id and forbids null." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Tools, resources, prompts
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "primitives",
    track: "foundations",
    title: "Tools, resources, prompts: who presses the button",
    short: "Three primitives",
    thesis: "The three things a server offers differ mainly in who decides to use them. Tools are chosen by the model, resources by the application, prompts by the user.",
    refs: "Spec 2026-07-28 · Server features overview · Tools · Resources · Prompts",
    brief: `
      <h2>Control decides the primitive</h2>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Primitive</th><th>Controlled by</th><th>Typical UI</th><th>Methods</th></tr></thead>
        <tbody>
          <tr><td>Tools</td><td>Model</td><td>The model calls it, the host may ask you first</td><td><code>tools/list</code>, <code>tools/call</code></td></tr>
          <tr><td>Resources</td><td>Application</td><td>A file picker, "attach", automatic context</td><td><code>resources/list</code>, <code>resources/read</code>, <code>resources/templates/list</code></td></tr>
          <tr><td>Prompts</td><td>User</td><td>Slash commands, menu items</td><td><code>prompts/list</code>, <code>prompts/get</code></td></tr>
        </tbody></table></div>
      <p>A <strong>tool</strong> does something or computes something: check readiness, scale a service, roll back. A <strong>resource</strong> is data with a URI that the application can read and put in front of the model: a runbook, a changelog, a day of logs. A <strong>prompt</strong> is a ready-made message template a person picks on purpose: "summarise this incident".</p>
      <div class="note"><span class="note-label">Rule of thumb</span>If the model should be able to do it on its own initiative, it's a tool. If the app should be able to show or attach it, it's a resource. If a person should choose it from a menu, it's a prompt.</div>
      <p>A server declares which of these it offers as <strong>capabilities</strong> (<code>tools</code>, <code>resources</code>, <code>prompts</code>, plus <code>completions</code> and <code>extensions</code>), returned by <code>server/discover</code>.</p>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Three buttons, three initiators", "Lab · who starts the request");
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "You", sub: "prompt", x: 14, y: 17 },
          { id: "model", role: "registry", label: "Model", sub: "tool", x: 14, y: 50, glyph: "M" },
          { id: "app", role: "client", label: "Host app", sub: "resource", x: 14, y: 83, glyph: "H" },
          { id: "client", role: "client", label: "MCP client", sub: "", x: 52, y: 50 },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 86, y: 50 },
        ],
        links: [["user", "client"], ["app", "client"], ["model", "client"], ["client", "server"]],
      });
      const wire = PG.wire(a.body);
      const cases = {
        prompt: { from: "user", label: "/incident_summary", method: "prompts/get", name: "incident_summary",
          params: { name: "incident_summary", arguments: { service: "checkout-api", hours: "6" } },
          result: { description: "Incident summary for checkout-api", messages: [{ role: "user", content: { type: "text", text: "Summarise the incident on checkout-api over the last 6 hours. Use the attached logs." } }] },
          cap: "You chose a slash command. The prompt came back as messages the host puts into the conversation." },
        resource: { from: "app", label: "attach runbook", method: "resources/read", name: "runbook://checkout-api/rollback",
          params: { uri: "runbook://checkout-api/rollback" },
          result: { contents: [{ uri: "runbook://checkout-api/rollback", mimeType: "text/markdown", text: "# Rolling back checkout-api\n1. Check readiness of the target version…" }], ttlMs: 60000, cacheScope: "private" },
          cap: "The app attached the runbook as context. Nobody asked the model; the application decided." },
        tool: { from: "model", label: "tools/call", method: "tools/call", name: "check_release_readiness",
          params: { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } },
          result: { content: [{ type: "text", text: "{\"ready\":true,\"checks\":[\"ci\",\"changelog\"],\"blockers\":[]}" }], structuredContent: { ready: true, checks: ["ci", "changelog"], blockers: [] }, isError: false },
          cap: "The model decided to call a tool, on its own initiative, because it was the next step of its plan." },
      };
      let n = 0;
      async function go(k) {
        const c = cases[k];
        n++;
        stage.caption(c.cap);
        if (!(await stage.send(c.from, "client", c.label))) return;
        const req = SPEC.rpc(c.method, c.params, n);
        wire.add({ actor: k === "tool" ? "registry" : k === "resource" ? "client" : "user", label: c.method + " · " + c.name, http: SPEC.post(c.method, c.name), body: req });
        if (!(await stage.send("client", "server", c.method))) return;
        await stage.send("server", "client", "result");
        wire.add({ kind: "in", actor: "server", label: "result", status: "200", http: SPEC.res(200), body: SPEC.ok(n, c.result) });
        await stage.send("client", c.from, "result");
      }
      a.body.insertBefore(h("div", { class: "row" },
        h("button", { class: "btn", type: "button", text: "You: /incident_summary", onclick: function () { go("prompt"); } }),
        h("button", { class: "btn", type: "button", text: "App: attach the runbook", onclick: function () { go("resource"); } }),
        h("button", { class: "btn", type: "button", text: "Model: check readiness", onclick: function () { go("tool"); } })), stage.el);

      const b = PG.lab(bench, "Tool, resource or prompt?", "Lab · design choices");
      PG.sorter(b.body, [
        { t: "Roll a service back to an earlier version", a: "Tool", why: "It acts on the world and the model should be able to propose it." },
        { t: "Yesterday's error log for billing-worker", a: "Resource", why: "Data with an address (<code>logs://billing-worker/2026-10-12</code>) that the app can read and attach." },
        { t: "“Draft release notes for this version”, chosen from a menu", a: "Prompt", why: "A template a person picks deliberately. It returns messages, not an action." },
        { t: "Look up the current replica count", a: "Tool", why: "A computation the model triggers mid-plan. It could also be a resource, but the model needs to request it with arguments when it wants." },
        { t: "The service's CHANGELOG.md", a: "Resource", why: "A document with a URI. The app can show it, attach it, or subscribe to changes." },
        { t: "A “/postmortem” command that pre-fills a structured template", a: "Prompt", why: "User-controlled, parameterised, produces messages for the conversation." },
      ], ["Tool", "Resource", "Prompt"]);
    },
    quiz: [
      { q: "Who decides to use a prompt?",
        opts: ["The model", "The user", "The server", "The application, automatically"],
        a: 1, why: "Prompts are user-controlled: slash commands and menu items." },
      { q: "A server wants the app to be able to show a runbook next to the chat. Which primitive?",
        opts: ["Tool", "Resource", "Prompt", "Notification"],
        a: 1, why: "Resources are application-driven data with URIs." },
      { q: "Where does a client learn which primitives a server offers?",
        opts: ["From <code>capabilities</code> in the <code>server/discover</code> result", "From the server's README", "By calling every list method and checking for errors", "From the Mcp-Session-Id header"],
        a: 0, why: "server/discover returns capabilities (tools, resources, prompts, completions, extensions). Calling list methods also works, but discovery gets it in one call." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Stateless requests and _meta
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "stateless",
    track: "foundations",
    title: "Every request stands alone",
    short: "Stateless _meta",
    thesis: "Since 2026-07-28 there is no handshake and no session. Every request carries its own protocol version and client capabilities in _meta, so any copy of a server can answer any request.",
    refs: "Spec 2026-07-28 · Base protocol §_meta · Versioning · Changelog items 1, 2",
    brief: `
      <h2>What every request carries</h2>
      <p>In <code>params._meta</code>:</p>
      <ul>
        <li><code>io.modelcontextprotocol/protocolVersion</code>: <strong>required</strong>, e.g. <code>"2026-07-28"</code>.</li>
        <li><code>io.modelcontextprotocol/clientCapabilities</code>: <strong>required</strong>, may be <code>{}</code>. What this client can do if the server asks (e.g. <code>elicitation</code>).</li>
        <li><code>io.modelcontextprotocol/clientInfo</code>: should be sent; name and version, for logs and display.</li>
        <li>Optional: <code>io.modelcontextprotocol/logLevel</code>, a <code>progressToken</code>, and trace context (<code>traceparent</code>, <code>tracestate</code>, <code>baggage</code>).</li>
      </ul>
      <p>A request missing a required field is rejected with <code>-32602</code> (Invalid params; HTTP 400). Servers should put <code>io.modelcontextprotocol/serverInfo</code> in every result's <code>_meta</code>.</p>
      <h2>What was removed</h2>
      <p>Before 2026-07-28 ("legacy era"), a connection started with <code>initialize</code> and <code>notifications/initialized</code>; over HTTP the server handed out an <code>Mcp-Session-Id</code> and kept state under it. That meant a load balancer had to send every request of a session to the same copy, and a restart lost the session.</p>
      <div class="note spec"><span class="note-label">Spec</span>Capabilities are now declared per request. A server must not send an input request (e.g. elicitation) that this request's capabilities don't declare. If it needs one that's missing, it answers <code>-32021</code> MissingRequiredClientCapability with <code>data.requiredCapabilities</code>.</div>
      <div class="note"><span class="note-label">Keys</span>Keys in <code>_meta</code> whose prefix has <code>modelcontextprotocol</code> or <code>mcp</code> as its second label (like <code>io.modelcontextprotocol/…</code>) are reserved for the spec. Use your own reverse-DNS prefix for custom data.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Build the _meta, send a request", "Lab · required fields");
      const on = { version: true, caps: true, client: true, log: false };
      const sw = [
        PG.switch("m-ver", "protocolVersion", true, function (v) { on.version = v; paint(); }),
        PG.switch("m-caps", "clientCapabilities", true, function (v) { on.caps = v; paint(); }),
        PG.switch("m-cli", "clientInfo", true, function (v) { on.client = v; paint(); }),
        PG.switch("m-log", "logLevel: info", false, function (v) { on.log = v; paint(); }),
      ];
      const preview = h("pre", { class: "code" });
      const out = h("div", { class: "result", text: "Toggle fields, then send tools/list." });
      const wire = PG.wire(a.body, { title: "Wire" });
      function req() {
        const omit = [];
        if (!on.version) omit.push("version");
        if (!on.caps) omit.push("caps");
        if (!on.client) omit.push("client");
        return SPEC.rpc("tools/list", {}, 1, { omit: omit, log: on.log ? "info" : null });
      }
      function paint() { preview.innerHTML = PG.jsonHTML(req(), ["_meta"]); }
      const send = h("button", { class: "btn primary", type: "button", text: "Send tools/list" });
      send.addEventListener("click", function () {
        const r = req();
        wire.add({ actor: "client", label: "tools/list", http: SPEC.post("tools/list"), body: r });
        const missing = [];
        if (!on.version) missing.push(SPEC.K.version);
        if (!on.caps) missing.push(SPEC.K.caps);
        if (missing.length) {
          wire.add({ kind: "in", actor: "server", label: "-32602 missing " + missing.map(function (m) { return m.split("/")[1]; }).join(", "), status: "400", http: SPEC.res(400),
            body: SPEC.err(1, -32602, "Invalid params: missing required _meta field", { missing: missing }), open: true });
          PG.setResult(out, "err", "Rejected. <code>" + missing.join("</code> and <code>") + "</code> " + (missing.length > 1 ? "are" : "is") + " required on <em>every</em> request. There is no handshake to remember it from.");
          return;
        }
        wire.add({ kind: "in", actor: "server", label: "result · 4 tools", status: "200", http: SPEC.res(200),
          body: SPEC.ok(1, { tools: SPEC.tools.map(function (t) { return { name: t.name, title: t.title }; }), ttlMs: 300000, cacheScope: "public" }), hl: ["_meta"] });
        PG.setResult(out, on.client ? "ok" : "warn", on.client
          ? "Accepted. Note <code>serverInfo</code> in the result's <code>_meta</code>: the server identifies itself on every answer, too."
          : "Accepted, because clientInfo is a SHOULD, not a MUST. But the server's logs now can't say which client called; send it.");
      });
      a.body.insertBefore(h("div", { class: "stack" }, h("div", { class: "row" }, sw), preview, h("div", { class: "row" }, send), out), wire.el);
      paint();

      const b = PG.lab(bench, "Three copies behind a load balancer", "Lab · legacy sessions vs stateless");
      let era = "legacy", sticky = false, dead = false, session = null, rr = 0;
      const stage = PG.stage(b.body, {
        actors: [
          { id: "client", role: "client", label: "MCP client", sub: "ops-console", x: 12, y: 50 },
          { id: "lb", role: "proxy", label: "Load balancer", sub: "round robin", x: 40, y: 50 },
          { id: "r1", role: "server", label: "replica 1", sub: "", x: 82, y: 14 },
          { id: "r2", role: "server", label: "replica 2", sub: "", x: 82, y: 50 },
          { id: "r3", role: "server", label: "replica 3", sub: "", x: 82, y: 86 },
        ],
        links: [["client", "lb"], ["lb", "r1"], ["lb", "r2"], ["lb", "r3"]],
      });
      const bw = PG.wire(b.body, { title: "Wire" });
      const verdict = h("div", { class: "result", text: "Pick an era, then send a few requests." });
      let id = 0;
      function pick() {
        const alive = ["r1", "r2", "r3"].filter(function (r) { return !(dead && r === "r1"); });
        if (era === "legacy" && sticky && session && alive.indexOf(session.on) >= 0) return session.on;
        const r = alive[rr % alive.length];
        rr++;
        return r;
      }
      async function request(method) {
        id++;
        const to = pick();
        const legacy = era === "legacy";
        const http = SPEC.post(method === "initialize" ? null : method, null, legacy && session && method !== "initialize" ? { "Mcp-Session-Id": session.id } : null, { legacy: legacy });
        const body = legacy ? SPEC.rpc(method, method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: SPEC.clientInfo } : {}, id, { noMeta: true }) : SPEC.rpc(method, {}, id);
        if (!(await stage.send("client", "lb", method))) return;
        bw.add({ actor: "client", label: method + " → " + to.replace("r", "replica "), http: http, body: body, hl: ["_meta", "protocolVersion"] });
        if (!(await stage.send("lb", to, method))) return;
        if (legacy && method === "initialize") {
          session = { id: "sess-" + PG.hex(4), on: to };
          stage.badge(to, "session " + session.id.slice(5));
          await stage.send(to, "lb", "200 + session id");
          await stage.send("lb", "client", "Mcp-Session-Id");
          bw.add({ kind: "in", actor: "server", label: "initialize result · Mcp-Session-Id: " + session.id, status: "200", http: SPEC.res(200, "json", { "Mcp-Session-Id": session.id }),
            body: SPEC.ok(id, { protocolVersion: "2025-11-25", capabilities: SPEC.serverCaps, serverInfo: SPEC.serverInfo }, { legacy: true }) });
          PG.setResult(verdict, "info", "Session <code>" + session.id + "</code> lives in the memory of <b>" + to.replace("r", "replica ") + "</b> only.");
          return;
        }
        if (legacy && (!session || session.on !== to)) {
          await stage.send(to, "lb", "404", { tone: "err" });
          await stage.send("lb", "client", "404", { tone: "err" });
          bw.add({ kind: "in", actor: "server", label: session ? "404 · session " + session.id + " unknown here" : "400 · no session: initialize first", status: session ? "404" : "400",
            http: SPEC.res(session ? 404 : 400), body: SPEC.err(id, -32600, session ? "Session not found" : "Bad Request: server not initialized") });
          PG.setResult(verdict, "err", session
            ? "This request landed on <b>" + to.replace("r", "replica ") + "</b>, which has never heard of the session. " + (dead ? "Its owner is gone, so the session is gone: the client must start over." : "Legacy HTTP needed sticky routing, keyed on Mcp-Session-Id.")
            : "In the legacy era nothing works before <code>initialize</code>.");
          return;
        }
        await stage.send(to, "lb", "200");
        await stage.send("lb", "client", "200");
        bw.add({ kind: "in", actor: "server", label: "result from " + to.replace("r", "replica "), status: "200", http: SPEC.res(200),
          body: SPEC.ok(id, { tools: SPEC.tools.map(function (t) { return { name: t.name }; }), ttlMs: 300000, cacheScope: "public" }, { legacy: legacy }) });
        PG.setResult(verdict, "ok", legacy ? "Worked, because the request reached the replica holding the session." : "Worked on <b>" + to.replace("r", "replica ") + "</b>. Version and capabilities were in the request, so any copy can answer.");
      }
      const initBtn = h("button", { class: "btn", type: "button", text: "initialize", onclick: function () { request("initialize"); } });
      const killBtn = h("button", { class: "btn", type: "button", text: "Kill replica 1", onclick: function () {
        dead = !dead;
        stage.set("r1", { dim: dead });
        stage.badge("r1", null);
        killBtn.textContent = dead ? "Restart replica 1" : "Kill replica 1";
        if (dead && session && session.on === "r1") PG.setResult(verdict, "warn", "Replica 1 is down. Its session went with it.");
      } });
      const stickySw = PG.switch("lb-sticky", "Sticky by Mcp-Session-Id", false, function (v) { sticky = v; });
      function setEra(v) {
        era = v; session = null; rr = 0;
        ["r1", "r2", "r3"].forEach(function (r) { stage.badge(r, null); });
        initBtn.hidden = v !== "legacy"; stickySw.hidden = v !== "legacy";
        bw.clear();
        PG.setResult(verdict, "", v === "legacy" ? "Legacy (≤ 2025-11-25): send <b>initialize</b> first, then tools/list a few times." : "2026-07-28: no initialize. Send tools/list a few times, then kill replica 1 and send again.");
      }
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([{ v: "legacy", label: "Legacy: initialize + session" }, { v: "modern", label: "2026-07-28: stateless" }], "legacy", setEra, "Era")),
        h("div", { class: "row" }, initBtn, h("button", { class: "btn primary", type: "button", text: "tools/list", onclick: function () { request("tools/list"); } }), killBtn, stickySw),
        verdict), stage.el);
      setEra("legacy");
    },
    quiz: [
      { q: "Which two _meta fields are required on every 2026-07-28 request?",
        opts: ["protocolVersion and clientInfo", "protocolVersion and clientCapabilities", "clientInfo and logLevel", "sessionId and protocolVersion"],
        a: 1, why: "protocolVersion and clientCapabilities are MUST; clientInfo is SHOULD." },
      { q: "A request arrives without protocolVersion. What does the server answer?",
        opts: ["It assumes the latest version", "-32602 Invalid params (HTTP 400)", "-32022 UnsupportedProtocolVersion", "It asks for initialize"],
        a: 1, why: "Missing required _meta is an invalid-params error. -32022 is for a version that is present but unsupported." },
      { q: "Why do stateless requests matter for running several copies of a server?",
        opts: ["They make responses smaller", "Any copy can answer any request, with no sticky routing and nothing lost on restart", "They remove the need for authentication", "They let the server push requests to the client"],
        a: 1, why: "With no handshake and no session, there is no per-copy memory that a request depends on." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: server/discover and versions
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "discover",
    track: "foundations",
    title: "server/discover and agreeing on a version",
    short: "Discover & versions",
    thesis: "A server must answer server/discover with the versions it speaks, its capabilities and who it is. A client can call it first, or just send a request and recover from UnsupportedProtocolVersion.",
    refs: "Spec 2026-07-28 · server/discover · Versioning · Transports §Backward compatibility",
    brief: `
      <h2>Versions are dates</h2>
      <p>A version string like <code>2026-07-28</code> names the last date with breaking changes. Revisions before it (<code>2025-11-25</code>, <code>2025-06-18</code>, <code>2025-03-26</code>, <code>2024-11-05</code>) are the <strong>legacy era</strong>: they use the <code>initialize</code> handshake. 2026-07-28 starts the <strong>modern era</strong>: per-request <code>_meta</code>.</p>
      <h2>server/discover</h2>
      <p>Every server MUST implement it. The result carries <code>supportedVersions</code>, <code>capabilities</code>, optional <code>instructions</code> for the model, <code>serverInfo</code> in <code>_meta</code>, and cache hints <code>ttlMs</code> and <code>cacheScope</code>. Calling it is optional for clients.</p>
      <div class="note spec"><span class="note-label">Spec</span><code>serverInfo</code> is self-reported. Use it for display and logs, never for security decisions or to change behaviour.</div>
      <h2>When versions don't match</h2>
      <p>The server answers <code>-32022</code> UnsupportedProtocolVersion with <code>data: { supported: [...], requested: "..." }</code> (HTTP 400). The client picks a version from <code>supported</code> and retries.</p>
      <h2>Talking to legacy servers</h2>
      <ul>
        <li><strong>HTTP</strong>: try a modern request. On 400, read the body. A recognised modern error (-32022, -32021, -32020, missing _meta) means the server is modern: fix the request. Anything else, or an empty body: fall back to <code>initialize</code>.</li>
        <li><strong>stdio</strong>: probe with <code>server/discover</code> first. A result: modern. A modern error such as -32022: modern, pick from <code>supported</code>. Any other error or silence: legacy, use <code>initialize</code>. Don't key the fallback to one error code.</li>
      </ul>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Negotiate a version", "Lab · supported versions · -32022");
      const all = [SPEC.V].concat(SPEC.LEGACY);
      const client = { [SPEC.V]: true, "2025-11-25": true };
      const server = { [SPEC.V]: false, "2025-11-25": true, "2025-06-18": true };
      function picker(state, label, idp) {
        return h("div", { class: "stack" }, h("p", { class: "eyebrow", text: label }),
          h("div", { class: "row" }, all.map(function (v) {
            return PG.switch(idp + v, v, !!state[v], function (on) { state[v] = on; });
          })));
      }
      let strategy = "inline";
      const out = h("div", { class: "result", text: "Choose what each side supports, then connect." });
      const wire = PG.wire(a.body, { title: "Wire" });
      const go = h("button", { class: "btn primary", type: "button", text: "Connect and list tools" });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "grid2" }, picker(client, "Client speaks", "cv-"), picker(server, "Server speaks", "sv-")),
        h("div", { class: "row" }, PG.seg([{ v: "inline", label: "Just send, recover on -32022" }, { v: "discover", label: "Call server/discover first" }], "inline", function (v) { strategy = v; }, "Strategy"), go),
        out), wire.el);
      function cv() { return all.filter(function (v) { return client[v]; }); }
      function sv() { return all.filter(function (v) { return server[v]; }); }
      go.addEventListener("click", function () {
        wire.clear();
        const c = cv(), s = sv();
        if (!c.length || !s.length) { PG.setResult(out, "warn", "Each side needs at least one version."); return; }
        const common = c.filter(function (v) { return s.indexOf(v) >= 0; });
        const modern = function (v) { return v === SPEC.V; };
        let id = 1;
        function legacyPath(v) {
          wire.add({ kind: "note", label: "No modern version in common. Falling back to the legacy handshake with " + v + "." });
          wire.add({ actor: "client", label: "initialize · " + v, http: SPEC.post(null, null, null, { legacy: true }), body: SPEC.rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: SPEC.clientInfo }, id++, { noMeta: true }), hl: ["protocolVersion"] });
          wire.add({ kind: "in", actor: "server", label: "initialize result · " + v, status: "200", http: SPEC.res(200, "json", { "Mcp-Session-Id": "sess-" + PG.hex(4) }), body: SPEC.ok(id - 1, { protocolVersion: v, capabilities: SPEC.serverCaps, serverInfo: SPEC.serverInfo }, { legacy: true }) });
        }
        const first = c[0];
        if (strategy === "discover") {
          if (!s.some(modern)) {
            wire.add({ actor: "client", label: "server/discover", http: SPEC.post("server/discover"), body: SPEC.rpc("server/discover", {}, id++) });
            wire.add({ kind: "in", actor: "server", label: "400 · not a modern error (legacy server)", status: "400", http: SPEC.res(400), body: SPEC.err(1, -32600, "Bad Request: Server not initialized") });
            const leg = common.filter(function (v) { return !modern(v); });
            if (leg.length) { legacyPath(leg[0]); PG.setResult(out, "warn", "The server is legacy-only. The probe's error wasn't a modern one, so the client fell back to <code>initialize</code> with <b>" + leg[0] + "</b>."); }
            else PG.setResult(out, "err", "Legacy server, and no legacy version in common. No connection.");
            return;
          }
          wire.add({ actor: "client", label: "server/discover", http: SPEC.post("server/discover"), body: SPEC.rpc("server/discover", {}, id++, { version: first }) });
          wire.add({ kind: "in", actor: "server", label: "supportedVersions: " + s.join(", "), status: "200", http: SPEC.res(200), body: SPEC.ok(1, SPEC.discoverResult({ versions: s })), hl: ["supportedVersions"] });
          if (!common.length) { PG.setResult(out, "err", "Nothing in common. The client can show the server's versions to the user, but can't talk to it."); return; }
          if (modern(common[0])) {
            wire.add({ actor: "client", label: "tools/list · " + common[0], http: SPEC.post("tools/list", null, null, { version: common[0] }), body: SPEC.rpc("tools/list", {}, id++, { version: common[0] }) });
            wire.add({ kind: "in", actor: "server", label: "result", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { tools: SPEC.tools.map(function (t) { return { name: t.name }; }), ttlMs: 300000, cacheScope: "public" }) });
            PG.setResult(out, "ok", "One round trip to learn the versions, then the first real request was right.");
          } else { legacyPath(common[0]); PG.setResult(out, "warn", "The server advertised modern versions, but the only one in common is legacy (" + common[0] + "), so the client uses the handshake."); }
          return;
        }
        /* inline */
        wire.add({ actor: "client", label: "tools/list · " + first, http: SPEC.post("tools/list", null, null, { version: first }), body: SPEC.rpc("tools/list", {}, id++, { version: first }), hl: [SPEC.K.version] });
        if (s.indexOf(first) >= 0) {
          wire.add({ kind: "in", actor: "server", label: "result", status: "200", http: SPEC.res(200), body: SPEC.ok(1, { tools: SPEC.tools.map(function (t) { return { name: t.name }; }), ttlMs: 300000, cacheScope: "public" }) });
          PG.setResult(out, "ok", "The client's preferred version was supported: zero extra round trips.");
          return;
        }
        if (!s.some(modern)) {
          wire.add({ kind: "in", actor: "server", label: "400 · not a modern error", status: "400", http: SPEC.res(400), body: "Bad Request: missing session" });
          const leg = common.filter(function (v) { return !modern(v); });
          if (leg.length) { legacyPath(leg[0]); PG.setResult(out, "warn", "The 400 body was not a recognised modern error, so the server is legacy. Fell back to <code>initialize</code>."); }
          else PG.setResult(out, "err", "Legacy server, no legacy version in common.");
          return;
        }
        wire.add({ kind: "in", actor: "server", label: "-32022 UnsupportedProtocolVersion", status: "400", http: SPEC.res(400),
          body: SPEC.err(1, -32022, "Unsupported protocol version", { supported: s, requested: first }), hl: ["data"], open: true });
        if (!common.length) { PG.setResult(out, "err", "A modern error, so don't fall back to initialize. But nothing in <code>supported</code> is one the client speaks."); return; }
        const pickV = common[0];
        if (modern(pickV)) {
          wire.add({ actor: "client", label: "tools/list · retry with " + pickV, http: SPEC.post("tools/list", null, null, { version: pickV }), body: SPEC.rpc("tools/list", {}, id++, { version: pickV }) });
          wire.add({ kind: "in", actor: "server", label: "result", status: "200", http: SPEC.res(200), body: SPEC.ok(2, { tools: [], ttlMs: 300000, cacheScope: "public" }) });
        } else legacyPath(pickV);
        PG.setResult(out, "ok", "The error's <code>data.supported</code> told the client what to use: retried with <b>" + pickV + "</b>.");
      });
    },
    quiz: [
      { q: "A modern server gets a request for a version it doesn't speak. What does it send?",
        opts: ["-32601 Method not found", "-32022 with data.supported and data.requested", "An initialize request", "HTTP 426 Upgrade Required"],
        a: 1, why: "UnsupportedProtocolVersionError, code -32022, HTTP 400, with the versions it does support." },
      { q: "On stdio, the server/discover probe gets <code>-32601</code>. What should the client do?",
        opts: ["Give up", "Retry server/discover with another version", "Treat the server as legacy and send initialize", "Send tools/list without _meta"],
        a: 2, why: "Any error that isn't a recognised modern one (or no reply) means legacy: fall back to the initialize handshake. The rule must not depend on one specific code." },
      { q: "May a client change its behaviour because serverInfo.name is \"trusted-corp-server\"?",
        opts: ["Yes, that's what it is for", "No: it's self-reported and only for display and logging", "Only over HTTPS", "Only if the name matches the domain"],
        a: 1, why: "serverInfo is not verified by the protocol. Trust decisions come from configuration and authorization, not self-description." },
    ],
  });
})();
