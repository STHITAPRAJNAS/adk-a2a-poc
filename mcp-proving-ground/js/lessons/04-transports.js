/* Track 4 — Transports & long work: Streamable HTTP, stdio, progress and
 * cancellation, subscriptions/listen. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Streamable HTTP
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "http",
    track: "transports",
    title: "Streamable HTTP: one POST per message, headers a proxy can read",
    short: "Streamable HTTP",
    thesis: "Each JSON-RPC message is its own POST to one endpoint. The answer is plain JSON or a short SSE stream. Required headers repeat the method, name and version from the body, so gateways can route without parsing JSON, and the server rejects any request where the two disagree.",
    refs: "Spec 2026-07-28 · Transports › Streamable HTTP · Tools §x-mcp-header (SEP-2243)",
    brief: `
      <h2>Requests and responses</h2>
      <ul>
        <li>One endpoint (e.g. <code>/mcp</code>). Every message is a new <code>POST</code> with <code>Accept: application/json, text/event-stream</code>.</li>
        <li>A notification gets <code>202 Accepted</code> with no body.</li>
        <li>A request gets either <code>application/json</code> (one response) or <code>text/event-stream</code>: request-related notifications (progress, log lines) and then the final response, which should end the stream. The server must not send its own requests on it.</li>
        <li>Closing that SSE stream <em>is</em> cancellation. There is no resume: a broken stream loses the request; the client sends it again with a new id.</li>
      </ul>
      <h2>Required headers</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Header</th><th>Copied from</th><th>On</th></tr></thead><tbody>
        <tr><td><code>MCP-Protocol-Version</code></td><td><code>_meta</code> protocolVersion</td><td>every POST</td></tr>
        <tr><td><code>Mcp-Method</code></td><td><code>method</code></td><td>every request</td></tr>
        <tr><td><code>Mcp-Name</code></td><td><code>params.name</code> or <code>params.uri</code></td><td>tools/call, resources/read, prompts/get</td></tr>
        <tr><td><code>Mcp-Param-{Name}</code></td><td>a tool argument marked <code>x-mcp-header</code></td><td>tools/call, when the argument is present</td></tr>
      </tbody></table></div>
      <p>Values that aren't plain printable ASCII (or have leading/trailing spaces) are sent as <code>=?base64?…?=</code>. A missing, malformed or mismatched header is <code>400</code> with <code>-32020</code> HeaderMismatch. An unknown method is <code>404</code> with <code>-32601</code>.</p>
      <div class="note trap"><span class="note-label">Why the mismatch check matters</span>If a load balancer routes on <code>Mcp-Name</code> while the server executes the body, a request with header <code>get_service_status</code> and body <code>rollback_release</code> could slip past a gateway policy. Servers that read the body MUST compare.</div>
      <div class="note spec"><span class="note-label">Spec · local servers</span>Validate <code>Origin</code> on every request (403 if present and wrong) to stop DNS rebinding; bind to 127.0.0.1, not 0.0.0.0; authenticate. Send <code>X-Accel-Buffering: no</code> on SSE so proxies don't buffer it, and keep long streams alive with comment lines (<code>:</code>).</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "A gateway that routes on headers", "Lab · Mcp-Method · Mcp-Name · Mcp-Param · -32020");
      let attack = "none";
      const stage = PG.stage(a.body, {
        actors: [
          { id: "client", role: "client", label: "MCP client", sub: "", x: 12, y: 50 },
          { id: "gw", role: "proxy", label: "Gateway", sub: "reads headers only", x: 44, y: 50 },
          { id: "eu", role: "server", label: "release-tools", sub: "eu-west1", x: 86, y: 18 },
          { id: "us", role: "server", label: "release-tools", sub: "us-east1", x: 86, y: 82 },
        ],
        links: [["client", "gw"], ["gw", "eu"], ["gw", "us"]],
      });
      const wire = PG.wire(a.body);
      const policy = h("div", { class: "result info", html: "Gateway policy: <code>rollback_release</code> is blocked for this caller. Route by <code>Mcp-Param-Region</code>." });
      const verdict = h("div", { class: "result", text: "Send a scale request, then try the two tampered ones." });
      const run = h("button", { class: "btn primary", type: "button", text: "Send" });
      a.body.insertBefore(h("div", { class: "stack" }, policy,
        h("div", { class: "row" }, PG.seg([{ v: "none", label: "Honest scale_service" }, { v: "name", label: "Header says status, body says rollback" }, { v: "region", label: "Header region ≠ body region" }, { v: "nohdr", label: "Header left out" }], "none", function (v) { attack = v; }, "Request"), run), verdict), stage.el);
      run.addEventListener("click", async function () {
        run.disabled = true;
        let body, headers, mname = "scale_service", region = "us-east1";
        if (attack === "name") {
          body = SPEC.rpc("tools/call", { name: "rollback_release", arguments: { service: "checkout-api", to_version: "2.10.0" } }, 1);
          headers = SPEC.post("tools/call", "get_service_status");
          mname = "get_service_status";
        } else {
          const args = { service: "cart-api", replicas: 8, region: "us-east1" };
          body = SPEC.rpc("tools/call", { name: "scale_service", arguments: args }, 1);
          headers = SPEC.post("tools/call", "scale_service", attack === "nohdr" ? null : { "Mcp-Param-Region": attack === "region" ? "eu-west1" : "us-east1" });
          if (attack === "region") region = "eu-west1";
          if (attack === "nohdr") region = null;
        }
        const target = region === "eu-west1" ? "eu" : "us";
        if (!(await stage.send("client", "gw", "POST /mcp"))) return;
        wire.add({ actor: "client", label: "POST tools/call · Mcp-Name: " + mname + (region ? " · Region: " + region : " · no Mcp-Param-Region"), http: headers, body: body, hl: ["name", "region"], open: true });
        await PG.sleep(300);
        if (mname === "rollback_release") { /* never: honest client */ }
        wire.add({ kind: "note", label: "Gateway sees Mcp-Method: tools/call, Mcp-Name: " + mname + " → policy allows" + (region ? "; Mcp-Param-Region: " + region + " → route to " + region : "; no region header → default route us-east1") });
        if (!(await stage.send("gw", target, "tools/call"))) return;
        if (attack === "none") {
          await stage.send(target, "gw", "200"); await stage.send("gw", "client", "200");
          wire.add({ kind: "in", actor: "server", label: "result · scaled in us-east1", status: "200", http: SPEC.res(200), body: SPEC.ok(1, PG.runTool("scale_service", { service: "cart-api", replicas: 8, region: "us-east1" })) });
          PG.setResult(verdict, "ok", "Headers and body agree. The gateway routed to us-east1 and applied its policy without parsing JSON.");
        } else {
          const msg = attack === "name" ? "Header mismatch: Mcp-Name header value 'get_service_status' does not match body value 'rollback_release'"
            : attack === "region" ? "Header mismatch: Mcp-Param-Region header value 'eu-west1' does not match body value 'us-east1'"
            : "Header mismatch: Mcp-Param-Region is required because arguments.region is present";
          await stage.send(target, "gw", "400 -32020", { tone: "err" }); await stage.send("gw", "client", "400", { tone: "err" });
          wire.add({ kind: "in", actor: "server", label: "400 · -32020 HeaderMismatch", status: "400", http: SPEC.res(400), body: SPEC.err(1, -32020, msg), open: true });
          PG.setResult(verdict, attack === "name" ? "ok" : "ok", attack === "name"
            ? "The gateway was fooled: it saw a harmless name and let the request through. The <b>server</b> compared header and body and refused. Without that check, the blocked rollback would have run."
            : attack === "region" ? "Routed to the wrong region by the header, then refused by the server because the body disagreed."
            : "The argument had an x-mcp-header but the client didn't mirror it. A conforming client always does; the server rejects the request.");
        }
        run.disabled = false;
      });

      const b = PG.lab(bench, "Header values: plain or base64", "Lab · value encoding");
      const vin = h("input", { class: "inline", id: "hv", value: "us-east1", style: { flex: "1 1 220px", fontFamily: "var(--font-mono)" }, "aria-label": "Value" });
      const vout = h("pre", { class: "code" });
      function enc() { vout.textContent = "Mcp-Param-Region: " + SPEC.headerValue(vin.value); }
      vin.addEventListener("input", enc);
      b.body.append(h("div", { class: "row" }, vin,
        ["us-east1", "Zürich", " padded ", "=?base64?x?="].map(function (v) { return h("button", { class: "btn small", type: "button", text: JSON.stringify(v), onclick: function () { vin.value = v; enc(); } }); })), vout,
        h("div", { class: "result info", html: "Plain visible ASCII passes as is. Non-ASCII, leading/trailing spaces, control characters, or anything that itself looks like <code>=?base64?…?=</code> is base64-encoded UTF-8, so a header can't smuggle a newline and the sentinel can't be faked." }));
      enc();

      const c = PG.lab(bench, "Notification, JSON, or stream", "Lab · 202 · application/json · text/event-stream");
      const cw = PG.wire(c.body, { title: "Wire" });
      c.body.insertBefore(h("div", { class: "row" },
        h("button", { class: "btn", type: "button", text: "Send a notification", onclick: function () {
          cw.add({ actor: "client", label: "POST notifications/cancelled", http: SPEC.post("notifications/cancelled"), body: SPEC.notif("notifications/cancelled", { requestId: 4, reason: "user pressed stop" }) });
          cw.add({ kind: "in", actor: "server", label: "202 Accepted, no body", status: "202", http: SPEC.res(202, "none") });
        } }),
        h("button", { class: "btn", type: "button", text: "Quick request → JSON", onclick: function () {
          cw.add({ actor: "client", label: "POST tools/call get_service_status", http: SPEC.post("tools/call", "get_service_status"), body: SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "cart-api" } }, 5) });
          cw.add({ kind: "in", actor: "server", label: "200 application/json", status: "200", http: SPEC.res(200), body: SPEC.ok(5, PG.runTool("get_service_status", { service: "cart-api" })) });
        } }),
        h("button", { class: "btn", type: "button", text: "Slow request → SSE", onclick: function () {
          cw.add({ actor: "client", label: "POST tools/call check_release_readiness (progressToken)", http: SPEC.post("tools/call", "check_release_readiness"), body: SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, 6, { progress: "p-6" }) });
          cw.add({ kind: "in", actor: "server", label: "200 text/event-stream: progress, progress, result", status: "200", http: SPEC.res(200, "sse"), sse: [
            SPEC.notif("notifications/progress", { progressToken: "p-6", progress: 1, total: 3, message: "CI status" }),
            SPEC.notif("notifications/progress", { progressToken: "p-6", progress: 2, total: 3, message: "changelog" }),
            SPEC.ok(6, PG.runTool("check_release_readiness", { service: "checkout-api", version: "2.14.0" })),
          ] });
        } }),
        h("button", { class: "btn", type: "button", text: "Unknown method", onclick: function () {
          cw.add({ actor: "client", label: "POST tasks/list", http: SPEC.post("tasks/list"), body: SPEC.rpc("tasks/list", {}, 7) });
          cw.add({ kind: "in", actor: "server", label: "404 · -32601", status: "404", http: SPEC.res(404), body: SPEC.err(7, -32601, "Method not found: tasks/list") });
        } })), cw.el);
    },
    quiz: [
      { q: "The client POSTs a JSON-RPC notification. What does the server return?",
        opts: ["200 with an empty result", "202 Accepted with no body", "204", "An SSE stream"],
        a: 1, why: "Notifications get 202 Accepted and no body." },
      { q: "Mcp-Name says get_service_status; params.name says rollback_release. What should the server do?",
        opts: ["Run rollback_release: the body wins", "Run get_service_status: the header wins", "Reject with 400 and -32020 HeaderMismatch", "Run both"],
        a: 2, why: "Servers MUST reject header/body mismatches so intermediaries and the server can't disagree about what's being called." },
      { q: "A tool argument is marked <code>\"x-mcp-header\": \"Region\"</code>. What must a conforming HTTP client do?",
        opts: ["Nothing", "Add Mcp-Param-Region with the argument's value whenever the argument is present", "Put the region in the URL", "Use the header instead of the body"],
        a: 1, why: "The value is mirrored into Mcp-Param-Region, in addition to the body." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: stdio
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "stdio",
    track: "transports",
    title: "stdio: a local process, one line per message",
    short: "stdio",
    thesis: "For a local server the client starts a process and writes one JSON-RPC message per line to its stdin; the server answers on stdout. Logs go to stderr. Credentials come from the environment, not OAuth.",
    refs: "Spec 2026-07-28 · Transports › stdio · Authorization (stdio note) · Cancellation",
    brief: `
      <h2>The rules</h2>
      <ul>
        <li>The client launches the server as a subprocess. Messages are UTF-8 JSON-RPC, <strong>one per line</strong>, no embedded newlines.</li>
        <li>The server writes <strong>only</strong> MCP messages to stdout. Anything else (debug prints, banners) breaks the client's parser. Logs go to <strong>stderr</strong>, which the client may show or ignore.</li>
        <li>All requests, results and notifications share these two pipes, so ids and <code>io.modelcontextprotocol/subscriptionId</code> are how the client tells them apart.</li>
        <li>Cancel a request with <code>notifications/cancelled {requestId, reason}</code>: on stdio the client MUST, since there is no stream to close.</li>
        <li>Shutting down: close stdin, wait; then SIGTERM; then SIGKILL.</li>
      </ul>
      <div class="note spec"><span class="note-label">Spec · credentials</span>stdio servers SHOULD NOT use the OAuth flow; they take credentials from the environment the client starts them with (for example a <code>DEPLOY_API_TOKEN</code> variable set by the user's configuration).</div>
      <div class="note"><span class="note-label">Era probe</span>stdio has no status codes, so a client that also supports legacy servers sends <code>server/discover</code> first (lesson 4).</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Watch the pipes", "Lab · stdin · stdout · stderr");
      let noisy = false;
      const cols = h("div", { class: "grid2" });
      const stdin = h("pre", { class: "code", style: { minHeight: "120px" } });
      const stdout = h("pre", { class: "code", style: { minHeight: "120px" } });
      const stderr = h("pre", { class: "code", style: { minHeight: "50px" } });
      cols.append(h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "client → stdin" }), stdin), h("div", { class: "stack" }, h("p", { class: "eyebrow", text: "stdout → client" }), stdout));
      const parsed = h("div", { class: "result", text: "Start the server and send a call." });
      const procState = h("span", { class: "chip mono", text: "not running" });
      function line(el, s, cls) { el.innerHTML += (cls ? "<span class='" + cls + "'>" : "") + PG.esc(s) + (cls ? "</span>" : "") + "\n"; }
      async function start() {
        stdin.innerHTML = stdout.innerHTML = stderr.innerHTML = "";
        procState.textContent = "running · pid 48211";
        line(stderr, "$ DEPLOY_API_TOKEN=(from your config) release-tools --stdio");
        line(stderr, "release-tools 1.4.0 starting (log to stderr)");
        if (noisy) line(stdout, "Starting release-tools v1.4.0...", "j-hl");
        const d = JSON.stringify(SPEC.rpc("server/discover", {}, 1));
        line(stdin, d);
        await PG.sleep(400);
        if (!api.alive()) return;
        line(stdout, JSON.stringify(SPEC.ok(1, { supportedVersions: [SPEC.V], capabilities: { tools: {} }, ttlMs: 3600000, cacheScope: "public" })));
        if (noisy) PG.setResult(parsed, "err", "<b>Parse error on the client.</b> The first line on stdout, <code>Starting release-tools…</code>, isn't JSON. Depending on the client this drops the message, fails the probe (so the server looks legacy) or kills the connection. Print banners to stderr.");
        else PG.setResult(parsed, "ok", "Every stdout line is one JSON-RPC message. The banner went to stderr where it belongs.");
      }
      async function call() {
        const r = JSON.stringify(SPEC.rpc("tools/call", { name: "get_service_status", arguments: { service: "cart-api" } }, 2));
        line(stdin, r);
        await PG.sleep(400);
        if (!api.alive()) return;
        line(stderr, "get_service_status cart-api 12ms");
        line(stdout, JSON.stringify(SPEC.ok(2, PG.runTool("get_service_status", { service: "cart-api" }))));
      }
      async function cancel() {
        line(stdin, JSON.stringify(SPEC.rpc("tools/call", { name: "check_release_readiness", arguments: { service: "checkout-api", version: "2.14.0" } }, 3)));
        await PG.sleep(300);
        line(stdin, JSON.stringify(SPEC.notif("notifications/cancelled", { requestId: 3, reason: "user pressed stop" })));
        line(stderr, "request 3 cancelled; stopping");
        PG.setResult(parsed, "info", "On stdio, cancellation is a notification naming the request id. The server SHOULD stop and not answer request 3. If its answer was already in the pipe, the client ignores it.");
      }
      async function stop() {
        line(stderr, "client: closing stdin");
        await PG.sleep(400);
        line(stderr, "release-tools: stdin closed, exiting 0");
        procState.textContent = "exited 0";
        PG.setResult(parsed, "info", "Polite shutdown: close stdin and wait. Only if it doesn't exit: SIGTERM, then SIGKILL.");
      }
      a.body.append(h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", text: "Start server", onclick: start }),
        h("button", { class: "btn", type: "button", text: "Send tools/call", onclick: call }),
        h("button", { class: "btn", type: "button", text: "Call, then cancel", onclick: cancel }),
        h("button", { class: "btn", type: "button", text: "Shut down", onclick: stop }), procState),
        PG.switch("stdio-noisy", "Server prints a banner to stdout", false, function (v) { noisy = v; }),
        cols, h("p", { class: "eyebrow", text: "stderr (logs)" }), stderr, parsed);
    },
    quiz: [
      { q: "Where should a stdio server write its debug logs?",
        opts: ["stdout, prefixed with #", "stderr", "notifications/message, always", "A resource"],
        a: 1, why: "stdout carries only MCP messages; logs go to stderr." },
      { q: "How does a client cancel request 7 on stdio?",
        opts: ["Close stdin", "Send notifications/cancelled with requestId 7", "Send SIGINT", "Send request 7 again"],
        a: 1, why: "There's no per-request stream to close, so cancellation is an explicit notification." },
      { q: "How does a stdio server usually get its credentials?",
        opts: ["Full OAuth flow with PKCE", "From the environment the client launches it with", "From the user via form elicitation", "From clientInfo"],
        a: 1, why: "stdio SHOULD NOT use the OAuth flow; it reads credentials from its environment." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Progress, cancellation, timeouts
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "progress",
    track: "transports",
    title: "Progress, cancellation and timeouts",
    short: "Progress & cancel",
    thesis: "A client that wants progress puts a progressToken in the request's _meta; the server sends notifications/progress on that request's stream. The client can cancel at any time. A dropped stream loses the request, and the client retries it as a new request.",
    refs: "Spec 2026-07-28 · Patterns › Progress · Cancellation · Streamable HTTP §cancellation · Changelog item 9",
    brief: `
      <h2>Progress</h2>
      <p>Add <code>progressToken</code> (string or integer, unique among your active requests) to <code>params._meta</code>. The server MAY send <code>notifications/progress {progressToken, progress, total?, message?}</code>. <code>progress</code> MUST go up every time, even when <code>total</code> is unknown. Progress stops when the final result arrives.</p>
      <h2>Cancellation</h2>
      <ul>
        <li><strong>HTTP</strong>: close the request's SSE stream (or abort the POST). That's unambiguous.</li>
        <li><strong>stdio</strong>: <code>notifications/cancelled {requestId, reason}</code>.</li>
        <li>It's fire-and-forget and races are normal: the result may already be on its way. The server SHOULD stop work and free resources; on HTTP it MUST NOT send anything more for that request. The client ignores a response that arrives anyway.</li>
        <li>A server never cancels a client's request. The only thing it may cancel is a <code>subscriptions/listen</code> it is tearing down.</li>
      </ul>
      <h2>Timeouts</h2>
      <p>Clients SHOULD set a timeout on every request and cancel when it fires. Progress MAY reset the timer, but there SHOULD still be a maximum, or a server that reports "1%… 1%… 1%" can hold a request open forever.</p>
      <div class="note trap"><span class="note-label">No resume</span><code>Last-Event-ID</code> and SSE event ids are gone. If a stream breaks, the request is lost; the client sends it again with a new id. That's why tools that change things should be idempotent, or take an idempotency key.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "A slow compliance scan", "Lab · progressToken · stop · drop · timeout");
      let resetOnProgress = true, stalls = false;
      const bar = h("i");
      const meter = h("div", { class: "meter", style: { height: "10px" } }, bar);
      const label = h("div", { class: "small mono", text: "idle" });
      const wire = PG.wire(a.body);
      const verdict = h("div", { class: "result", text: "Start the scan, then stop it, drop the connection, or let it run." });
      let running = null, rid = 10;
      async function startScan(retryOf) {
        if (running) return;
        rid++;
        const my = { id: rid, stopped: false, dropped: false };
        running = my;
        const tok = "scan-" + rid;
        bar.style.width = "0";
        wire.add({ actor: "client", label: "tools/call run_compliance_scan · id " + rid + (retryOf ? " (re-issued after drop; new id)" : "") + " · progressToken " + tok,
          http: SPEC.post("tools/call", "run_compliance_scan"), body: SPEC.rpc("tools/call", { name: "run_compliance_scan", arguments: { service: "checkout-api", version: "2.14.0", idempotency_key: "scan-checkout-2.14.0" } }, rid, { progress: tok }), hl: ["progressToken", "idempotency_key"] });
        let sinceProgress = 0, total = 0;
        const steps = stalls ? [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : [10, 25, 40, 55, 70, 85, 100];
        for (let i = 0; i < steps.length; i++) {
          for (let t = 0; t < 4; t++) {
            await PG.sleep(150);
            if (!api.alive()) return;
            if (my.stopped || my.dropped) break;
            sinceProgress += 150; total += 150;
            if (!resetOnProgress && total > 5000) { cancel(my, "timeout"); break; }
            if (total > 7000) { cancel(my, "max"); break; }
          }
          if (my.stopped || my.dropped) break;
          const p = steps[i];
          bar.style.width = p + "%";
          label.textContent = "progress " + p + " / 100";
          wire.add({ kind: "evt", actor: "server", label: "notifications/progress " + p + "/100", sse: [SPEC.notif("notifications/progress", { progressToken: tok, progress: p, total: 100, message: "control " + (i + 1) })] });
          sinceProgress = 0;
        }
        if (my.dropped) {
          running = null;
          PG.setResult(verdict, "warn", "The connection broke. The request is gone: there is no resume in 2026-07-28. Re-issue it as a new request with a new id. Because the scan takes an idempotency key, the server can recognise the repeat instead of starting a second scan.");
          await PG.sleep(600);
          if (!api.alive()) return;
          return startScan(true);
        }
        if (my.stopped) { running = null; return; }
        wire.add({ kind: "in", actor: "server", label: "result · 3/3 controls passed (stream ends)", status: "200", body: SPEC.ok(my.id, { content: [{ type: "text", text: "3/3 controls passed" }], structuredContent: { passed: 3, failed: 0 }, isError: false }) });
        PG.setResult(verdict, "ok", "Finished. Progress went up every time and stopped with the result.");
        running = null;
      }
      function cancel(my, why) {
        my.stopped = true;
        wire.add({ kind: "note", label: why === "user" ? "Client closes the SSE stream: that IS the cancel on HTTP. (On stdio: notifications/cancelled {requestId: " + my.id + "}.)"
          : why === "timeout" ? "Client timeout: 5 s with no regard for progress. Cancelled."
          : "Maximum total time reached (7 s) even though progress kept arriving. Cancelled." });
        PG.setResult(verdict, why === "user" ? "info" : "warn", why === "user"
          ? "Stopped. The server SHOULD stop work and, on HTTP, MUST NOT send anything more for request " + my.id + ". If a result was already in flight, the client ignores it."
          : why === "timeout" ? "Timed out. With a fixed timeout and no progress reset, a slow but healthy scan gets cut off; consider resetting on progress."
          : "Progress kept resetting the timer, but the server only ever reported tiny steps. The hard maximum stopped it. Always keep one.");
        running = null;
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Start scan", onclick: function () { startScan(false); } }),
          h("button", { class: "btn", type: "button", text: "Stop (user)", onclick: function () { if (running) cancel(running, "user"); } }),
          h("button", { class: "btn", type: "button", text: "Drop the connection", onclick: function () { if (running) running.dropped = true; } })),
        h("div", { class: "row" },
          PG.switch("pr-reset", "Progress resets the timeout", true, function (v) { resetOnProgress = v; }),
          PG.switch("pr-stall", "Server reports tiny steps forever", false, function (v) { stalls = v; })),
        meter, label, verdict), wire.el);
    },
    quiz: [
      { q: "How does a client ask for progress updates?",
        opts: ["Call progress/subscribe", "Put a progressToken in the request's _meta", "Set logLevel to debug", "Open subscriptions/listen"],
        a: 1, why: "progressToken in _meta; the server sends notifications/progress for that request on its own response stream." },
      { q: "The SSE stream of a tools/call breaks halfway. What now?",
        opts: ["Reconnect with Last-Event-ID", "The request is lost; re-issue it as a new request with a new id", "Wait for the server to push the result later", "Call tasks/result"],
        a: 1, why: "Resumability was removed in 2026-07-28." },
      { q: "Why keep a maximum timeout even when progress resets the timer?",
        opts: ["Progress notifications are unreliable", "A server reporting endless small progress could otherwise hold the request forever", "The spec forbids long requests", "To save bandwidth"],
        a: 1, why: "Resetting on progress is allowed, but a hard cap protects the client." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Tasks (the io.modelcontextprotocol/tasks extension)
   * ════════════════════════════════════════════════════════════════════ */
  const TASKS_EXT = "io.modelcontextprotocol/tasks";
  PG.lesson({
    id: "tasks",
    track: "transports",
    title: "Tasks: hand back a ticket, let the client poll",
    short: "Tasks extension",
    thesis: "For work that takes minutes or hours, a server can answer tools/call with a task handle (resultType \"task\") instead of a result. The client polls tasks/get, answers questions with tasks/update, and can cancel with tasks/cancel. In 2026-07-28 this is an official extension, not part of the core protocol.",
    refs: "MCP extension io.modelcontextprotocol/tasks (SEP-2663, final; modelcontextprotocol/ext-tasks) · Changelog 2026-07-28 item 6 · 2025-11-25 Tasks (experimental)",
    brief: `
      <h2>Where tasks live now</h2>
      <p>2025-11-25 added tasks as an <em>experimental</em> core feature. 2026-07-28 moved them out of the core into the official extension <code>io.modelcontextprotocol/tasks</code> and redesigned them. The two are <strong>not wire-compatible</strong>. Like every extension, both sides opt in through <code>capabilities.extensions</code>: the client in each request's <code>clientCapabilities</code>, the server in <code>server/discover</code>.</p>
      <h2>How it works</h2>
      <ol>
        <li>The client sends <code>tools/call</code> as usual, declaring the extension. (Only <code>tools/call</code> supports tasks so far.)</li>
        <li>The <strong>server decides</strong>, per request, whether to answer normally or with a <code>CreateTaskResult</code>: <code>resultType: "task"</code>, a <code>taskId</code>, <code>status</code>, <code>createdAt</code>, <code>lastUpdatedAt</code>, <code>ttlMs</code>, <code>pollIntervalMs</code>. The task must already exist durably when that answer is sent.</li>
        <li>The client polls <code>tasks/get {taskId}</code> no faster than <code>pollIntervalMs</code>.</li>
        <li>Status <code>input_required</code> comes with <code>inputRequests</code> (same shapes as MRTR). The client answers with <code>tasks/update {taskId, inputResponses}</code>, which returns an empty acknowledgement, and keeps polling.</li>
        <li>Terminal states: <code>completed</code> with <code>result</code> (exactly what <code>tools/call</code> would have returned, even if <code>isError: true</code>), <code>failed</code> with a JSON-RPC <code>error</code>, or <code>cancelled</code>.</li>
      </ol>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Method</th><th>Answer</th><th>Notes</th></tr></thead><tbody>
        <tr><td><code>tasks/get</code></td><td>the task, with <code>inputRequests</code>, <code>result</code> or <code>error</code> by status</td><td>a pure read: safe to retry or cache</td></tr>
        <tr><td><code>tasks/update</code></td><td>empty ack</td><td>eventually consistent; unknown or already-answered keys are ignored</td></tr>
        <tr><td><code>tasks/cancel</code></td><td>empty ack</td><td>cooperative: the task may still end <code>completed</code>. Never <code>notifications/cancelled</code> for tasks</td></tr>
        <tr><td><code>notifications/tasks</code></td><td>the full task state</td><td>optional push, via <code>subscriptions/listen</code> with <code>notifications.taskIds</code></td></tr>
      </tbody></table></div>
      <div class="note spec"><span class="note-label">Rules worth remembering</span>Never return a task to a client that didn't declare the extension on <em>that</em> request; if the server can't do the work without one, it answers <code>-32021</code> naming the extension. Unknown or expired <code>taskId</code>: <code>-32602</code>. Over HTTP, task requests carry <code>Mcp-Name: &lt;taskId&gt;</code> so a load balancer can route them to the instance holding the task. Clients should store task ids durably so they can resume polling after a restart.</div>
      <div class="note"><span class="note-label">Tasks and MRTR together</span>A tool can first ask questions with <code>input_required</code> (MRTR) and only then hand back a task. The two keep separate <code>inputRequests</code> keys.</div>
      <div class="note"><span class="note-label">What changed from 2025-11-25</span>The client no longer asks for a task (the <code>task</code> parameter on <code>tools/call</code> and tools' <code>execution.taskSupport</code> are gone); the server decides. <code>tasks/result</code> (blocking) and <code>tasks/list</code> are removed; <code>tasks/update</code> is new; <code>tasks/cancel</code> is now a plain acknowledgement.</div>
      <div class="note ours"><span class="note-label">Same idea in A2A</span>An A2A <code>Task</code> plays the same role between agents: an id, states including <code>INPUT_REQUIRED</code>, and <code>GetTask</code> to poll. If you know one, you know most of the other.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "A 40-minute compliance scan", "Lab · CreateTaskResult · tasks/get · tasks/update · tasks/cancel");
      let declared = true, cancelLate = false;
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "user", label: "You", sub: "", x: 12, y: 18 },
          { id: "client", role: "client", label: "MCP client", sub: "task ids on disk", x: 14, y: 76 },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 56, y: 50 },
          { id: "db", role: "registry", label: "Task store", sub: "", x: 88, y: 50, glyph: "D" },
        ],
        links: [["user", "client"], ["client", "server"], ["server", "db"]],
      });
      const wire = PG.wire(a.body);
      const chip = h("span", { class: "chip mono", text: "no task" });
      const verdict = h("div", { class: "result", text: "Start the scan, then poll it." });
      let task = null, id = 0, polls = 0, crashed = false;
      const startBtn = h("button", { class: "btn primary", type: "button", text: "tools/call run_compliance_scan" });
      const pollBtn = h("button", { class: "btn", type: "button", text: "tasks/get" });
      const cancelBtn = h("button", { class: "btn", type: "button", text: "tasks/cancel" });
      const crashBtn = h("button", { class: "btn", type: "button", text: "Restart the client" });
      const answer = h("div", { class: "stack" });
      function now(offsetMin) { return new Date(Date.UTC(2026, 9, 15, 9, offsetMin || 0, 0)).toISOString().replace(".000", ""); }
      function taskView(extra) {
        return Object.assign({ taskId: task.id, status: task.status, statusMessage: task.msg, createdAt: now(0), lastUpdatedAt: now(task.min), ttlMs: 7200000, pollIntervalMs: 30000 }, extra || {});
      }
      function paint() { chip.textContent = task ? task.id.slice(0, 13) + "… · " + task.status : "no task"; chip.className = "chip mono " + (!task ? "" : task.status === "completed" ? "ok" : task.status === "input_required" ? "warn" : task.status === "cancelled" || task.status === "failed" ? "err" : "info"); }
      async function start() {
        wire.clear(); answer.innerHTML = ""; polls = 0; task = null; paint();
        id++;
        const caps = declared ? { extensions: (function () { const e = {}; e[TASKS_EXT] = {}; return e; })() } : {};
        const args = { service: "checkout-api", version: "2.14.0" };
        if (!(await stage.send("client", "server", "tools/call"))) return;
        wire.add({ actor: "client", label: "tools/call run_compliance_scan · caps " + (declared ? "with tasks extension" : "without it"), http: SPEC.post("tools/call", "run_compliance_scan"), body: SPEC.rpc("tools/call", { name: "run_compliance_scan", arguments: args }, id, { caps: caps }), hl: [SPEC.K.caps] });
        if (!declared) {
          await stage.send("server", "client", "-32021", { tone: "err" });
          const req = { extensions: {} }; req.extensions[TASKS_EXT] = {};
          wire.add({ kind: "in", actor: "server", label: "-32021 · needs " + TASKS_EXT, status: "-32021", http: SPEC.res(400), body: SPEC.err(id, -32021, "Missing required client capability", { requiredCapabilities: req }), open: true });
          PG.setResult(verdict, "warn", "The scan takes 40 minutes, far longer than any connection should stay open, and this client can't take a task. A server that can't do the job without one says which extension it needs. (A server that could finish quickly would simply answer normally.)");
          return;
        }
        await stage.send("server", "db", "store task");
        await stage.send("db", "server", "stored");
        task = { id: PG.uuid(), status: "working", msg: "Scan queued", min: 0, step: 0, cancelReq: false };
        await stage.send("server", "client", "resultType: task", { tone: "server" });
        stage.badge("client", "taskId saved");
        wire.add({ kind: "in", actor: "server", label: "CreateTaskResult · " + task.id.slice(0, 8) + "… · working", status: "200", http: SPEC.res(200), body: SPEC.ok(id, Object.assign({ resultType: "task" }, taskView())), hl: ["resultType", "taskId", "pollIntervalMs"], open: true,
          note: "Not the scan result: a ticket. The server wrote the task to its store <b>before</b> answering, so a tasks/get for this id already works." });
        paint();
        PG.setResult(verdict, "info", "The connection is closed and nothing is held open. Press <b>tasks/get</b> to check on it (a real client waits <code>pollIntervalMs</code>, 30 s, between polls).");
      }
      async function poll() {
        if (!task) return PG.toast("Start the scan first");
        if (crashed) { crashed = false; stage.badge("client", "taskId read from disk"); }
        id++; polls++;
        if (!(await stage.send("client", "server", "tasks/get"))) return;
        wire.add({ actor: "client", label: "tasks/get " + task.id.slice(0, 8) + "…", http: SPEC.post("tasks/get", task.id), body: SPEC.rpc("tasks/get", { taskId: task.id }, id), hl: ["taskId"] });
        await stage.send("server", "db", "read");
        await stage.send("db", "server", task.status);
        /* advance the simulated job between polls */
        if (task.status === "working") {
          task.step++; task.min += 10;
          if (task.cancelReq) {
            if (cancelLate) { task.status = "completed"; task.msg = "Finished before the cancel took effect"; }
            else { task.status = "cancelled"; task.msg = "Cancelled at the client's request"; }
          } else if (task.step === 2) { task.status = "input_required"; task.msg = "Control PCI-4 needs a human decision"; task.key = "pci4_waiver_" + PG.hex(2); }
          else if (task.step >= 4) { task.status = "completed"; task.msg = "3 of 3 controls passed"; }
          else task.msg = "Scanning: " + (task.step * 25) + "%";
        }
        let extra = {};
        if (task.status === "input_required") extra.inputRequests = (function () { const r = {}; r[task.key] = { method: "elicitation/create", params: { mode: "form", message: "PCI-4 (card data at rest) flagged a legacy table. Accept a 30-day waiver?", requestedSchema: { type: "object", properties: { accept_waiver: { type: "boolean" }, ticket: { type: "string", title: "Change ticket" } }, required: ["accept_waiver"] } } }; return r; })();
        if (task.status === "completed" && task.refused) extra.result = { content: [{ type: "text", text: "Scan stopped: the PCI-4 waiver was refused, so checkout-api 2.14.0 is not compliant." }], isError: true };
        else if (task.status === "completed") extra.result = { content: [{ type: "text", text: "Compliance scan for checkout-api 2.14.0: 3 of 3 controls passed" + (task.waiver ? " (PCI-4 under waiver " + task.waiver + ")" : "") + "." }], structuredContent: { passed: 3, failed: 0 }, isError: false };
        await stage.send("server", "client", task.status, { tone: task.status === "input_required" ? "proxy" : task.status === "cancelled" ? "err" : undefined });
        wire.add({ kind: "in", actor: "server", label: "task · " + task.status + (task.msg ? " · " + task.msg : ""), status: task.status === "input_required" ? "input_required" : "200", http: SPEC.res(200), body: SPEC.ok(id, taskView(extra)), hl: ["status", "inputRequests", "result"] });
        paint();
        answer.innerHTML = "";
        if (task.status === "input_required") {
          PG.setResult(verdict, "warn", "The task paused for a person. The question rides in <code>inputRequests</code> on the poll, under a key that is never reused. Answer it below; that sends <code>tasks/update</code>.");
          answer.appendChild(h("div", { class: "bubble gate" }, h("b", { text: "release-tools asks (task " + task.id.slice(0, 8) + "…):" }), h("div", { text: "Accept a 30-day waiver for PCI-4?" }),
            h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: "Accept waiver", onclick: function () { update(true); } }), h("button", { class: "btn", type: "button", text: "Refuse", onclick: function () { update(false); } }))));
        } else if (task.status === "completed") {
          stage.badge("client", null);
          PG.setResult(verdict, task.cancelReq || task.refused ? "warn" : "ok", task.refused
            ? "You refused the waiver, so the job ended with a tool-level error. Note the status: <code>completed</code> with <code>isError: true</code> in <code>result</code>, not <code>failed</code>."
            : task.cancelReq
            ? "You asked to cancel, the server acknowledged, and the task still <b>completed</b>: the work finished first. Cancellation is cooperative; the final status is what counts."
            : "Done after " + polls + " polls and about " + task.min + " simulated minutes. <code>result</code> is exactly what <code>tools/call</code> would have returned.");
        } else if (task.status === "cancelled") {
          stage.badge("client", null);
          PG.setResult(verdict, "info", "Cancelled. Terminal: the status won't change again.");
        } else PG.setResult(verdict, "info", task.msg + ". Keep polling.");
      }
      async function update(ok) {
        id++;
        answer.innerHTML = "";
        const resp = {}; resp[task.key] = ok ? { action: "accept", content: { accept_waiver: true, ticket: "CHG-2207" } } : { action: "decline" };
        await stage.send("client", "server", "tasks/update");
        wire.add({ actor: "client", label: "tasks/update · " + (ok ? "accept" : "decline"), http: SPEC.post("tasks/update", task.id), body: SPEC.rpc("tasks/update", { taskId: task.id, inputResponses: resp }, id), hl: ["inputResponses"] });
        await stage.send("server", "client", "ack");
        wire.add({ kind: "in", actor: "server", label: "empty acknowledgement", status: "200", http: SPEC.res(200), body: SPEC.ok(id, {}) });
        if (ok) { task.status = "working"; task.msg = "Resuming with waiver"; task.waiver = "CHG-2207"; }
        else { task.status = "completed"; task.msg = "Stopped: waiver refused"; task.refused = true; }
        PG.setResult(verdict, "info", "The ack only means \"received\". The status changes on the server's side; poll again to see it.");
      }
      async function cancel() {
        if (!task || /completed|cancelled|failed/.test(task.status)) return PG.toast("No running task");
        id++;
        await stage.send("client", "server", "tasks/cancel");
        wire.add({ actor: "client", label: "tasks/cancel", http: SPEC.post("tasks/cancel", task.id), body: SPEC.rpc("tasks/cancel", { taskId: task.id }, id) });
        await stage.send("server", "client", "ack");
        wire.add({ kind: "in", actor: "server", label: "empty acknowledgement (not a promise)", status: "200", http: SPEC.res(200), body: SPEC.ok(id, {}) });
        task.cancelReq = true;
        if (task.status === "input_required") task.status = "working";
        PG.setResult(verdict, "info", "Acknowledged. That is a signal, not a state change: poll to see whether it actually stopped.");
      }
      function crash() {
        if (!task) return PG.toast("Start the scan first");
        crashed = true;
        stage.badge("client", "restarting…");
        wire.add({ kind: "note", label: "Client process restarted. Nothing was open, so nothing broke: the task id is in durable storage and polling resumes." });
        PG.setResult(verdict, "ok", "Compare a dropped SSE stream in the previous lesson, which loses the request. A task survives the client, the network and a load balancer change, as long as the task store does.");
      }
      startBtn.addEventListener("click", start);
      pollBtn.addEventListener("click", poll);
      cancelBtn.addEventListener("click", cancel);
      crashBtn.addEventListener("click", crash);
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          PG.switch("tk-decl", "Client declares " + TASKS_EXT, true, function (v) { declared = v; }),
          PG.switch("tk-late", "Work finishes before a cancel lands", false, function (v) { cancelLate = v; })),
        h("div", { class: "row" }, startBtn, pollBtn, cancelBtn, crashBtn, chip), answer, verdict), stage.el);

      const b = PG.lab(bench, "Which status, which field?", "Lab · completed vs failed");
      PG.sorter(b.body, [
        { t: "The tool returned <code>isError: true</code> (“version not found”)", a: "completed", why: "A tool error is still a result. <code>completed</code>, with the CallToolResult (and its <code>isError</code>) in <code>result</code>." },
        { t: "The server hit a JSON-RPC error while running the job (-32603)", a: "failed", why: "Protocol-level faults use <code>failed</code>, with the JSON-RPC <code>error</code> field." },
        { t: "You sent tasks/cancel and the server stopped the work", a: "cancelled", why: "Terminal; no result or error field." },
        { t: "You sent tasks/cancel but the scan had already finished", a: "completed", why: "Cancellation is cooperative. The real outcome wins." },
        { t: "The scan is waiting for a waiver decision", a: "input_required", why: "With <code>inputRequests</code>; answer via <code>tasks/update</code>." },
        { t: "The scan is 50% through", a: "working", why: "Optionally with a <code>statusMessage</code> like “Scanning: 50%”." },
      ], ["working", "input_required", "completed", "failed", "cancelled"]);
    },
    quiz: [
      { q: "Who decides that a tools/call becomes a task in 2026-07-28?",
        opts: ["The client, with a task parameter", "The server, per request, if the client declared the extension", "The tool's execution.taskSupport field", "The gateway"],
        a: 1, why: "Server-directed. The task parameter and execution.taskSupport belonged to the 2025-11-25 experimental design." },
      { q: "How does a client give a running task the answer it asked for?",
        opts: ["tasks/result", "Retry tools/call with inputResponses", "tasks/update with inputResponses", "notifications/tasks"],
        a: 2, why: "tasks/update carries inputResponses keyed like the task's inputRequests; it returns an empty ack, then you poll." },
      { q: "A tool inside a task returns isError: true. The task's status is:",
        opts: ["failed", "completed, with the result in result", "cancelled", "input_required"],
        a: 1, why: "failed is only for JSON-RPC errors; a tool-level error is a completed result." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: subscriptions/listen
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "subscriptions",
    track: "transports",
    title: "Subscriptions: one stream for “something changed”",
    short: "Subscriptions",
    thesis: "To hear about changes (new tools, an edited resource), the client sends subscriptions/listen naming the notifications it wants. The server acknowledges, then sends only those, each tagged with the subscription's id, until either side ends it.",
    refs: "Spec 2026-07-28 · Patterns › Subscriptions · Changelog item 4",
    brief: `
      <h2>Opting in</h2>
      <p><code>subscriptions/listen</code> with <code>notifications: {toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions: [uris]}</code>. Anything left out isn't sent. Over HTTP the response is a long-lived SSE stream; on stdio it shares the pipes.</p>
      <ol>
        <li>First message: <code>notifications/subscriptions/acknowledged</code>, listing the subset the server agreed to. Check it against what you asked for.</li>
        <li>Then notifications such as <code>notifications/tools/list_changed</code> and <code>notifications/resources/updated {uri}</code>, each with <code>_meta["io.modelcontextprotocol/subscriptionId"]</code> equal to the listen request's id.</li>
        <li>End: the client closes the stream (HTTP) or sends <code>notifications/cancelled</code> (stdio). A server ending it gracefully answers the listen request with a normal <code>complete</code> result (and sends <code>notifications/cancelled</code> for that id: the one thing a server may cancel). A stream that just drops means "reconnect".</li>
      </ol>
      <p>Progress and log lines never go on this stream: they belong to the response stream of their own request. A client may hold several subscriptions; the id tells them apart. After a reconnect, listen again: the server keeps no subscription state.</p>
      <div class="note"><span class="note-label">Tasks</span>With the tasks extension, <code>notifications: {taskIds: [...]}</code> asks for <code>notifications/tasks</code>, each carrying the full task state, so the client can stop polling (see the previous lesson, <em>Tasks extension</em>).</div>
      <div class="note"><span class="note-label">Replaces</span>The legacy HTTP GET stream, <code>resources/subscribe</code> and <code>resources/unsubscribe</code>.</div>
      <div class="note"><span class="note-label">Pair with caching</span>A <code>list_changed</code> notification is the signal to throw away a cached <code>tools/list</code> before its <code>ttlMs</code> runs out.</div>`,
    lab: function (bench, api) {
      const a = PG.lab(bench, "Listen for tool and runbook changes", "Lab · listen · acknowledged · subscriptionId");
      const want = { tools: true, prompts: false, runbook: true };
      let open = false, lid = 40;
      const cached = h("div", { class: "result", text: "Client cache: tools/list (4 tools), fresh for 5 min." });
      const stage = PG.stage(a.body, {
        actors: [
          { id: "client", role: "client", label: "MCP client", sub: "", x: 14, y: 50 },
          { id: "server", role: "server", label: "release-tools", sub: "", x: 84, y: 50 },
        ],
        links: [["client", "server"]],
      });
      const wire = PG.wire(a.body);
      async function listen() {
        if (open) return PG.toast("Already listening");
        lid++;
        const n = {};
        if (want.tools) n.toolsListChanged = true;
        if (want.prompts) n.promptsListChanged = true;
        if (want.runbook) n.resourceSubscriptions = ["runbook://checkout-api/rollback"];
        if (!(await stage.send("client", "server", "subscriptions/listen"))) return;
        wire.add({ actor: "client", label: "subscriptions/listen · id " + lid, http: SPEC.post("subscriptions/listen"), body: SPEC.rpc("subscriptions/listen", { notifications: n }, lid), hl: ["notifications"] });
        const ack = Object.assign({}, n); delete ack.promptsListChanged;
        const m = {}; m[SPEC.K.sub] = lid;
        await stage.send("server", "client", "acknowledged");
        stage.hold("client", "server", true, "server");
        open = true;
        wire.add({ kind: "evt", actor: "server", label: "acknowledged" + (want.prompts ? " (no promptsListChanged: this server's prompts never change)" : ""), http: SPEC.res(200, "sse"), sse: [SPEC.notif("notifications/subscriptions/acknowledged", { _meta: m, notifications: ack })], hl: ["notifications"] });
      }
      async function change(kind) {
        if (kind === "tools") wire.add({ kind: "note", label: "Server deploys a new tool: freeze_deploys." });
        else wire.add({ kind: "note", label: "Someone edits runbook://checkout-api/rollback." });
        const subscribed = open && (kind === "tools" ? want.tools : want.runbook);
        if (!subscribed) { PG.setResult(cached, "warn", "Nothing was sent: " + (open ? "you didn't opt in to this kind of change." : "no subscription is open.") + " The client keeps using its cached copy until ttlMs runs out."); return; }
        const m = {}; m[SPEC.K.sub] = lid;
        await stage.send("server", "client", kind === "tools" ? "tools/list_changed" : "resources/updated");
        wire.add({ kind: "evt", actor: "server", label: kind === "tools" ? "notifications/tools/list_changed" : "notifications/resources/updated", sse: [SPEC.notif(kind === "tools" ? "notifications/tools/list_changed" : "notifications/resources/updated", kind === "tools" ? { _meta: m } : { _meta: m, uri: "runbook://checkout-api/rollback" })], hl: [SPEC.K.sub, "uri"] });
        if (kind === "tools") {
          await stage.send("client", "server", "tools/list");
          wire.add({ actor: "client", label: "tools/list (cache invalidated)", http: SPEC.post("tools/list"), body: SPEC.rpc("tools/list", {}, lid + 100) });
          await stage.send("server", "client", "5 tools");
          wire.add({ kind: "in", actor: "server", label: "5 tools", status: "200", http: SPEC.res(200), body: SPEC.ok(lid + 100, { tools: SPEC.tools.map(function (t) { return { name: t.name }; }).concat([{ name: "freeze_deploys" }]), ttlMs: 300000, cacheScope: "public" }) });
          PG.setResult(cached, "ok", "Client cache: tools/list (5 tools). The notification invalidated the cache early; the model sees freeze_deploys right away.");
        } else PG.setResult(cached, "ok", "The app re-reads the runbook it had attached.");
      }
      async function end(who) {
        if (!open) return;
        open = false;
        stage.hold("client", "server", false);
        if (who === "client") { wire.add({ kind: "note", label: "Client closes the stream (HTTP). On stdio: notifications/cancelled {requestId: " + lid + "}." }); PG.setResult(cached, "info", "Subscription over. Listen again whenever you want updates."); }
        else {
          const m = {}; m[SPEC.K.sub] = lid;
          await stage.send("server", "client", "complete");
          wire.add({ kind: "in", actor: "server", label: "result for listen id " + lid + " · graceful end", status: "200", body: SPEC.ok(lid, { _meta: m }), hl: [SPEC.K.sub] });
          PG.setResult(cached, "info", "The server is shutting down and said so with a normal result. An abrupt drop would carry no result: that's the client's cue to reconnect and listen again.");
        }
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          PG.switch("sub-t", "toolsListChanged", true, function (v) { want.tools = v; }),
          PG.switch("sub-p", "promptsListChanged", false, function (v) { want.prompts = v; }),
          PG.switch("sub-r", "resourceSubscriptions: rollback runbook", true, function (v) { want.runbook = v; })),
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Listen", onclick: listen }),
          h("button", { class: "btn", type: "button", text: "Server adds a tool", onclick: function () { change("tools"); } }),
          h("button", { class: "btn", type: "button", text: "Runbook edited", onclick: function () { change("runbook"); } }),
          h("button", { class: "btn", type: "button", text: "Client stops", onclick: function () { end("client"); } }),
          h("button", { class: "btn", type: "button", text: "Server shuts down", onclick: function () { end("server"); } })), cached), stage.el);
    },
    quiz: [
      { q: "What's the first message on a new subscription?",
        opts: ["notifications/tools/list_changed", "notifications/subscriptions/acknowledged", "A ping", "The listen request's result"],
        a: 1, why: "The server MUST acknowledge first, listing what it agreed to send." },
      { q: "What value is io.modelcontextprotocol/subscriptionId?",
        opts: ["A random UUID from the server", "The JSON-RPC id of the subscriptions/listen request", "The session id", "The progressToken"],
        a: 1, why: "It's the listen request's id, so a client with several subscriptions can tell them apart." },
      { q: "Where do notifications/progress for a tools/call arrive?",
        opts: ["On the subscriptions/listen stream", "On that tools/call's own response stream", "On a GET stream", "As a separate POST"],
        a: 1, why: "Request-scoped notifications stay on their request's stream, never the listen stream." },
    ],
  });
})();
