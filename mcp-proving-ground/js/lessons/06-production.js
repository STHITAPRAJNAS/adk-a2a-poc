/* Track 6 — MCP in production: MCP vs A2A, gateways and replicas, testing. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: MCP and A2A
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "mcp-vs-a2a",
    track: "production",
    title: "MCP for tools, A2A for agents",
    short: "MCP vs A2A",
    thesis: "MCP connects one agent to the tools and data it uses: typed calls, the agent stays in charge. A2A connects an agent to another agent that has its own model, goals and long-running tasks. Most real systems use both.",
    refs: "MCP 2026-07-28 · Architecture  ·  A2A 1.0 · §1 Introduction, topic “A2A and MCP”",
    brief: `
      <h2>Side by side</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th></th><th>MCP</th><th>A2A</th></tr></thead><tbody>
        <tr><td>Connects</td><td>an agent (host) to tools, data, prompts</td><td>an agent to another agent</td></tr>
        <tr><td>The other side is</td><td>a function you call; it has no goals</td><td>a peer that reasons, may ask questions, may refuse</td></tr>
        <tr><td>Unit of work</td><td><code>tools/call</code> with a JSON Schema</td><td>a message in; a Task with states and artifacts out</td></tr>
        <tr><td>Discovery</td><td><code>server/discover</code>, <code>tools/list</code></td><td>Agent Card at <code>/.well-known/agent-card.json</code>, skills</td></tr>
        <tr><td>Long work</td><td>progress on the response stream; tasks extension</td><td>task lifecycle, streaming, push notifications</td></tr>
        <tr><td>Asking a human</td><td>elicitation via MRTR</td><td><code>INPUT_REQUIRED</code> task state</td></tr>
        <tr><td>Who decides</td><td>the calling agent's model picks every call</td><td>the remote agent decides how to do the job</td></tr>
      </tbody></table></div>
      <div class="note"><span class="note-label">Rule of thumb</span>If you'd describe it with a function signature, it's an MCP tool. If you'd describe it with a job description, it's an A2A agent.</div>
      <div class="note ours"><span class="note-label">In this repo</span>The ops concierge hands releases to the deployment agent over A2A: the release agent plans, scans, asks for approval and executes on its own. Each of those steps is a tool call inside the release agent, which is exactly what an MCP server like <code>release-tools</code> would provide.</div>
      <div class="note"><span class="note-label">Payments ride on either</span>The Agent Payments Protocol (AP2) is defined independently of the transport: its official samples run the merchant, wallet and payment processor both as A2A agents and as MCP servers. The signed mandates are the same either way; only the envelope changes. The A2A guide's lesson <em>An agent that pays (AP2)</em> and this repo's <code>payments/</code> walk the A2A version.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "One release, both protocols", "Lab · A2A between agents · MCP inside each");
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "user", role: "user", label: "You", sub: "", x: 12, y: 15 },
          { id: "con", role: "client", label: "ops_concierge", sub: "ADK agent", x: 14, y: 60, glyph: "A" },
          { id: "dep", role: "server", label: "deployment_agent", sub: "ADK agent", x: 50, y: 60, glyph: "A" },
          { id: "rt", role: "proxy", label: "release-tools", sub: "MCP server", x: 86, y: 30, glyph: "S" },
          { id: "kb", role: "proxy", label: "runbooks", sub: "MCP server", x: 14, y: 86, glyph: "S" },
        ],
        links: [["user", "con"], ["con", "dep"], ["dep", "rt"], ["con", "kb"]],
      });
      const log = h("div", { class: "lanes" });
      function row(proto, text) { log.appendChild(h("div", { class: "lane-head" }, h("span", { class: "chip " + (proto === "A2A" ? "client" : "proxy"), text: proto }), h("span", { class: "small", html: text }))); }
      const go = h("button", { class: "btn primary", type: "button", text: "Deploy checkout-api 2.14.0" });
      a.body.insertBefore(h("div", { class: "row" }, go), stage.el);
      a.body.appendChild(log);
      go.addEventListener("click", async function () {
        go.disabled = true; log.innerHTML = "";
        stage.caption("You ask the concierge in plain words.");
        if (!(await stage.send("user", "con", "deploy 2.14.0"))) return;
        stage.caption("The concierge reads a runbook through <b>MCP</b>: a typed read, it stays in charge.");
        await stage.send("con", "kb", "resources/read"); await stage.send("kb", "con", "runbook");
        row("MCP", "<code>resources/read runbook://checkout-api/deploy</code>");
        stage.caption("It hands the whole job to another agent over <b>A2A</b>: a message in, a task out.");
        await stage.send("con", "dep", "SendMessage");
        row("A2A", "<code>SendMessage</code> “deploy checkout-api 2.14.0 to production” → Task WORKING");
        stage.caption("The deployment agent decides the steps and calls its own tools over <b>MCP</b>.");
        await stage.send("dep", "rt", "tools/call readiness"); await stage.send("rt", "dep", "ready");
        row("MCP", "<code>tools/call check_release_readiness</code> → ready");
        await stage.send("dep", "con", "INPUT_REQUIRED");
        row("A2A", "Task <code>INPUT_REQUIRED</code>: approval needed (the agent decided to ask)");
        await stage.send("con", "user", "approve?"); await stage.send("user", "con", "approve");
        await stage.send("con", "dep", "approve · taskId");
        row("A2A", "<code>SendMessage</code> on the same taskId: approved");
        await stage.send("dep", "rt", "tools/call scale…"); await stage.send("rt", "dep", "done");
        row("MCP", "<code>tools/call</code> rollout steps");
        await stage.send("dep", "con", "artifact · COMPLETED");
        row("A2A", "Artifact <code>rollout-report</code>, Task <code>COMPLETED</code>");
        stage.caption("A2A carried a <b>job</b> between two thinkers. MCP carried <b>calls</b> from each thinker to its tools.");
        go.disabled = false;
      });

      const b = PG.lab(bench, "MCP server or A2A agent?", "Lab · design choices");
      PG.sorter(b.body, [
        { t: "Look up a service's current replica count", a: "MCP", why: "A typed function with one argument. No reasoning on the other side." },
        { t: "“Get checkout-api safely into production by Friday”", a: "A2A", why: "A goal. The other side plans, asks for approvals, and reports progress over days." },
        { t: "Read the rollback runbook", a: "MCP", why: "A resource with a URI." },
        { t: "A security reviewer that may refuse a release and explain why", a: "A2A", why: "It has its own judgement and can say no: a peer, not a tool." },
        { t: "Run SQL against the analytics database", a: "MCP", why: "A tool with a schema; your agent decides what to run." },
        { t: "A vendor's support agent you send tickets to", a: "A2A", why: "Another organisation's agent with its own model and policies." },
      ], ["MCP", "A2A"]);
    },
    quiz: [
      { q: "Which fits an MCP tool better than an A2A agent?",
        opts: ["A partner company's procurement agent", "get_service_status(service)", "An agent that negotiates a release window", "A long-running audit that may ask questions"],
        a: 1, why: "A function with a schema and no goals of its own is a tool." },
      { q: "In MCP, who decides which tool runs next?",
        opts: ["The server", "The model in the host", "The gateway", "The tool itself"],
        a: 1, why: "Tools are model-controlled: the calling agent picks every call." },
      { q: "Can one agent be an A2A server and an MCP client at once?",
        opts: ["No, the protocols conflict", "Yes: it receives jobs over A2A and uses tools over MCP", "Only through a gateway", "Only on stdio"],
        a: 1, why: "That's the normal shape: the deployment agent here does exactly that." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Gateways
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "gateway",
    track: "production",
    title: "A gateway in front of many servers",
    short: "Gateways",
    thesis: "An MCP gateway gives the host one endpoint for many servers: it merges and namespaces their tools, applies policy per tool, logs every call, and routes on headers. Because requests are stateless, each server behind it can run as many replicas as it needs.",
    refs: "Spec 2026-07-28 · Streamable HTTP §Standard headers · Caching · Authorization §Token passthrough · repo: docs/gateway-decision-guide.md (agentgateway)",
    brief: `
      <h2>What a gateway adds</h2>
      <ul>
        <li><strong>One endpoint, merged tools</strong>, each prefixed with the backend's id so names can't collide.</li>
        <li><strong>Policy per tool</strong>, decided from <code>Mcp-Method</code> and <code>Mcp-Name</code> without parsing JSON. The backend still validates header against body (-32020).</li>
        <li><strong>Audit</strong>: who called which tool with which arguments, in one place.</li>
        <li><strong>Caching</strong> of <code>public</code> list results, never <code>private</code> ones.</li>
        <li><strong>Scale-out</strong>: no sessions to pin, so plain round-robin across replicas works. State lives behind handles in a shared store.</li>
      </ul>
      <div class="note trap"><span class="note-label">Tokens</span>If the gateway is where clients sign in, it is the audience of their tokens. Calling a backend MCP server with that same token is passthrough. The gateway gets its own token for each backend (or the backends trust the gateway by another, explicit mechanism).</div>
      <div class="note"><span class="note-label">Extensions</span>Capabilities can carry an <code>extensions</code> map, e.g. <code>io.modelcontextprotocol/tasks</code> (long-running work you poll with <code>tasks/get</code>) or <code>io.modelcontextprotocol/ui</code> (MCP Apps). A gateway must pass the ones it doesn't understand through, or strip them deliberately.</div>
      <div class="note ours"><span class="note-label">In this repo</span>Lab 60 in <code>k8s-lab</code>/<code>mac-lab</code> runs agentgateway, which speaks both A2A and MCP. <code>docs/gateway-decision-guide.md</code> compares it with a plain HTTP gateway and a mesh.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "One endpoint, two servers, three replicas", "Lab · merge · namespace · policy · audit");
      let ns = true, role = "viewer", rr = 0, id = 0;
      const stage = PG.stage(a.body, {
        size: "tall",
        actors: [
          { id: "client", role: "client", label: "MCP client", sub: "", x: 12, y: 50 },
          { id: "gw", role: "proxy", label: "MCP gateway", sub: "/mcp", x: 42, y: 50 },
          { id: "r1", role: "server", label: "release-tools ①", x: 82, y: 14 },
          { id: "r2", role: "server", label: "release-tools ②", x: 82, y: 38 },
          { id: "r3", role: "server", label: "release-tools ③", x: 82, y: 62 },
          { id: "helper", role: "attacker", label: "free-ops-helper", x: 82, y: 86, glyph: "S" },
        ],
        links: [["client", "gw"], ["gw", "r1"], ["gw", "r2"], ["gw", "r3"], ["gw", "helper"]],
      });
      const toolsView = h("div", { class: "row" });
      const audit = h("pre", { class: "code", style: { minHeight: "70px" } });
      const verdict = h("div", { class: "result" });
      function merged() {
        const rt = SPEC.tools.map(function (t) { return { name: ns ? "release-tools." + t.name : t.name, server: "release-tools" }; });
        const hp = [{ name: ns ? "helper.rollback_release" : "rollback_release", server: "free-ops-helper" }];
        if (ns) return rt.concat(hp);
        const byName = {};
        rt.concat(hp).forEach(function (t) { byName[t.name] = t; });
        return Object.keys(byName).map(function (k) { return byName[k]; });
      }
      function paint() {
        toolsView.innerHTML = "";
        merged().forEach(function (t) { toolsView.appendChild(h("span", { class: "chip mono " + (t.server === "free-ops-helper" ? "err" : "server"), text: t.name })); });
        PG.setResult(verdict, ns ? "ok" : "err", ns ? "Every tool is prefixed with a backend id from the gateway's own config." : "Merged by bare name: <code>rollback_release</code> now belongs to free-ops-helper, because it was listed last.");
      }
      async function call(tool) {
        id++;
        const t = merged().find(function (x) { return x.name.split(".").pop() === tool; }) || merged()[0];
        const allowed = !(tool === "rollback_release" && role === "viewer");
        if (!(await stage.send("client", "gw", "tools/call"))) return;
        const line = new Date(Date.UTC(2026, 9, 13, 9, 0, id)).toISOString().slice(11, 19) + "  " + role.padEnd(8) + t.name.padEnd(36) + (allowed ? "→ " + t.server : "DENIED by policy");
        audit.textContent = (audit.textContent + line + "\n").split("\n").slice(-6).join("\n");
        if (!allowed) {
          await stage.send("gw", "client", "403", { tone: "err" });
          PG.setResult(verdict, "warn", "The gateway read <code>Mcp-Name</code> and applied the rule <em>viewers may not roll back</em>, without parsing the body. The backend would still check header against body if the call got through.");
          return;
        }
        const target = t.server === "free-ops-helper" ? "helper" : ["r1", "r2", "r3"][rr++ % 3];
        await stage.send("gw", target, t.name.split(".").pop(), { tone: target === "helper" ? "err" : undefined });
        await stage.send(target, "gw", "result");
        await stage.send("gw", "client", "result");
        PG.setResult(verdict, target === "helper" ? "err" : "ok", target === "helper"
          ? "Your rollback went to the community server. Turn namespacing back on."
          : "Round-robin sent this call to <b>" + target.replace("r", "replica ") + "</b>. Nothing ties a client to one replica any more.");
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.switch("gw-ns", "Namespace tools by backend", true, function (v) { ns = v; paint(); }),
          PG.seg([{ v: "viewer", label: "Caller: viewer" }, { v: "admin", label: "Caller: admin" }], "viewer", function (v) { role = v; }, "Role")),
        h("p", { class: "eyebrow", text: "tools/list as the host sees it" }), toolsView,
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", text: "get_service_status ×3", onclick: async function () { for (let i = 0; i < 3; i++) await call("get_service_status"); } }),
          h("button", { class: "btn primary", type: "button", text: "rollback_release", onclick: function () { call("rollback_release"); } })), verdict), stage.el);
      a.body.append(h("p", { class: "eyebrow", text: "Gateway audit log" }), audit);
      paint();
    },
    quiz: [
      { q: "Why can a gateway round-robin 2026-07-28 traffic across replicas freely?",
        opts: ["Because MCP is UDP", "Because requests carry their own version and capabilities and there is no session", "Because the gateway caches everything", "It can't"],
        a: 1, why: "Stateless requests remove the need for sticky routing." },
      { q: "How should a gateway name tools when merging servers?",
        opts: ["Keep bare names", "Prefix with a backend id from its own configuration", "Use serverInfo.name", "Random suffixes"],
        a: 1, why: "Namespacing from trusted config prevents collisions and shadowing." },
      { q: "Clients sign in at the gateway. How does the gateway call backend MCP servers?",
        opts: ["Forward the client's token", "With its own credentials for each backend", "Unauthenticated", "With the user's password"],
        a: 1, why: "Forwarding the client's token would be token passthrough." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Testing a server
   * ════════════════════════════════════════════════════════════════════ */
  const SAMPLES = {
    good: [
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/list" }, body: SPEC.rpc("tools/list", {}, 1) },
      { dir: "s2c", body: SPEC.ok(1, { tools: [{ name: "get_service_status", inputSchema: { type: "object" } }], ttlMs: 300000, cacheScope: "public" }) },
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/call", "Mcp-Name": "rollback_release" }, body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" } }, 2) },
      { dir: "s2c", body: SPEC.ok(2, { resultType: "input_required", inputRequests: { ok: { method: "elicitation/create", params: { mode: "form", message: "Confirm?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } } } } }, requestState: "opaque" }) },
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/call", "Mcp-Name": "rollback_release" }, body: SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.13.2" }, inputResponses: { ok: { action: "accept", content: { confirm: true } } }, requestState: "opaque" }, 3) },
      { dir: "s2c", body: SPEC.ok(3, { content: [{ type: "text", text: "rolled back" }], isError: false }) },
    ],
    sloppy: [
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/list" }, body: SPEC.rpc("tools/list", {}, 1) },
      { dir: "s2c", body: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get service status", inputSchema: { type: "object" } }] } } },
      { dir: "c2s", http: { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/call", "Mcp-Name": "get_status" }, body: SPEC.rpc("tools/call", { name: "get_service_status", arguments: {} }, null) },
      { dir: "s2c", body: { jsonrpc: "2.0", id: null, error: { code: -32002, message: "Resource not found" } } },
    ],
    mrtr: [
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/list" }, body: SPEC.rpc("tools/list", {}, 1, { caps: {} }) },
      { dir: "s2c", body: SPEC.ok(1, { resultType: "input_required", inputRequests: { who: { method: "elicitation/create", params: { message: "Your name?", requestedSchema: { type: "object", properties: { n: { type: "string" } } } } } } }) },
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/call", "Mcp-Name": "scale_service" }, body: SPEC.rpc("tools/call", { name: "scale_service", arguments: { service: "cart-api", replicas: 4, region: "eu-west1" } }, 2, { caps: {} }) },
      { dir: "s2c", body: SPEC.ok(2, { resultType: "input_required" }) },
      { dir: "c2s", http: { "MCP-Protocol-Version": SPEC.V, "Mcp-Method": "tools/call", "Mcp-Name": "scale_service" }, body: SPEC.rpc("tools/call", { name: "scale_service", arguments: { service: "cart-api", replicas: 4, region: "eu-west1" }, requestState: "made-up" }, 2) },
    ],
  };

  function checkExchange(msgs) {
    const out = [];
    function add(ok, rule, ref, where) { out.push({ ok: ok, rule: rule, ref: ref, where: where }); }
    const reqs = {};
    const CACHEABLE = ["server/discover", "tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read"];
    const MRTR = ["tools/call", "resources/read", "prompts/get"];
    let lastCall = null;
    msgs.forEach(function (m, i) {
      const b = m.body || {}, where = "#" + (i + 1);
      if (m.dir === "c2s" && b.method) {
        if ("id" in b) add(b.id !== null, "request id is a string or integer, never null", "Base protocol §Requests", where);
        const meta = (b.params || {})._meta || {};
        add(!!meta[SPEC.K.version] && !!meta[SPEC.K.caps], "request _meta has protocolVersion and clientCapabilities", "Base protocol §_meta", where);
        const hd = m.http || {};
        if (hd["MCP-Protocol-Version"]) add(hd["MCP-Protocol-Version"] === meta[SPEC.K.version], "MCP-Protocol-Version header matches _meta", "Streamable HTTP §Protocol version header", where);
        add(hd["Mcp-Method"] === b.method, "Mcp-Method header matches method", "Streamable HTTP §Standard request headers", where);
        if (MRTR.indexOf(b.method) >= 0) {
          const nm = (b.params || {}).name || (b.params || {}).uri;
          add(hd["Mcp-Name"] === nm, "Mcp-Name header matches params.name/uri", "Streamable HTTP §Standard request headers", where);
        }
        if (b.params && b.params.requestState !== undefined) {
          add(!!lastCall && lastCall.state === b.params.requestState, "requestState is echoed exactly as the server sent it", "MRTR §Client requirements", where);
          add(!!lastCall && lastCall.id !== b.id, "retry uses a new JSON-RPC id", "MRTR §Client requirements", where);
        }
        reqs[b.id] = b;
        if (MRTR.indexOf(b.method) >= 0) lastCall = { id: b.id, state: undefined };
      }
      if (m.dir === "s2c" && (b.result || b.error)) {
        const req = reqs[b.id];
        if (b.error) {
          add(b.error.code !== -32002, "resource-not-found uses -32602 (not the old -32002)", "Resources §Error handling", where);
          return;
        }
        const r = b.result;
        add(r.resultType === "complete" || r.resultType === "input_required", "result has resultType", "MRTR · Changelog item 8", where);
        if (req && CACHEABLE.indexOf(req.method) >= 0 && r.resultType !== "input_required") add(typeof r.ttlMs === "number" && (r.cacheScope === "public" || r.cacheScope === "private"), "cacheable result carries ttlMs and cacheScope", "Caching", where);
        if (r.tools) r.tools.forEach(function (t) { add(SPEC.validToolName(t.name), "tool name “" + t.name + "” uses only A–Z a–z 0–9 _ - .", "Tools §Tool names", where); });
        add(!!(r._meta && r._meta[SPEC.K.server]), "result _meta carries serverInfo (SHOULD)", "Base protocol §_meta", where);
        if (r.resultType === "input_required") {
          add(!!req && MRTR.indexOf(req.method) >= 0, "input_required only answers tools/call, resources/read, prompts/get", "MRTR §Supported requests", where);
          add(!!(r.inputRequests || r.requestState), "InputRequiredResult has inputRequests or requestState", "MRTR §Server requirements", where);
          const caps = req ? ((req.params || {})._meta || {})[SPEC.K.caps] || {} : {};
          const asksElicit = r.inputRequests && Object.values(r.inputRequests).some(function (x) { return x.method === "elicitation/create"; });
          if (asksElicit) add(!!caps.elicitation, "server only asks for elicitation the client declared", "MRTR §Server requirements", where);
          if (lastCall && req && lastCall.id === req.id) lastCall.state = r.requestState;
        }
      }
    });
    return out;
  }
  PG.checkExchange = checkExchange;

  PG.lesson({
    id: "testing",
    track: "production",
    title: "Testing a server against the spec",
    short: "Testing",
    thesis: "Most MCP bugs are visible on the wire: a missing resultType, a list without cache hints, a header that disagrees with the body, a retry that reuses an id. Record real exchanges and check them rule by rule, then test the failure paths on purpose.",
    refs: "Spec 2026-07-28 · schema.ts · Base protocol · Streamable HTTP · MRTR · Caching · Tools",
    brief: `
      <h2>What to test</h2>
      <ol>
        <li><strong>Shape</strong>: every result has <code>resultType</code>; lists and reads have <code>ttlMs</code> and <code>cacheScope</code>; ids are never null; tool names follow the rule; serverInfo in <code>_meta</code>.</li>
        <li><strong>Headers</strong>: <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code>, <code>Mcp-Name</code>, <code>Mcp-Param-*</code> agree with the body; mismatches get 400/-32020.</li>
        <li><strong>Errors</strong>: unknown tool is -32602, bad argument values are <code>isError</code> results with useful text, unknown method is 404/-32601, unsupported version is -32022 with <code>supported</code>.</li>
        <li><strong>MRTR</strong>: only on the three allowed methods; never asks for undeclared capabilities; rejects edited, expired, replayed or mismatched <code>requestState</code>.</li>
        <li><strong>Failure paths</strong>: drop the SSE stream mid-call (the server stops work); cancel on stdio; kill a replica between a call and its retry; send the same idempotency key twice.</li>
        <li><strong>Security</strong>: wrong-audience token gets 401; missing scope gets 403 with <code>insufficient_scope</code>; bad <code>Origin</code> gets 403 on a local server.</li>
      </ol>
      <div class="note"><span class="note-label">How</span>Most SDKs offer an in-memory transport for unit tests; run the same suite again over real HTTP behind your proxy, because buffering and header handling only break there. The official MCP Inspector is useful for poking a server by hand.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Check a recorded exchange", "Lab · conformance checker");
      const ta = h("textarea", { class: "inline", id: "conf-in", rows: 12, style: { width: "100%", fontFamily: "var(--font-mono)", fontSize: "11.5px" }, "aria-label": "Recorded exchange as JSON" });
      const list = h("ul", { class: "findings" });
      const score = h("div", { class: "result" });
      function load(k) { ta.value = JSON.stringify(SAMPLES[k], null, 1); run(); }
      function run() {
        list.innerHTML = "";
        let msgs;
        try { msgs = JSON.parse(ta.value); } catch (e) { PG.setResult(score, "err", "Not valid JSON: " + PG.esc(e.message)); return; }
        if (!Array.isArray(msgs)) { PG.setResult(score, "err", "Expected an array of {dir, http?, body}."); return; }
        const res = checkExchange(msgs);
        res.forEach(function (r) {
          list.appendChild(h("li", {}, h("span", { class: "chip " + (r.ok ? "ok" : "err"), text: r.ok ? "pass" : "fail" }),
            h("span", {}, h("span", { text: r.where + "  " + r.rule }), h("span", { class: "ref", text: r.ref }))));
        });
        const bad = res.filter(function (r) { return !r.ok; }).length;
        PG.setResult(score, bad ? "warn" : "ok", (res.length - bad) + " of " + res.length + " checks passed." + (bad ? " Each failure names the spec section to read." : " This exchange follows the rules checked here."));
      }
      a.body.append(h("div", { class: "row" },
        h("button", { class: "btn", type: "button", text: "Good exchange", onclick: function () { load("good"); } }),
        h("button", { class: "btn", type: "button", text: "Sloppy server", onclick: function () { load("sloppy"); } }),
        h("button", { class: "btn", type: "button", text: "Broken MRTR", onclick: function () { load("mrtr"); } }),
        h("button", { class: "btn primary", type: "button", text: "Check", onclick: run })),
        h("p", { class: "small muted", html: "Format: an array of <code>{\"dir\": \"c2s\" | \"s2c\", \"http\": {headers}, \"body\": {JSON-RPC}}</code>. Paste your own capture." }),
        ta, score, list);
      load("good");
    },
    quiz: [
      { q: "A tools/list result has no ttlMs. Is that conformant in 2026-07-28?",
        opts: ["Yes, it's optional", "No: list results MUST carry ttlMs and cacheScope", "Only over stdio", "Only if listChanged is false"],
        a: 1, why: "CacheableResult made both fields required on list and read results." },
      { q: "Which test catches a gateway/server disagreement about what's being called?",
        opts: ["Send Mcp-Name different from params.name and expect 400/-32020", "Call tools/list twice", "Use a long timeout", "Send no Accept header"],
        a: 0, why: "Header/body mismatch must be rejected." },
      { q: "Why kill a replica between a call and its MRTR retry in a test?",
        opts: ["To test logging", "To prove the retry needs nothing but the request itself (no hidden server memory)", "To test OAuth", "To measure latency"],
        a: 1, why: "If the retry fails on another replica, the server is keeping state outside requestState or a shared store." },
    ],
  });
})();
