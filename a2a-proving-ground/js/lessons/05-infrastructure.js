/* Track 5 — Infrastructure: bindings & versions, proxies & gateways,
 * extensions, and how A2A relates to MCP. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Bindings & versioning
   * ════════════════════════════════════════════════════════════════════ */
  const TASK_ID = "task-7f3a", CFG_ID = "cfg-1";
  function paramsFor(m) {
    switch (m) {
      case "SendMessage":
      case "SendStreamingMessage": return { message: SPEC.msg("user", ["Deploy checkout-api 2.14.0 to staging"]) };
      case "GetTask": return { id: TASK_ID, historyLength: 10 };
      case "ListTasks": return { contextId: "ctx-91c2", status: "TASK_STATE_WORKING", pageSize: 50 };
      case "CancelTask":
      case "SubscribeToTask": return { id: TASK_ID };
      case "CreateTaskPushNotificationConfig": return { taskId: TASK_ID, url: "https://concierge.example.com/a2a/webhook", authentication: { scheme: "Bearer", credentials: "whk_…" } };
      case "GetTaskPushNotificationConfig":
      case "DeleteTaskPushNotificationConfig": return { taskId: TASK_ID, id: CFG_ID };
      case "ListTaskPushNotificationConfigs": return { taskId: TASK_ID };
      default: return undefined;
    }
  }
  function resultFor(m) {
    const task = SPEC.task(TASK_ID, "ctx-91c2", "WORKING");
    switch (m) {
      case "SendMessage": return { task: task };
      case "GetTask": case "CancelTask": return m === "CancelTask" ? SPEC.task(TASK_ID, "ctx-91c2", "CANCELED") : task;
      case "ListTasks": return { tasks: [task], nextPageToken: "" };
      case "CreateTaskPushNotificationConfig": case "GetTaskPushNotificationConfig":
        return { id: CFG_ID, taskId: TASK_ID, url: "https://concierge.example.com/a2a/webhook" };
      case "ListTaskPushNotificationConfigs": return { configs: [{ id: CFG_ID, taskId: TASK_ID, url: "https://concierge.example.com/a2a/webhook" }], nextPageToken: "" };
      case "DeleteTaskPushNotificationConfig": return {};
      case "GetExtendedAgentCard": return { name: "Release Operations Agent", "…": "extended card" };
      default: return null;
    }
  }
  function restPath(def) {
    return def.rest.replace("{id}", TASK_ID).replace("{configId}", CFG_ID);
  }

  PG.lesson({
    id: "bindings",
    track: "infrastructure",
    title: "One protocol, three bindings",
    short: "Bindings & versions",
    thesis: "A2A defines operations once and maps them onto three wires: JSON-RPC, gRPC and HTTP+JSON. A version header on every request keeps clients and agents on the same semantics as the protocol evolves.",
    refs: "Spec §3.6 versioning · §5 bindings · §9 JSON-RPC · §10 gRPC · §11 HTTP+JSON · §5.4 errors",
    brief: `
      <h2>The three standard bindings</h2>
      <dl class="terms">
        <dt>JSONRPC</dt><dd>JSON-RPC 2.0, one URL, PascalCase methods (<code>SendMessage</code>, <code>GetTask</code>). Streams are <code>text/event-stream</code>. Errors are JSON-RPC error objects.</dd>
        <dt>GRPC</dt><dd>Service <code>lf.a2a.v1.A2AService</code> from <code>a2a.proto</code>. Server streaming for SendStreamingMessage and SubscribeToTask. Errors use gRPC status codes.</dd>
        <dt>HTTP+JSON</dt><dd>Resource-style URLs from the proto's HTTP annotations: <code>POST /message:send</code>, <code>GET /tasks/{id}</code>. Content-Type <code>application/a2a+json</code>; errors are <code>application/problem+json</code>. Every path also has a <code>/{tenant}/…</code> form.</dd>
      </dl>
      <h2>Service parameters travel as headers</h2>
      <p><code>A2A-Version</code> and <code>A2A-Extensions</code> are HTTP headers (gRPC metadata). Multiple values are comma-separated.</p>
      <h2>Versioning rules</h2>
      <ul>
        <li>Versions are <strong>Major.Minor</strong>; patch numbers don't affect compatibility and SHOULD NOT be sent.</li>
        <li>Clients MUST send <code>A2A-Version</code>. An empty value is interpreted as <strong>0.3</strong>, for older clients.</li>
        <li>Agents MUST use the semantics of the requested version, or return <code>VersionNotSupportedError</code> (-32009). They may serve several versions on different interfaces.</li>
        <li>SDKs should not silently fall back to an older version; that loses features without telling you.</li>
      </ul>`,
    lab: function (bench) {
      /* Lab A: operation × binding */
      const a = PG.lab(bench, "Same operation, three wires", "Lab · binding viewer");
      let op = "SendMessage", bind = "JSONRPC";
      const reqPre = h("pre", { class: "code" }), resPre = h("pre", { class: "code" });
      const note = h("div", { class: "small muted" });
      function paint() {
        const def = SPEC.methods.find(function (m) { return m.jsonrpc === op; });
        const params = paramsFor(op), result = resultFor(op);
        const auth = { Authorization: "Bearer eyJhbGciOi…" };
        note.innerHTML = PG.esc(def.what) + (def.note ? " <b>Note:</b> " + PG.esc(def.note) : "");
        if (bind === "JSONRPC") {
          reqPre.innerHTML = PG.httpHTML({ start: "POST /a2a/release HTTP/1.1", headers: Object.assign({ Host: "agents.example.com", "Content-Type": "application/json", "A2A-Version": "1.0" }, def.stream ? { Accept: "text/event-stream" } : {}, auth), body: SPEC.rpc(op, params) });
          resPre.innerHTML = def.stream
            ? PG.httpHTML({ start: "HTTP/1.1 200 OK", headers: { "Content-Type": "text/event-stream" }, sse: [{ jsonrpc: "2.0", id: 1, result: { task: SPEC.task(TASK_ID, "ctx-91c2", "WORKING") } }, { jsonrpc: "2.0", id: 1, result: SPEC.statusUpdate(TASK_ID, "ctx-91c2", "COMPLETED") }] })
            : PG.httpHTML({ start: "HTTP/1.1 200 OK", headers: { "Content-Type": "application/json" }, body: { jsonrpc: "2.0", id: 1, result: result } });
        } else if (bind === "HTTP+JSON") {
          const verb = def.rest.split(" ")[0];
          let path = restPath(def);
          let body;
          if (op === "GetTask") path += "?historyLength=10";
          if (op === "ListTasks") path += "?contextId=ctx-91c2&status=TASK_STATE_WORKING&pageSize=50";
          if (verb === "POST" && params) { body = Object.assign({}, params); delete body.id; if (op === "CreateTaskPushNotificationConfig") delete body.taskId; if (!Object.keys(body).length) body = undefined; }
          reqPre.innerHTML = PG.httpHTML({ start: path.replace(/^([A-Z]+) /, "$1 /a2a/release/rest").replace(/^([A-Z]+) \/a2a\/release\/rest\//, "$1 /a2a/release/rest/") + " HTTP/1.1",
            headers: Object.assign({ Host: "agents.example.com", "A2A-Version": "1.0" }, body ? { "Content-Type": "application/a2a+json" } : {}, def.stream ? { Accept: "text/event-stream" } : {}, auth), body: body });
          resPre.innerHTML = def.stream
            ? PG.httpHTML({ start: "HTTP/1.1 200 OK", headers: { "Content-Type": "text/event-stream" }, sse: [{ task: SPEC.task(TASK_ID, "ctx-91c2", "WORKING") }, SPEC.statusUpdate(TASK_ID, "ctx-91c2", "COMPLETED")] })
            : PG.httpHTML({ start: op === "DeleteTaskPushNotificationConfig" ? "HTTP/1.1 204 No Content" : "HTTP/1.1 200 OK", headers: { "Content-Type": "application/a2a+json" }, body: op === "DeleteTaskPushNotificationConfig" ? undefined : result });
        } else {
          const req = params ? "{\n" + Object.keys(params).map(function (k) { return "  " + k.replace(/[A-Z]/g, function (c) { return "_" + c.toLowerCase(); }) + ": " + (typeof params[k] === "object" ? "{ … }" : JSON.stringify(params[k])); }).join("\n") + "\n}" : "{}";
          reqPre.innerHTML = PG.esc(":method POST\n:path /lf.a2a.v1.A2AService/" + op + "\ncontent-type: application/grpc+proto\na2a-version: 1.0\nauthorization: Bearer eyJhbGciOi…\n\n# " + (op === "CreateTaskPushNotificationConfig" ? "TaskPushNotificationConfig" : op + "Request") + " (protobuf, shown as text)\n" + req);
          resPre.innerHTML = PG.esc(def.stream ? "# stream StreamResponse\n{ task { id: \"" + TASK_ID + "\" status { state: TASK_STATE_WORKING } } }\n{ status_update { task_id: \"" + TASK_ID + "\" status { state: TASK_STATE_COMPLETED } } }\n\ngrpc-status: 0 (OK)" : "# " + (op === "SendMessage" ? "SendMessageResponse" : op === "GetExtendedAgentCard" ? "AgentCard" : op === "DeleteTaskPushNotificationConfig" ? "google.protobuf.Empty" : "response") + "\n{ … }\n\ngrpc-status: 0 (OK)");
        }
      }
      a.body.append(
        h("div", { class: "row" }, PG.select("bind-op", SPEC.methods.map(function (m) { return { v: m.jsonrpc, label: m.op + " · " + m.jsonrpc }; }), op, function (v) { op = v; paint(); }),
          PG.seg([{ v: "JSONRPC", label: "JSON-RPC" }, { v: "GRPC", label: "gRPC" }, { v: "HTTP+JSON", label: "HTTP+JSON" }], bind, function (v) { bind = v; paint(); }, "Binding")),
        note, h("div", { class: "grid2" }, h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "Request" }), reqPre), h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "Response" }), resPre)),
        h("div", { class: "table-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Operation", "JSON-RPC / gRPC", "HTTP+JSON"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", {}, SPEC.methods.map(function (m) { return h("tr", {}, h("td", { text: m.op }), h("td", { class: "mono", text: m.jsonrpc }), h("td", { class: "mono", text: m.rest })); })))));
      paint();

      /* Lab B: version negotiation */
      const b = PG.lab(bench, "Version negotiation", "Lab · A2A-Version");
      let sent = "1.0", eb = "JSONRPC";
      const serves = { "0.3": true, "1.0": true };
      const out = PG.wire(b.body, { title: "Wire" });
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Client sends A2A-Version:" }),
          PG.seg([{ v: "", label: "(no header)" }, { v: "0.3", label: "0.3" }, { v: "1.0", label: "1.0" }, { v: "1.0.1", label: "1.0.1" }, { v: "2.0", label: "2.0" }], sent, function (v) { sent = v; }, "Version")),
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Agent serves:" }),
          PG.switch("serve-03", "0.3", true, function (v) { serves["0.3"] = v; }), PG.switch("serve-10", "1.0", true, function (v) { serves["1.0"] = v; }),
          PG.seg([{ v: "JSONRPC", label: "JSON-RPC error" }, { v: "HTTP+JSON", label: "HTTP+JSON error" }], eb, function (v) { eb = v; }, "Error binding")),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Send", onclick: function () {
          const headers = { Host: "agents.example.com", "Content-Type": "application/json" };
          if (sent) headers["A2A-Version"] = sent;
          out.add({ actor: "client", label: "SendMessage · A2A-Version: " + (sent || "(absent)"), http: { start: "POST /a2a/release HTTP/1.1", headers: headers }, body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Hello"]) }) });
          const mm = (sent || "0.3").split(".").slice(0, 2).join(".");
          const notes = [];
          if (!sent) notes.push("No header: the agent MUST treat the request as 0.3.");
          if (/^\d+\.\d+\.\d+$/.test(sent)) notes.push("A patch number was sent; only Major.Minor (" + mm + ") counts. Clients SHOULD NOT send patches.");
          const supported = Object.keys(serves).filter(function (k) { return serves[k]; });
          if (serves[mm]) {
            out.add({ kind: "in", actor: "server", label: "Processed with " + mm + " semantics", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(2), "ctx-" + PG.hex(2), "WORKING") } }, note: notes.join(" ") || undefined });
          } else if (eb === "JSONRPC") {
            out.add({ kind: "in", actor: "server", label: "VersionNotSupportedError", status: "-32009", http: SPEC.res(200), body: SPEC.rpcErr("VersionNotSupportedError", 1, "VERSION_NOT_SUPPORTED"), note: (notes.join(" ") + " The agent does not serve " + mm + ".").trim(), open: true });
          } else {
            out.add({ kind: "in", actor: "server", label: "400 problem+json · version-not-supported", status: "400", http: SPEC.res(400, { "Content-Type": "application/problem+json" }),
              body: { type: "https://a2a-protocol.org/errors/version-not-supported", title: "Protocol Version Not Supported", status: 400, detail: "The requested A2A protocol version " + mm + " is not supported by this agent", supportedVersions: supported }, open: true });
          }
        } }))), out.el);

      /* Lab C: error decoder */
      const c = PG.lab(bench, "Error decoder", "Lab · §5.4 mappings");
      const detail = h("div", { class: "result", text: "Pick an error to see when it happens." });
      const tb = h("tbody");
      SPEC.errors.forEach(function (e) {
        const tr = h("tr", { style: { cursor: "pointer" }, tabindex: "0" }, h("td", { class: "mono", text: e.name }), h("td", { class: "mono", text: String(e.code) }), h("td", { class: "mono", text: e.grpc }), h("td", { class: "mono", text: e.http }));
        function pick() { tb.querySelectorAll("tr").forEach(function (r) { r.classList.remove("sel"); }); tr.classList.add("sel"); detail.innerHTML = "<b>" + e.name + "</b>: " + PG.esc(e.when); }
        tr.addEventListener("click", pick);
        tr.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
        tb.appendChild(tr);
      });
      c.body.append(h("div", { class: "table-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["A2A error", "JSON-RPC", "gRPC", "HTTP"].map(function (x) { return h("th", { text: x }); }))), tb)), detail);
    },
    quiz: [
      { q: "What is the JSON-RPC method name for sending a streaming message in 1.0?",
        opts: ["<code>message/stream</code>", "<code>SendStreamingMessage</code>", "<code>tasks/stream</code>", "<code>stream_message</code>"],
        a: 1, why: "1.0 JSON-RPC uses PascalCase names matching gRPC. <code>message/stream</code> is the 0.3 name." },
      { q: "A request arrives with no A2A-Version header. Which version does the agent assume?",
        opts: ["The latest it supports", "0.3", "1.0", "It must reject the request"],
        a: 1, why: "Agents MUST interpret an empty value as 0.3, for compatibility with older clients." },
      { q: "Where does TaskNotFoundError land in each binding?",
        opts: ["-32001 / NOT_FOUND / 404", "-32004 / FAILED_PRECONDITION / 400", "-32602 / INVALID_ARGUMENT / 400", "-32001 / INTERNAL / 500"],
        a: 0, why: "Per §5.4: JSON-RPC -32001, gRPC NOT_FOUND, HTTP 404." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Proxies & gateways
   * ════════════════════════════════════════════════════════════════════ */
  const REQS = [
    { v: "send", method: "SendMessage", label: "SendMessage (deploy to prod)", params: { message: SPEC.msg("user", ["Deploy checkout-api 2.14.0 to production"]) }, newTask: true },
    { v: "stream", method: "SendStreamingMessage", label: "SendStreamingMessage", params: { message: SPEC.msg("user", ["Scan billing-worker"]) }, newTask: true },
    { v: "cancel", method: "CancelTask", label: "CancelTask task-42", params: { id: "task-42" } },
    { v: "ext", method: "GetExtendedAgentCard", label: "GetExtendedAgentCard" },
    { v: "list", method: "ListTasks", label: "ListTasks", params: { pageSize: 20 } },
  ];

  PG.lesson({
    id: "proxy",
    track: "infrastructure",
    title: "Proxies and gateways",
    short: "Proxies & gateways",
    thesis: "Between two agents there is usually a mesh, a proxy or a gateway. What each can see decides what it can enforce: a plain HTTP proxy sees one POST after another, while an A2A-aware gateway sees methods, tasks and agents.",
    refs: "Spec §7 · §8.3 · §13 · this repo: k8s-lab labs 40 (mesh), 50 (Envoy Gateway), 55 (OPA), 60 (agentgateway)",
    brief: `
      <h2>Three kinds of middlebox</h2>
      <dl class="terms">
        <dt>L4 mesh</dt><dd>e.g. Istio ambient ztunnel. Sees workload identity (mTLS certificates) and bytes. Can allow or deny who talks to whom. Never sees HTTP.</dd>
        <dt>HTTP proxy</dt><dd>e.g. Envoy Gateway. Sees method, path, headers. For JSON-RPC every call is <code>POST /a2a/…</code> with an opaque body, so it cannot tell <code>CancelTask</code> from <code>SendMessage</code>.</dd>
        <dt>A2A-aware gateway</dt><dd>e.g. agentgateway. Parses the A2A payload: method, task id, agent, extensions. Can route, rate-limit and authorize in A2A terms, and log A2A calls instead of POSTs.</dd>
      </dl>
      <h2>Things that break at a proxy</h2>
      <ul>
        <li><strong>Streams.</strong> SSE needs unbuffered responses and long or no idle timeouts. A 15-second idle timeout kills a quiet compliance scan; the client then needs <code>SubscribeToTask</code>.</li>
        <li><strong>Replicas.</strong> A resume can land on any replica. With an in-memory task store it gets <code>TaskNotFoundError</code>. Share the task store, or route by task id. For JSON-RPC the task id is in the body, so only an A2A-aware gateway can route on it.</li>
        <li><strong>The card.</strong> A card served through a gateway must advertise the gateway's URL in <code>supportedInterfaces</code>, or external clients will call an internal hostname. If the card is signed, the published card must be the one that was signed.</li>
        <li><strong>Identity.</strong> After the edge authenticates a caller, the upstream sees the gateway's identity (e.g. its mTLS cert). If the agent needs the end caller's identity, forward it deliberately: token exchange or a signed header, never an unsigned one.</li>
      </ul>
      <div class="note ours"><span class="note-label">In this repo</span>Lab 40 is the L4 mesh, lab 50 the HTTP proxy (it needed <code>externalTrafficPolicy: Cluster</code> and <code>timeouts.request: 0s</code>), lab 55 adds OPA at that proxy, and lab 60 swaps in agentgateway with <code>a2a: {}</code> on the route.</div>`,
    lab: function (bench, api) {
      /* Lab A: visibility + policy */
      const a = PG.lab(bench, "What each proxy sees, and what it can enforce", "Lab · gateway simulator");
      let mode = "a2a", role = "operator";
      const pol = { blockCancel: true, rate: true, extInternal: false };
      let newTasks = 0;
      const stage = PG.stage(a.body, {
        size: "short",
        actors: [
          { id: "client", role: "client", label: "Client agent", sub: "ops-concierge", x: 12, y: 42 },
          { id: "gw", role: "proxy", label: "A2A-aware gateway", sub: "agentgateway", x: 50, y: 42 },
          { id: "agent", role: "server", label: "Release agent", sub: "deployment-agent", x: 88, y: 42 },
        ],
        links: [["client", "gw"], ["gw", "agent"]],
      });
      const sees = h("dl", { class: "kv" });
      const log = h("pre", { class: "code wrap", style: { minHeight: "48px" } });
      const polBox = h("div", { class: "stack" });
      const wire = PG.wire(a.body, { title: "Wire" });
      const names = { l4: ["L4 mesh", "ztunnel"], http: ["HTTP proxy", "Envoy Gateway"], a2a: ["A2A-aware gateway", "agentgateway"] };
      function paintPolicies() {
        polBox.innerHTML = "";
        const can = mode === "a2a";
        [["blockCancel", "Block CancelTask for role=viewer"], ["rate", "Rate-limit new tasks: 3 per minute per caller"], ["extInternal", "Deny GetExtendedAgentCard to callers outside the org"]].forEach(function (p) {
          const sw = PG.switch("pol-" + p[0], p[1], pol[p[0]], function (v) { pol[p[0]] = v; });
          sw.input.disabled = !can;
          polBox.appendChild(sw);
        });
        polBox.appendChild(h("div", { class: "small " + (can ? "muted" : ""), style: can ? {} : { color: "var(--warn)" }, text: mode === "a2a"
          ? "The gateway parses the method and task, so these rules are expressible."
          : mode === "http" ? "Can't express these: every JSON-RPC call is POST /a2a/release with an opaque body. You'd need body inspection (ext_authz with the request body), which is brittle for streams."
          : "Only identity-level rules: may ops-concierge's workload talk to deployment-agent at all?" }));
        stage.set("gw", { label: names[mode][0] });
        stage.actors.gw.node.querySelector(".a-sub").textContent = names[mode][1];
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, PG.seg([{ v: "l4", label: "L4 mesh" }, { v: "http", label: "HTTP proxy" }, { v: "a2a", label: "A2A-aware gateway" }], mode, function (v) { mode = v; paintPolicies(); }, "Proxy type"),
          h("span", { class: "small muted", text: "Caller role:" }), PG.seg([{ v: "operator", label: "operator" }, { v: "viewer", label: "viewer" }], role, function (v) { role = v; }, "Role")),
        polBox,
        h("div", { class: "row" }, REQS.map(function (r) { return h("button", { class: "btn small client", type: "button", text: r.label, onclick: function () { fire(r); } }); }),
          h("button", { class: "btn small", type: "button", text: "Reset rate window", onclick: function () { newTasks = 0; PG.toast("Rate-limit window reset"); } }))), stage.el);
      a.body.insertBefore(h("div", { class: "grid2" }, h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "What the middlebox can see" }), sees), h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "Its access log line" }), log)), wire.el);
      paintPolicies();
      sees.append(h("dt", { text: "status" }), h("dd", { text: "idle: send a request above" }));
      log.textContent = "(no traffic yet)";

      async function fire(r) {
        const body = SPEC.rpc(r.method, r.params);
        const bytes = JSON.stringify(body).length;
        const jwt = PG.fakeJwt({ sub: "ops-concierge", role: role, org: "platform" });
        wire.add({ actor: "client", label: r.method, http: SPEC.post("/a2a/release", { Authorization: "Bearer " + jwt.slice(0, 20) + "…" }), body: body });
        sees.innerHTML = "";
        const S = mode === "l4"
          ? [["src identity", "spiffe://cluster.local/ns/agents/sa/ops-concierge"], ["dst", "deployment-agent.agents:8001"], ["protocol", "HBONE (mTLS)"], ["bytes", String(bytes)], ["HTTP method / path", "not visible"], ["A2A method", "not visible"]]
          : mode === "http"
            ? [["method", "POST"], ["path", "/a2a/release"], ["headers", "content-type, a2a-version, authorization"], ["body", bytes + " bytes, opaque"], ["A2A method", "not visible"], ["task id", "not visible"]]
            : [["a2a.method", r.method], ["a2a.task_id", (r.params && r.params.id) || (r.newTask ? "(new task)" : "—")], ["agent", "release"], ["caller", "ops-concierge (role=" + role + ")"], ["a2a-version", "1.0"], ["streaming", r.method.indexOf("Stream") >= 0 ? "yes (SSE, unbuffered)" : "no"]];
        S.forEach(function (kv) { sees.append(h("dt", { text: kv[0] }), h("dd", { text: kv[1] })); });

        let deny = null;
        if (mode === "a2a") {
          if (pol.blockCancel && r.method === "CancelTask" && role === "viewer") deny = [403, "policy: viewers may not cancel tasks"];
          else if (pol.rate && r.newTask && ++newTasks > 3) deny = [429, "rate limit: more than 3 new tasks per minute"];
          else if (pol.extInternal && r.method === "GetExtendedAgentCard") deny = [403, "policy: extended card is internal-only"];
        }
        const ms = 30 + Math.floor(Math.random() * 40);
        const status = deny ? deny[0] : 200;
        log.textContent = mode === "l4"
          ? "[ztunnel] src=spiffe://cluster.local/ns/agents/sa/ops-concierge dst=deployment-agent:8001 bytes=" + bytes + " dur=" + ms + "ms"
          : mode === "http" ? '[envoy] "POST /a2a/release HTTP/1.1" ' + status + " " + bytes + " " + ms + "ms"
          : "[agentgateway] a2a.method=" + r.method + " task=" + ((r.params && r.params.id) || "new") + " agent=release caller=ops-concierge role=" + role + " status=" + (deny ? "denied(" + deny[1] + ")" : "ok") + " " + ms + "ms";

        if (!(await stage.send("client", "gw", r.method))) return;
        if (deny) {
          wire.add({ kind: "in", actor: "proxy", label: "Gateway: " + deny[1], status: String(deny[0]), http: SPEC.res(deny[0], deny[0] === 429 ? { "Retry-After": "60" } : { "Content-Type": "application/json" }), body: { error: deny[1] }, open: true });
          await stage.send("gw", "client", String(deny[0]), { tone: "err" });
          return;
        }
        if (!(await stage.send("gw", "agent", mode === "l4" ? "bytes" : r.method))) return;
        await stage.send("agent", "gw", "200");
        wire.add({ kind: "in", actor: "server", label: "Agent handled " + r.method, status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: resultFor(r.method) || { task: SPEC.task("task-" + PG.hex(2), "ctx", "WORKING") } } });
        await stage.send("gw", "client", "200");
      }

      /* Lab B: timeouts & buffering */
      const b = PG.lab(bench, "Streams versus idle timeouts", "Lab · SSE through a proxy");
      const tcfg = { timeout: 15, buffer: false };
      const lane = h("div", { class: "lane-track", style: { height: "34px" } });
      const res = h("div", { class: "result", text: "A 40-second task that is silent between 5 s and 35 s, like a quiet compliance scan." });
      const bw = PG.wire(b.body, { title: "What the client receives" });
      const runB = h("button", { class: "btn primary", type: "button", text: "Run a 40 s streaming task" });
      b.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Proxy idle timeout:" }),
          PG.seg([{ v: 15, label: "15 s" }, { v: 60, label: "60 s" }, { v: 0, label: "off (0s)" }], tcfg.timeout, function (v) { tcfg.timeout = Number(v); }, "Idle timeout"),
          PG.switch("buffer", "Proxy buffers responses", tcfg.buffer, function (v) { tcfg.buffer = v; })),
        h("div", { class: "row" }, runB), lane, res), bw.el);
      runB.addEventListener("click", async function () {
        runB.disabled = true; bw.clear(); lane.innerHTML = "";
        const events = [[0, "task · WORKING"], [5, "statusUpdate · scan started"], [35, "statusUpdate · scan passed"], [40, "statusUpdate · COMPLETED"]];
        const cut = tcfg.timeout && 35 - 5 > tcfg.timeout ? 5 + tcfg.timeout : null;
        events.forEach(function (e) { lane.appendChild(h("div", { class: "tick", style: { left: (e[0] / 42) * 100 + "%", background: "var(--server)" } })); });
        if (cut) lane.appendChild(h("div", { class: "tick", style: { left: (cut / 42) * 100 + "%", background: "var(--err)", width: "4px" } }));
        const received = [];
        for (const e of events) {
          await PG.sleep(260);
          if (!api.alive()) return;
          if (cut && e[0] > cut) {
            if (!received.cutShown) {
              received.cutShown = true;
              bw.add({ kind: "note", actor: "proxy", label: "Proxy closed the idle stream at " + cut + " s (no bytes for " + tcfg.timeout + " s). The task is still running.", status: "cut", tone: "err" });
              bw.add({ actor: "client", label: "SubscribeToTask · re-attach", http: SPEC.post("/a2a/release", { Accept: "text/event-stream" }), body: SPEC.rpc("SubscribeToTask", { id: "task-scan" }) });
            }
          }
          if (tcfg.buffer) { received.push(e); continue; }
          bw.add({ kind: "evt", actor: "server", label: "t=" + e[0] + " s · " + e[1] + (cut && e[0] > cut ? " (after re-attach)" : "") });
        }
        if (tcfg.buffer) bw.add({ kind: "evt", actor: "proxy", label: "t=40 s · all " + received.length + " events arrive at once when the response ends", status: "buffered", tone: "warn" });
        res.className = "result " + (cut || tcfg.buffer ? "err" : "ok");
        res.innerHTML = tcfg.buffer ? "<b>Streaming is broken.</b> A buffering proxy turns SSE into one late response. Disable buffering for text/event-stream."
          : cut ? "<b>The proxy cut a healthy stream.</b> The client recovered with SubscribeToTask, but the fix is at the proxy: raise or disable the idle timeout for A2A routes (lab 50's HTTPRoute sets <code>timeouts.request: 0s</code>)."
          : "<b>Clean stream.</b> Every event arrived live, including after the 30-second silence.";
        runB.disabled = false;
      });

      /* Lab C: replicas */
      const c = PG.lab(bench, "Replicas and the task store", "Lab · resume lands where?");
      const rc = { store: "memory", route: "rr" };
      const rstage = PG.stage(c.body, {
        actors: [
          { id: "client", role: "client", label: "Client", x: 10, y: 45 },
          { id: "gw", role: "proxy", label: "Gateway", x: 40, y: 45 },
          { id: "ra", role: "server", label: "Replica A", sub: "deployment-agent-0", x: 76, y: 18 },
          { id: "rb", role: "server", label: "Replica B", sub: "deployment-agent-1", x: 76, y: 72 },
          { id: "db", role: "registry", label: "Shared task store", sub: "Postgres / Redis", x: 94, y: 45, glyph: "DB" },
        ],
        links: [["client", "gw"], ["gw", "ra"], ["gw", "rb"], ["ra", "db"], ["rb", "db"]],
      });
      const cres = h("div", { class: "result" });
      const cw = PG.wire(c.body, { title: "Wire" });
      const runC = h("button", { class: "btn primary", type: "button", text: "Start a task, then resume it" });
      function paintC() { rstage.set("db", { dim: rc.store !== "shared" }); }
      c.body.insertBefore(h("div", { class: "row" },
        PG.seg([{ v: "memory", label: "In-memory per replica" }, { v: "shared", label: "Shared task store" }], rc.store, function (v) { rc.store = v; paintC(); }, "Task store"),
        PG.seg([{ v: "rr", label: "Round-robin" }, { v: "affinity", label: "Route by taskId" }], rc.route, function (v) { rc.route = v; }, "Routing"), runC), rstage.el);
      c.body.insertBefore(cres, cw.el);
      paintC();
      runC.addEventListener("click", async function () {
        runC.disabled = true; cw.clear(); rstage.badge("ra", ""); rstage.badge("rb", "");
        cw.add({ actor: "client", label: "SendMessage · deploy to prod", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Deploy checkout-api to production"]) }) });
        if (!(await rstage.send("client", "gw", "SendMessage"))) return;
        if (!(await rstage.send("gw", "ra", "→ A"))) return;
        if (rc.store === "shared") await rstage.send("ra", "db", "save task-77");
        rstage.badge("ra", PG.stateChip("INPUT_REQUIRED"));
        cw.add({ kind: "in", actor: "server", label: "Replica A · task-77 INPUT_REQUIRED", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-77", "ctx-9", "INPUT_REQUIRED") } } });
        await rstage.send("ra", "client", "task-77");
        if (!api.alive()) return;
        await PG.sleep(400);
        cw.add({ actor: "client", label: "SendMessage · taskId=task-77 · “Approved”", http: SPEC.post("/a2a/release"), body: SPEC.rpc("SendMessage", { message: SPEC.msg("user", ["Approved"], { taskId: "task-77" }) }), hl: ["taskId"] });
        if (!(await rstage.send("client", "gw", "resume task-77"))) return;
        const target = rc.route === "affinity" ? "ra" : "rb";
        if (!(await rstage.send("gw", target, target === "ra" ? "→ A" : "→ B"))) return;
        if (target === "rb" && rc.store === "memory") {
          cw.add({ kind: "in", actor: "server", label: "Replica B has never heard of task-77", status: "-32001", http: SPEC.res(200), body: SPEC.rpcErr("TaskNotFoundError"), open: true });
          await rstage.send("rb", "client", "TaskNotFound", { tone: "err" });
          cres.className = "result err";
          cres.innerHTML = "<b>Resume failed.</b> The task lived in replica A's memory. Half of all resumes fail like this with two replicas.";
        } else {
          if (target === "rb") await rstage.send("rb", "db", "load task-77");
          rstage.badge(target, PG.stateChip("WORKING"));
          cw.add({ kind: "in", actor: "server", label: "Replica " + (target === "ra" ? "A" : "B") + " resumes task-77 · WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-77", "ctx-9", "WORKING") } } });
          await rstage.send(target, "client", "WORKING");
          cres.className = "result ok";
          cres.innerHTML = rc.store === "shared" ? "<b>Resumed.</b> Any replica can load the task from the shared store. This is the robust fix."
            : "<b>Resumed, fragile.</b> Routing by taskId sent it back to A. It breaks when A restarts or scales away, and for JSON-RPC the taskId is in the body, so only an A2A-aware gateway can route on it.";
        }
        runC.disabled = false;
      });

      /* Lab D: card through the gateway */
      const d = PG.lab(bench, "The card must name the gateway", "Lab · supportedInterfaces through a proxy");
      let rewrite = false;
      const dres = h("div", { class: "stack" });
      function paintD() {
        dres.innerHTML = "";
        const url = rewrite ? "https://agents.example.com/a2a/release" : "http://deployment-agent.agents.svc.cluster.local:8001/a2a/deployment_agent";
        const card = { name: "Release Operations Agent", supportedInterfaces: [{ url: url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }], "…": "rest of card" };
        dres.appendChild(h("pre", { class: "code", html: PG.jsonHTML(card, ["supportedInterfaces"]) }));
        dres.appendChild(h("div", { class: "result " + (rewrite ? "ok" : "err"), html: rewrite
          ? "An external client reads the card and calls <span class='mono'>agents.example.com</span>, which is the gateway. It works. If the card is signed, sign this public version; rewriting a signed card in flight breaks its signature."
          : "An external client reads the card and calls <span class='mono'>deployment-agent.agents.svc.cluster.local</span>, a name that only resolves inside the cluster. DNS fails. The agent is fine; its card is wrong for this audience." }));
      }
      d.body.append(PG.switch("rewrite-card", "Card advertises the gateway URL", rewrite, function (v) { rewrite = v; paintD(); }), dres);
      paintD();
    },
    quiz: [
      { q: "Why can't a plain HTTP proxy block CancelTask for some callers on a JSON-RPC agent?",
        opts: ["It can't read headers", "Every call is POST to the same path; the method is inside the JSON body", "CancelTask uses gRPC", "It can; CancelTask has its own path"],
        a: 1, why: "JSON-RPC puts the method in the body. An HTTP proxy sees POST /a2a/… for everything unless it inspects bodies." },
      { q: "Two replicas, in-memory task store, round-robin. What happens to resumes?",
        opts: ["All succeed", "About half fail with TaskNotFoundError", "All fail with 502", "They create duplicate tasks"],
        a: 1, why: "The task lives in one replica's memory. A resume routed to the other replica can't find it." },
      { q: "Your streaming tasks die after 15 s of silence behind the gateway. The best fix?",
        opts: ["Poll instead", "Raise or disable the proxy's idle timeout for A2A routes", "Make the task faster", "Turn on response buffering"],
        a: 1, why: "SSE streams outlive default proxy timeouts. Buffering makes it worse." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Extensions
   * ════════════════════════════════════════════════════════════════════ */
  const EXTS = [
    { uri: "https://example.com/extensions/geolocation/v1", description: "Location-aware requests", required: false },
    { uri: "https://standards.org/extensions/citations/v1", description: "Citation formatting and source verification", required: false },
    { uri: "https://platform.example.com/extensions/change-ticket/v1", description: "Every deploy must carry a change ticket id", required: false },
  ];
  PG.lesson({
    id: "extensions",
    track: "infrastructure",
    title: "Extensions",
    short: "Extensions",
    thesis: "Extensions add data or behavior without changing the core protocol. The agent declares them in its card, the client activates them per request, and extension data rides in metadata keyed by the extension's URI.",
    refs: "Spec §4.6 extensions · §3.2.6 service parameters · a2a.proto AgentExtension",
    brief: `
      <h2>Declare, activate, use</h2>
      <ol>
        <li><strong>Declare</strong> in <code>capabilities.extensions</code>: <code>uri</code>, <code>description</code>, <code>required</code>, optional <code>params</code>. The URI identifies the extension and its version.</li>
        <li><strong>Activate</strong> by listing URIs in the <code>A2A-Extensions</code> header (comma-separated). Messages and artifacts can also list the extensions they use in their <code>extensions</code> field.</li>
        <li><strong>Use</strong>: extension data goes in <code>metadata</code>, keyed by the URI, so different extensions never collide.</li>
      </ol>
      <h2>Rules</h2>
      <ul>
        <li>If the card marks an extension <code>required: true</code> and the client doesn't activate it, the agent MUST return <code>ExtensionSupportRequiredError</code> (-32008).</li>
        <li>If a client asks for a version the agent doesn't support, the agent SHOULD ignore it and continue, unless it is required, in which case it errors. It MUST NOT silently fall back to an older version.</li>
      </ul>
      <div class="note ours"><span class="note-label">In this repo</span>ADK pauses on long-running tools by sending a DataPart tagged <code>adk_type: function_call</code> and <code>adk_is_long_running: true</code>, and resumes on a function-response DataPart. That is effectively an extension. Declaring it in the card, with its own URI, would let non-ADK clients know about it.</div>
      <h2>A real one: agent payments (AP2)</h2>
      <p>Google's Agent Payments Protocol is built as an A2A extension, and shows what extensions are for: adding a whole domain without touching the core protocol. Its central idea is the <em>mandate</em>, a signed, verifiable statement of what a user authorised:</p>
      <dl class="terms">
        <dt>Intent mandate</dt><dd>What the user asked an agent to do, within limits (“buy these shoes, under $120, by Friday”). Lets an agent act when the user isn't watching.</dd>
        <dt>Cart mandate</dt><dd>The exact items and price the user (or their agent, within the intent) approved.</dd>
        <dt>Payment mandate</dt><dd>What goes to the payment network, so it can see an agent was involved and who authorised it.</dd>
      </dl>
      <p>Mandates travel as structured <code>data</code> parts; agents that speak the extension declare it in their card and activate it per request with <code>A2A-Extensions</code>. Notice the family resemblance to the <a href="#delegation">delegation lesson</a>: a verifiable record of <em>who authorised what, for whom</em>, carried across hops. Check the AP2 repository for the current extension URI and schemas before you build on it; the protocol is young.</p>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Negotiate extensions", "Lab · declare · activate · -32008");
      const req = { 0: false, 1: false, 2: true };
      const active = { 0: true, 1: false, 2: false };
      let geoVer = "v1";
      const cardPre = h("pre", { class: "code" });
      const w = PG.wire(a.body, { title: "Wire" });
      const rows = h("div", { class: "stack" });
      function card() {
        return { capabilities: { streaming: true, extensions: EXTS.map(function (e, i) { return Object.assign({}, e, { required: req[i] }); }) } };
      }
      function paint() {
        cardPre.innerHTML = PG.jsonHTML(card(), ["required"]);
        rows.innerHTML = "";
        EXTS.forEach(function (e, i) {
          rows.appendChild(h("div", { class: "row", style: { padding: "6px 8px", border: "1px solid var(--rule)", borderRadius: "4px" } },
            h("span", { class: "mono small", style: { flex: "1 1 260px" }, text: i === 0 ? e.uri.replace("/v1", "/" + geoVer) : e.uri }),
            PG.switch("ext-req-" + i, "required (card)", req[i], function (v) { req[i] = v; paint(); }),
            PG.switch("ext-act-" + i, "client activates", active[i], function (v) { active[i] = v; })));
        });
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" }, h("span", { class: "small muted", text: "Client's geolocation version:" }),
          PG.seg([{ v: "v1", label: "v1 (declared)" }, { v: "v2", label: "v2 (not declared)" }], geoVer, function (v) { geoVer = v; paint(); }, "Geolocation version")),
        rows,
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Send SendMessage", onclick: send })),
        h("div", { class: "grid2" }, h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "Agent Card (excerpt)" }), cardPre))), w.el);
      paint();
      function send() {
        const uris = EXTS.map(function (e, i) { return i === 0 ? e.uri.replace("/v1", "/" + geoVer) : e.uri; });
        const on = uris.filter(function (_, i) { return active[i]; });
        const msg = SPEC.msg("user", ["Deploy checkout-api 2.14.0 to production"], { extensions: on, metadata: {} });
        if (active[0]) msg.metadata[uris[0]] = { latitude: 59.9139, longitude: 10.7522 };
        if (active[2]) msg.metadata[uris[2]] = { ticket: "CHG-1234" };
        if (!Object.keys(msg.metadata).length) delete msg.metadata;
        if (!on.length) delete msg.extensions;
        const headers = on.length ? { "A2A-Extensions": on.join(",") } : {};
        w.add({ actor: "client", label: "SendMessage · A2A-Extensions: " + (on.length ? on.length + " active" : "none"), http: SPEC.post("/a2a/release", headers), body: SPEC.rpc("SendMessage", { message: msg }), hl: ["extensions", "metadata"] });
        const missing = EXTS.filter(function (e, i) { return req[i] && !(active[i] && (i !== 0 || geoVer === "v1")); });
        if (missing.length) {
          w.add({ kind: "in", actor: "server", label: "ExtensionSupportRequiredError · " + missing.map(function (e) { return e.uri.split("/").slice(-2).join("/"); }).join(", "), status: "-32008", http: SPEC.res(200), body: SPEC.rpcErr("ExtensionSupportRequiredError", 1, "REQUIRED_EXTENSION_NOT_ACTIVATED"), open: true,
            note: "The card marks these as required and the request did not activate a supported version of them." });
          return;
        }
        const notes = [];
        if (active[0] && geoVer === "v2") notes.push("geolocation/v2 isn't declared, so the agent ignores it (it's optional) and continues. It MUST NOT fall back to v1 silently.");
        w.add({ kind: "in", actor: "server", label: "Accepted · Task WORKING", status: "200", http: SPEC.res(200), body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-" + PG.hex(2), "ctx-" + PG.hex(2), "WORKING") } }, note: notes.join(" ") || undefined });
      }
    },
    quiz: [
      { q: "Where does a client put the list of extensions it activates?",
        opts: ["In the Agent Card", "In the A2A-Extensions header (and optionally message.extensions)", "In a query string", "In capabilities"],
        a: 1, why: "A2A-Extensions is a service parameter, sent as an HTTP header. Messages may also list the extensions they use." },
      { q: "An extension is <code>required: true</code> and the client didn't activate it. Result?",
        opts: ["The agent ignores it", "ExtensionSupportRequiredError (-32008)", "401 Unauthorized", "The agent activates it for the client"],
        a: 1, why: "Required extensions must be activated; otherwise the agent returns -32008." },
      { q: "How is extension data kept from colliding in metadata?",
        opts: ["Random prefixes", "It's keyed by the extension URI", "Only one extension may be active", "It goes in the Part text"],
        a: 1, why: "Metadata keys are the extension URIs, which are globally unique and versioned." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: A2A and MCP
   * ════════════════════════════════════════════════════════════════════ */
  const CASES = [
    { t: "The concierge asks the release agent to ship a version and wait for a human approval.", a: "A2A", why: "Two agents, a long-running task, a pause for input: A2A's core use." },
    { t: "The release agent reads CI status through a typed get_build(id) function.", a: "MCP", why: "A named, schema-typed tool call: MCP." },
    { t: "A travel agent negotiates with a hotel company's booking agent.", a: "A2A", why: "Independent, opaque agents owned by different parties." },
    { t: "An agent runs a SQL query against the incidents database.", a: "MCP", why: "Access to a resource or tool with a defined interface." },
    { t: "An ADK agent and a LangGraph agent collaborate on a report.", a: "A2A", why: "Cross-framework agent collaboration is exactly what A2A standardizes." },
    { t: "An agent calls a weather API wrapper with latitude and longitude.", a: "MCP", why: "A deterministic tool with typed parameters." },
    { t: "A client searches a registry for an agent that can convert currency.", a: "A2A", why: "Agent discovery through Agent Cards is part of A2A." },
    { t: "The model needs the contents of a file in a shared drive.", a: "MCP", why: "A resource fetch through a tool/resource server." },
  ];
  PG.lesson({
    id: "mcp",
    track: "infrastructure",
    title: "A2A and MCP",
    short: "A2A vs MCP",
    thesis: "MCP connects an agent to its tools and data. A2A connects an agent to other agents. They sit at different boundaries and a real system uses both.",
    refs: "Topic: a2a-and-mcp · Spec §1 principles",
    brief: `
      <h2>Different boundaries</h2>
      <dl class="terms">
        <dt>MCP</dt><dd>Agent ↔ tools and resources. Named functions with JSON schemas, mostly request/response, the caller in control.</dd>
        <dt>A2A</dt><dd>Agent ↔ agent. Opaque peers, natural-language messages, stateful tasks that run long, pause for input and stream results.</dd>
      </dl>
      <p>The spec's own analogy is an auto-repair shop. Customers talk to the shop's agent over A2A (“my car makes a noise”), a conversation with follow-up questions. The mechanics inside use their tools over MCP (“raise platform 2 by 2 meters”), precise commands with parameters.</p>
      <h2>How they combine</h2>
      <p>An A2A server is usually an agent that uses MCP tools internally. Its A2A <em>skills</em> describe outcomes; its MCP <em>tools</em> are how it gets there. Skills are advertised to other agents; tools stay inside the black box.</p>
      <div class="note ours"><span class="note-label">In this repo</span><code>check_release_readiness</code> and <code>run_compliance_scan</code> are tools inside <code>deployment_agent</code>. The concierge never names them; it sends a message over A2A. The OPA guard from lab 55 polices those tool calls, on the tool side of the line.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Which protocol fits?", "Lab · sort the scenarios");
      const grid = h("div", { class: "grid2" });
      const score = h("div", { class: "result", text: "Choose A2A or MCP for each scenario." });
      let right = 0, answered = 0;
      CASES.forEach(function (c) {
        const why = h("div", { class: "s-why", hidden: true });
        const card = h("div", { class: "sort-card" }, h("div", { class: "s-text", text: c.t }));
        const btns = h("div", { class: "row" });
        ["A2A", "MCP"].forEach(function (choice) {
          btns.appendChild(h("button", { class: "btn small " + (choice === "A2A" ? "client" : "server"), type: "button", text: choice, onclick: function () {
            if (card.dataset.done) return;
            card.dataset.done = "1"; answered++;
            const ok = choice === c.a;
            if (ok) right++;
            card.classList.add(ok ? "good" : "bad");
            why.hidden = false;
            why.textContent = (ok ? "Right. " : c.a + ". ") + c.why;
            score.textContent = right + " of " + answered + " right" + (answered === CASES.length ? ". Done." : "");
          } }));
        });
        card.append(btns, why);
        grid.appendChild(card);
      });
      a.body.append(grid, score);

      const b = PG.lab(bench, "Where each protocol sits", "Lab · layering");
      const st = PG.stage(b.body, {
        size: "tall",
        actors: [
          { id: "user", role: "user", label: "Engineer", x: 8, y: 50 },
          { id: "conc", role: "client", label: "ops_concierge", sub: "agent", x: 34, y: 50 },
          { id: "dep", role: "server", label: "deployment_agent", sub: "agent", x: 64, y: 50 },
          { id: "t1", role: "registry", label: "CI tool", sub: "MCP", x: 92, y: 16, glyph: "T" },
          { id: "t2", role: "registry", label: "Incidents DB", sub: "MCP", x: 92, y: 50, glyph: "T" },
          { id: "t3", role: "registry", label: "Deploy API", sub: "MCP", x: 92, y: 84, glyph: "T" },
        ],
        links: [["user", "conc"], ["conc", "dep"], ["dep", "t1"], ["dep", "t2"], ["dep", "t3"]],
      });
      const go = h("button", { class: "btn primary", type: "button", text: "Animate one request" });
      b.body.insertBefore(h("div", { class: "row" }, go), st.el);
      go.addEventListener("click", async function () {
        go.disabled = true;
        st.caption("A2A between agents: a message, a task.");
        if (await st.send("user", "conc", "“deploy it”") && await st.send("conc", "dep", "A2A SendMessage")) {
          st.caption("MCP inside the remote agent: precise, typed tool calls the concierge never sees.");
          await Promise.all([st.send("dep", "t1", "get_build()"), st.send("dep", "t2", "query()"), st.send("dep", "t3", "deploy()")]);
          st.caption("Then back over A2A as task updates.");
          await st.send("dep", "conc", "A2A Task update");
        }
        go.disabled = false;
      });
    },
    quiz: [
      { q: "An agent needs to call a function <code>get_build(id)</code> with a JSON schema. Which protocol?",
        opts: ["A2A", "MCP"], a: 1, why: "Typed, named tool calls are MCP's job." },
      { q: "Which statement is true?",
        opts: ["A2A skills and MCP tools are the same thing", "An A2A agent often uses MCP tools internally", "MCP replaces A2A for long-running work", "A2A requires MCP"],
        a: 1, why: "They work at different boundaries and combine naturally." },
    ],
  });
})();
