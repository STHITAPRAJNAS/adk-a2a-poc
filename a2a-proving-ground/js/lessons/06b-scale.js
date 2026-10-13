/* Track 6, continued — scale and quality: two replicas of one agent, the shape
 * of the call graph (choosing, chaining, loops), and testing agents. Both
 * failure modes in the first two lessons were reproduced against this repo's
 * real ADK agents (tests/test_replicas_and_loops.py, k8s-lab labs 84 and 85). */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h, SPEC = PG.SPEC;

  function result(el, tone, html) {
    el.className = "result " + tone;
    el.innerHTML = html;
  }
  function btn(text, cls, onclick) {
    return h("button", { class: "btn " + (cls || ""), type: "button", text: text, onclick: onclick });
  }

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Two replicas, one task
   * ════════════════════════════════════════════════════════════════════ */
  PG.lesson({
    id: "replicas",
    track: "production",
    title: "Two replicas, one task",
    short: "Replicas",
    thesis: "A shared task store lets every replica read a task. Only the pod running it can act on it: a subscription or a cancel that lands on the other pod fails quietly, and the cancel can even be undone.",
    refs: "Spec §3.1.6 SubscribeToTask · §3.1.5 CancelTask · §4.1.3 TaskState (terminal states are final) · this repo: common/task_ownership.py, k8s-lab lab 84",
    brief: `
      <h2>What lives where</h2>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Thing</th><th>With a shared task store</th></tr></thead>
        <tbody>
          <tr><td>The task: id, state, history, artifacts</td><td>Shared. Any replica answers <code>GetTask</code> and <code>ListTasks</code>.</td></tr>
          <tr><td>The work: the executor running the agent</td><td><b>One pod's memory</b>, the one that received <code>SendMessage</code>.</td></tr>
          <tr><td>The live event stream subscribers read</td><td><b>One pod's memory</b>, the same pod.</td></tr>
          <tr><td>Your app's own state (tickets, jobs, caches)</td><td>Wherever you put it. In memory means one pod.</td></tr>
        </tbody></table></div>
      <h2>Two calls that go to the wrong pod</h2>
      <ul>
        <li><strong><code>SubscribeToTask</code> on the other pod</strong> finds the task in the store and sends the stored snapshot. Then nothing, ever: its local event stream for that task has no producer. The client sits on <code>WORKING</code> while the task moves on elsewhere, and cannot tell.</li>
        <li><strong><code>CancelTask</code> on the other pod</strong> writes <code>CANCELED</code> to the store and answers success. The owning pod never hears of it, keeps working, and its next update overwrites a state the spec calls final. The cancelled release goes on to request approval.</li>
      </ul>
      <div class="note trap"><span class="note-label">Trap</span>Both look like success. The subscription is open; the cancel returned <code>CANCELED</code>. Only a later <code>GetTask</code> shows the task alive again.</div>
      <h2>Ways to fix it</h2>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Fix</th><th>Trade-off</th></tr></thead>
        <tbody>
          <tr><td><b>Forward to the owner</b>: each pod records "task X runs here"; a pod that gets a subscribe or cancel for someone else's task forwards it there</td><td>Small, every replica stays equal. One extra hop for two kinds of call.</td></tr>
          <tr><td><b>Sticky routing by task id</b> at the load balancer</td><td>Needs a balancer that reads JSON-RPC bodies; breaks when the pod restarts.</td></tr>
          <tr><td><b>A shared event bus</b> (Redis pub/sub, Postgres LISTEN/NOTIFY)</td><td>Any pod serves any stream. Replaces the SDK's in-process queues.</td></tr>
          <tr><td><b>One replica</b></td><td>Often the honest answer. Scale with more agents, not more copies.</td></tr>
        </tbody></table></div>
      <p>Whatever you pick, an executor that re-reads the stored state before each write, and stops when it finds a terminal one, keeps a slipped cancel from being undone.</p>
      <div class="note ours"><span class="note-label">In this repo</span><code>A2A_OWNER_ROUTING=1</code> (<code>common/task_ownership.py</code>) forwards the two calls to the owning pod. Without it, the real agents print <code>✗ STUCK</code> and <code>✗ RESURRECTED</code> (<code>tests/test_replicas_and_loops.py</code>, lab 84). The AG-UI twin of this bug is in the <a href="#fe-agui">AG-UI lesson</a> and <code>agui/prodlike</code>: shared data, per-pod memory, a load balancer that does not care.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Two replicas behind one Service", "Lab · replica simulator");
      const cfg = { routing: false, target: "b" };
      let started = false, busy = false, runToken = 0;
      const stage = PG.stage(a.body, {
        actors: [
          { id: "client", role: "client", label: "Client", sub: "orchestrator / page", x: 13, y: 45 },
          { id: "lb", role: "proxy", label: "Service", sub: "load balancer", x: 40, y: 45 },
          { id: "ra", role: "server", label: "Replica A", sub: "runs task-77", x: 62, y: 16 },
          { id: "rb", role: "server", label: "Replica B", sub: "idle", x: 62, y: 78 },
          { id: "db", role: "registry", label: "Shared store", sub: "tasks · sessions · owners", x: 86, y: 47, glyph: "DB" },
        ],
        links: [["client", "lb"], ["lb", "ra"], ["lb", "rb"], ["ra", "db"], ["rb", "db"], ["ra", "rb"]],
      });
      const res = h("div", { class: "result", text: "Start a release, then send a follow-up call." });
      const wire = PG.wire(a.body, { title: "Wire" });
      const bStart = btn("1 · Start a release (lands on A)", "client", start);
      const bSub = btn("2 · SubscribeToTask", "", function () { follow("subscribe"); });
      const bCancel = btn("2 · CancelTask", "danger", function () { follow("cancel"); });
      function paint() {
        bStart.disabled = busy;
        bSub.disabled = busy || !started;
        bCancel.disabled = busy || !started;
      }
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          PG.switch("own-route", "Forward to the owning pod (A2A_OWNER_ROUTING)", cfg.routing, function (v) { cfg.routing = v; reset(); }),
          PG.seg([{ v: "b", label: "follow-up lands on B" }, { v: "a", label: "lands on A" }], cfg.target, function (v) { cfg.target = v; reset(); }, "Load balancer picks")),
        h("div", { class: "row" }, bStart, bSub, bCancel)), stage.el);
      a.body.insertBefore(res, wire.el);
      function reset() {
        runToken++; started = false; busy = false;
        ["client", "lb", "ra", "rb", "db"].forEach(function (id) { stage.badge(id, null); });
        wire.clear();
        result(res, "", "Start a release, then send a follow-up call.");
        paint();
      }
      async function start() {
        reset(); busy = true; paint();
        const my = runToken;
        wire.add({ actor: "client", label: "SendStreamingMessage · deploy checkout-api 2.14.0", http: SPEC.post("/a2a/deployment_agent", { Accept: "text/event-stream" }), body: SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", ["deploy checkout-api 2.14.0 to production"]) }) });
        if (!(await stage.send("client", "lb", "SendStreamingMessage"))) return;
        if (!(await stage.send("lb", "ra", "SendStreamingMessage"))) return;
        await stage.send("ra", "db", cfg.routing ? "task-77 · owner = A" : "task-77 WORKING");
        if (my !== runToken) return;
        stage.badge("ra", PG.stateChip("WORKING"));
        stage.badge("db", h("span", { class: "chip", text: cfg.routing ? "task-77 WORKING · owner A" : "task-77 WORKING" }));
        wire.add({ kind: "evt", actor: "server", label: "event · task-77 WORKING (compliance scan, 8 s)", body: { jsonrpc: "2.0", id: 1, result: SPEC.statusUpdate("task-77", "ctx-9", "WORKING") } });
        if (cfg.routing) wire.add({ kind: "note", actor: "server", label: "Replica A records in the shared store: task-77 runs here, at http://10.244.1.7:8001" });
        busy = false; started = true; paint();
      }
      async function follow(kind) {
        busy = true; paint();
        const my = runToken;
        const to = cfg.target === "a" ? "ra" : "rb";
        const method = kind === "subscribe" ? "SubscribeToTask" : "CancelTask";
        wire.add({ actor: "client", label: method + " · id=task-77", http: SPEC.post("/a2a/deployment_agent", kind === "subscribe" ? { Accept: "text/event-stream" } : {}), body: SPEC.rpc(method, { id: "task-77" }) });
        if (!(await stage.send("client", "lb", method))) return;
        if (!(await stage.send("lb", to, method))) return;
        if (my !== runToken) return;
        const onOwner = to === "ra";
        const forwarded = !onOwner && cfg.routing;
        if (forwarded) {
          await stage.send("rb", "db", "who owns task-77?");
          await stage.send("db", "rb", "A");
          wire.add({ kind: "note", actor: "proxy", label: "Replica B forwards the request to A unchanged (same token, same traceparent), and streams A's answer back with x-a2a-served-by: A" });
          await stage.send("rb", "ra", method);
        }
        if (kind === "subscribe") {
          if (onOwner || forwarded) {
            const via = forwarded ? "rb" : null;
            stage.badge("ra", PG.stateChip("INPUT_REQUIRED"));
            await stage.send("ra", via || "lb", "INPUT_REQUIRED");
            if (via) await stage.send("rb", "lb", "INPUT_REQUIRED");
            await stage.send("lb", "client", "INPUT_REQUIRED");
            wire.add({ kind: "evt", actor: "server", label: "event · task-77 INPUT_REQUIRED (approval needed)", body: { jsonrpc: "2.0", id: 1, result: SPEC.statusUpdate("task-77", "ctx-9", "INPUT_REQUIRED", "Waiting on human approval for CHG-4D1A") } });
            result(res, "ok", forwarded
              ? "<b>✓ Forwarded.</b> B found that A runs task-77 and passed the subscription there; the client follows the task live to <code>INPUT_REQUIRED</code>, exactly as <code>scripts/a2a_replica_probe.py subscribe</code> reports with the switch on."
              : "<b>✓ Lucky.</b> The load balancer happened to pick the pod running the task. With two replicas, that is a coin toss on every reconnect.");
          } else {
            await stage.send("rb", "db", "GetTask task-77");
            await stage.send("db", "rb", "WORKING");
            await stage.send("rb", "lb", "task WORKING");
            await stage.send("lb", "client", "task WORKING");
            wire.add({ kind: "evt", actor: "server", label: "event · task-77 WORKING (the stored snapshot)", body: { jsonrpc: "2.0", id: 1, result: { task: SPEC.task("task-77", "ctx-9", "WORKING") } } });
            stage.hold("client", "lb", true, "server");
            stage.badge("ra", PG.stateChip("INPUT_REQUIRED"));
            stage.badge("db", h("span", { class: "chip", text: "task-77 INPUT_REQUIRED" }));
            stage.badge("client", h("span", { class: "chip warn", text: "still WORKING…" }));
            wire.add({ kind: "note", actor: "server", label: "On A the scan ends and the task moves to INPUT_REQUIRED. B's stream for task-77 has no producer: nothing more will arrive." });
            result(res, "err", "<b>✗ Stuck.</b> The client got the stored snapshot and then silence, while the task moved to <code>INPUT_REQUIRED</code> on A. The stream stays open, so the client cannot tell. This is what the real agents print as <code>✗ STUCK</code>.");
          }
        } else {
          if (onOwner || forwarded) {
            stage.badge("ra", PG.stateChip("CANCELED"));
            await stage.send("ra", "db", "task-77 CANCELED");
            stage.badge("db", h("span", { class: "chip", text: "task-77 CANCELED" }));
            if (forwarded) await stage.send("ra", "rb", "CANCELED");
            await stage.send(forwarded ? "rb" : "ra", "lb", "CANCELED");
            await stage.send("lb", "client", "CANCELED");
            wire.add({ kind: "in", actor: "server", label: "result · task-77 CANCELED", status: "200", body: { jsonrpc: "2.0", id: 1, result: SPEC.task("task-77", "ctx-9", "CANCELED") } });
            wire.add({ kind: "note", actor: "server", label: "GetTask a while later → CANCELED. The work stopped where it ran." });
            result(res, "ok", "<b>✓ Canceled, and it stayed canceled.</b> The cancel reached the executor doing the work" + (forwarded ? ", via B" : "") + ".");
          } else {
            await stage.send("rb", "db", "task-77 CANCELED");
            stage.badge("db", h("span", { class: "chip", text: "task-77 CANCELED" }));
            await stage.send("rb", "lb", "CANCELED");
            await stage.send("lb", "client", "CANCELED");
            wire.add({ kind: "in", actor: "server", label: "result · task-77 CANCELED (from B)", status: "200", body: { jsonrpc: "2.0", id: 1, result: SPEC.task("task-77", "ctx-9", "CANCELED") } });
            await PG.sleep(700 / PG.speed);
            if (my !== runToken) return;
            stage.badge("ra", PG.stateChip("INPUT_REQUIRED"));
            await stage.send("ra", "db", "task-77 INPUT_REQUIRED", { tone: "err" });
            stage.badge("db", h("span", { class: "chip err", text: "task-77 INPUT_REQUIRED" }));
            wire.add({ kind: "note", actor: "server", label: "A never heard of the cancel. Its scan ends and it writes INPUT_REQUIRED over CANCELED, then opens approval ticket CHG-4D1A." });
            result(res, "err", "<b>✗ Resurrected.</b> B told the client <code>CANCELED</code>, then A overwrote it: the task is live again and a person now has an approval to decide for a release that was cancelled. The real agents print exactly this as <code>✗ RESURRECTED</code>.");
          }
        }
        busy = false; paint();
      }
      reset();
    },
    quiz: [
      { q: "Two replicas share a Postgres task store. A client's SubscribeToTask lands on the replica not running the task. What does it get?",
        opts: ["TaskNotFoundError", "The stored snapshot, then no further events", "Every event, from the store", "A redirect"],
        a: 1, why: "The task is in the store, so it is found; the live events exist only in the running pod's memory." },
      { q: "CancelTask lands on the other replica, which answers CANCELED. What can happen next?",
        opts: ["Nothing; CANCELED is final", "The owning pod keeps working and overwrites CANCELED with its next state", "The store rejects the cancel", "Both pods cancel"],
        a: 1, why: "The owner never heard of the cancel. Only something that reaches the owner (or a write guard) keeps the terminal state final." },
      { q: "Which calls does owner forwarding need to route to the running pod?",
        opts: ["All of them", "SubscribeToTask and CancelTask", "GetTask and ListTasks", "SendMessage only"],
        a: 1, why: "Reads come from the shared store; only the live stream and the running work are pod-local." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Chains, loops and who to call
   * ════════════════════════════════════════════════════════════════════ */
  const CANDIDATES = [
    { id: "rel-a", name: "Release Ops (platform team)", skills: ["release", "readiness"], streaming: true, signed: true, p95: 4, cost: 3, healthy: true },
    { id: "rel-b", name: "QuickShip (vendor)", skills: ["release"], streaming: false, signed: false, p95: 1, cost: 1, healthy: true },
    { id: "rel-c", name: "Release Ops (old region)", skills: ["release", "readiness"], streaming: true, signed: true, p95: 9, cost: 3, healthy: false },
  ];

  PG.lesson({
    id: "topologies",
    track: "production",
    title: "Chains, loops and who to call",
    short: "Topologies & loops",
    thesis: "Once agents pick other agents, the shape of the call graph is decided at run time, by cards and configuration. Choose deliberately, cap the depth, refuse a request that comes back around, and pass deadlines and budgets down the chain.",
    refs: "Spec §5 Agent discovery · §4.4.1 AgentCard · §3.2.4 error codes · this repo: common/hops.py, common/downstream.py, k8s-lab lab 85",
    brief: `
      <h2>Three shapes</h2>
      <ul>
        <li><strong>Orchestrator (hub)</strong>: one agent fans work out and owns the answer. Covered in <a href="#fanout">Fan-out and fan-in</a>.</li>
        <li><strong>Chain</strong>: A delegates to B, which delegates to C. Each hop owns a task and holds a connection while the next one works.</li>
        <li><strong>Mesh</strong>: agents delegate to whoever their cards say handles a request. Nobody sees the whole graph.</li>
      </ul>
      <h2>Choosing an agent</h2>
      <p>Discovery gives you candidates; choosing is your job. Filter on what you <em>require</em> (the skill, the modes and capabilities you need, a card you can trust), then rank on what you <em>prefer</em> (latency, cost, health). Make the decision visible in logs: "picked X because…" is what you will need on the day it picks wrong.</p>
      <h2>Loops come from configuration</h2>
      <p>Two cards pointing at each other is enough: a copy-pasted values file, a stale registry entry, two teams each naming the other as the specialist. Every hop is a valid A2A call, and nothing in the protocol counts hops. One request becomes dozens of tasks, each holding a connection and an LLM turn, until something times out.</p>
      <h2>The guard</h2>
      <ol class="steps">
        <li><strong>Carry the trail</strong> on every outbound call, the way <code>traceparent</code> travels: the agents this request has already passed through.</li>
        <li><strong>Refuse a cycle</strong>: if your own name is in the trail, answer with a JSON-RPC error that names the path.</li>
        <li><strong>Refuse depth</strong>: past a limit, refuse even without a cycle.</li>
        <li><strong>Name deployments, not codebases</strong>: two deployments of the same agent are two agents.</li>
        <li><strong>Pass a deadline and a budget</strong> the same way. A hop limit stops loops; a deadline stops a chain that is merely slow; a budget stops one that is expensive.</li>
      </ol>
      <div class="note trap"><span class="note-label">Trap</span>A refusal the user never hears about. ADK's <code>RemoteA2aAgent</code> logs a downstream JSON-RPC error and records an event with no content, and the task ends <code>COMPLETED</code> with no text. Surface the reason as the remote agent's answer.</div>
      <div class="note ours"><span class="note-label">In this repo</span><code>A2A_MAX_HOPS</code> (<code>common/hops.py</code>) carries <code>X-A2A-Trail</code> and refuses cycles (<code>-32010</code>) and over-deep chains (<code>-32011</code>). Two concierges pointed at each other open 32 tasks in 20 seconds without it; with it the request ends after 2 tasks with "Delegation loop: loop-a → loop-b → loop-a" (lab 85). <code>common.downstream.surface_downstream_error</code> puts that sentence in front of the user. In a fleet, standardise the trail as an A2A extension and carry it in message metadata.</div>`,
    lab: function (bench) {
      /* Lab A — the loop */
      const a = PG.lab(bench, "One request into a delegation graph", "Lab · loop simulator");
      const cfg = { aTo: "b", bTo: "a", cTo: "none", guard: false, max: 4 };
      let busy = false, runToken = 0;
      const stage = PG.stage(a.body, {
        actors: [
          { id: "user", role: "client", label: "Caller", sub: "one request", x: 13, y: 50 },
          { id: "a", role: "server", label: "Agent A", sub: "concierge", x: 38, y: 18 },
          { id: "b", role: "server", label: "Agent B", sub: "\"release agent\"", x: 80, y: 50 },
          { id: "c", role: "server", label: "Agent C", sub: "real specialist", x: 38, y: 84 },
        ],
        links: [["user", "a"], ["a", "b"], ["b", "c"], ["a", "c"]],
      });
      const counter = h("span", { class: "chip mono", text: "tasks opened: 0" });
      const res = h("div", { class: "result", text: "Wire the graph, then send one release request to A." });
      const wire = PG.wire(a.body, { title: "Wire" });
      const go = btn("Send one release request", "client", run);
      const opts = function (self) {
        return [{ v: "none", label: "nobody (does it)" }].concat(["a", "b", "c"].filter(function (x) { return x !== self; }).map(function (x) { return { v: x, label: x.toUpperCase() }; }));
      };
      const maxSel = PG.select("hop-max", [{ v: "1", label: "1" }, { v: "2", label: "2" }, { v: "3", label: "3" }, { v: "4", label: "4" }, { v: "6", label: "6" }], String(cfg.max), function (v) { cfg.max = Number(v); });
      a.body.insertBefore(h("div", { class: "stack" },
        h("div", { class: "row" },
          h("label", { class: "small", text: "A hands releases to" }), PG.select("a-to", opts("a"), cfg.aTo, function (v) { cfg.aTo = v; }),
          h("label", { class: "small", text: "B to" }), PG.select("b-to", opts("b"), cfg.bTo, function (v) { cfg.bTo = v; }),
          h("label", { class: "small", text: "C to" }), PG.select("c-to", opts("c"), cfg.cTo, function (v) { cfg.cTo = v; })),
        h("div", { class: "row" },
          PG.switch("hop-guard", "Hop guard (A2A_MAX_HOPS)", cfg.guard, function (v) { cfg.guard = v; }),
          h("label", { class: "small", text: "limit" }), maxSel, go, counter)), stage.el);
      a.body.insertBefore(res, wire.el);
      function reset() {
        runToken++; busy = false; go.disabled = false;
        ["user", "a", "b", "c"].forEach(function (id) { stage.badge(id, null); });
        wire.clear(); counter.textContent = "tasks opened: 0";
        result(res, "", "Wire the graph, then send one release request to A.");
      }
      async function run() {
        reset(); busy = true; go.disabled = true;
        const my = runToken;
        const next = { a: cfg.aTo, b: cfg.bTo, c: cfg.cTo };
        const name = { a: "agent-a", b: "agent-b", c: "agent-c" };
        let trail = [], at = "a", from = "user", tasks = 0;
        const LIMIT = 24;
        while (true) {
          const header = trail.length ? { "X-A2A-Trail": trail.join(",") } : {};
          wire.add({ actor: from === "user" ? "client" : "server", label: (from === "user" ? "caller" : name[from]) + " → " + name[at] + " · SendStreamingMessage" + (cfg.guard && trail.length ? "  (trail: " + trail.join(" → ") + ")" : ""), http: SPEC.post("/a2a/" + name[at], Object.assign({ Accept: "text/event-stream" }, cfg.guard ? header : {})), body: SPEC.rpc("SendStreamingMessage", { message: SPEC.msg("user", ["deploy checkout-api 2.14.0 to production"]) }) });
          if (!(await stage.send(from, at, "deploy…", { dur: tasks > 6 ? 380 : 900 }))) return;
          if (my !== runToken) return;
          if (cfg.guard && trail.indexOf(name[at]) >= 0) {
            const path = trail.concat([name[at]]).join(" → ");
            wire.add({ kind: "in", actor: "server", label: name[at] + " refuses: delegation loop", status: "200", body: { jsonrpc: "2.0", id: null, error: { code: -32010, message: "Delegation loop: " + name[at] + " is already in this request's trail (" + path + ").", data: { trail: trail } } }, open: true });
            stage.badge(at, h("span", { class: "chip err", text: "refused: loop" }));
            await unwind(from, "Delegation loop: " + path);
            result(res, "ok", "<b>✓ Refused, and the caller knows why.</b> " + tasks + " task(s), then <code>" + PG.esc(name[at]) + "</code> saw its own name in the trail. The caller's answer: <i>could not take this request: Delegation loop (" + PG.esc(path) + ")</i>.");
            break;
          }
          if (cfg.guard && trail.length >= cfg.max) {
            const path = trail.concat([name[at]]).join(" → ");
            wire.add({ kind: "in", actor: "server", label: name[at] + " refuses: too deep", status: "200", body: { jsonrpc: "2.0", id: null, error: { code: -32011, message: "Delegation too deep: " + (trail.length + 1) + " hops, the limit here is " + cfg.max + " (" + path + ").", data: { trail: trail } } }, open: true });
            stage.badge(at, h("span", { class: "chip err", text: "refused: depth" }));
            await unwind(from, "Delegation too deep: " + path);
            result(res, "ok", "<b>✓ Refused on depth.</b> No cycle needed: the chain reached the limit of " + cfg.max + ".");
            break;
          }
          tasks++;
          counter.textContent = "tasks opened: " + tasks;
          stage.badge(at, PG.stateChip("WORKING"));
          trail = trail.concat([name[at]]);
          const to = next[at];
          if (to === "none") {
            stage.badge(at, PG.stateChip("INPUT_REQUIRED"));
            wire.add({ kind: "note", actor: "server", label: name[at] + " does the work: readiness, scan, approval gate." });
            await unwind(at, null);
            result(res, "ok", "<b>✓ Ended normally</b> after " + tasks + " task(s): the chain reached an agent that does the work.");
            break;
          }
          if (tasks >= LIMIT) {
            result(res, "err", "<b>✗ Still bouncing.</b> " + tasks + " tasks for ONE request and counting; every hop is waiting on the next and each has a 15-minute timeout. The real pair opened 32 tasks in 20 seconds. Turn on the hop guard.");
            break;
          }
          from = at; at = to;
        }
        busy = false; go.disabled = false;
        async function unwind(back, reason) {
          /* The refusal (or the answer) travels back down the chain. */
          const seq = trail.slice();
          let here = back;
          for (let i = seq.length - 1; i >= 0; i--) {
            const prevName = i > 0 ? seq[i - 1] : null;
            const prev = prevName ? Object.keys(name).find(function (k) { return name[k] === prevName; }) : "user";
            if (!(await stage.send(here, prev, reason ? "refused" : "answer", { tone: reason ? "err" : undefined, dur: 420 }))) return;
            here = prev;
          }
        }
      }

      /* Lab B — choosing */
      const b = PG.lab(bench, "Three cards answer to “release”: which one gets the call?", "Lab · agent selection");
      const need = { streaming: true, signed: true, healthy: true, prefer: "latency" };
      const out = h("div", {});
      function choose() {
        out.innerHTML = "";
        const rows = CANDIDATES.map(function (c) {
          const why = [];
          if (c.skills.indexOf("release") < 0) why.push("no release skill");
          if (need.streaming && !c.streaming) why.push("no streaming");
          if (need.signed && !c.signed) why.push("unsigned card");
          if (need.healthy && !c.healthy) why.push("failing health checks");
          return { c: c, ok: !why.length, why: why };
        });
        const eligible = rows.filter(function (r) { return r.ok; });
        eligible.sort(function (x, y) { return need.prefer === "latency" ? x.c.p95 - y.c.p95 : x.c.cost - y.c.cost; });
        const pick = eligible[0];
        out.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Candidate", "streaming", "signed card", "p95", "cost", "health", "verdict"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", {}, rows.map(function (r) {
            return h("tr", {}, h("td", { text: r.c.name }), h("td", { text: r.c.streaming ? "yes" : "no" }), h("td", { text: r.c.signed ? "yes" : "no" }),
              h("td", { class: "mono", text: r.c.p95 + " s" }), h("td", { class: "mono", text: "$".repeat(r.c.cost) }), h("td", { text: r.c.healthy ? "ok" : "failing" }),
              h("td", {}, pick && pick.c.id === r.c.id ? h("span", { class: "chip ok", text: "picked" }) : r.ok ? h("span", { class: "chip", text: "eligible" }) : h("span", { class: "chip warn", text: r.why.join(", ") })));
          })))));
        out.appendChild(h("div", { class: "result " + (pick ? "ok" : "err"), html: pick
          ? "<b>Picked " + PG.esc(pick.c.name) + "</b> — it meets every requirement and has the best " + (need.prefer === "latency" ? "p95 latency" : "cost") + " of " + eligible.length + " eligible. Log this sentence with the request: it is the first thing you will want when the choice turns out wrong."
          : "<b>No agent qualifies.</b> Say so to the caller. Quietly relaxing a requirement (an unsigned card, a failing region) is how a release ends up somewhere nobody chose." }));
      }
      b.body.append(h("div", { class: "row" },
        PG.switch("need-stream", "Require streaming", need.streaming, function (v) { need.streaming = v; choose(); }),
        PG.switch("need-signed", "Require a signed card", need.signed, function (v) { need.signed = v; choose(); }),
        PG.switch("need-health", "Skip failing agents", need.healthy, function (v) { need.healthy = v; choose(); }),
        PG.seg([{ v: "latency", label: "prefer fast" }, { v: "cost", label: "prefer cheap" }], need.prefer, function (v) { need.prefer = v; choose(); }, "Rank by")), out);
      choose();
      reset();
    },
    quiz: [
      { q: "Two agents' cards point at each other. What in A2A itself stops a request from bouncing between them?",
        opts: ["The A2A-Version header", "Nothing: every hop is a valid call; the agents must carry and check a trail or hop count", "TaskNotFoundError", "contextId"],
        a: 1, why: "The protocol has no hop count. Loop protection is something you add, like traceparent." },
      { q: "Two deployments run the same agent code. What name should each put in the delegation trail?",
        opts: ["The app name", "A per-deployment id, so the two are distinguishable", "The pod IP", "Nothing"],
        a: 1, why: "With the shared app name, the second agent would refuse the first hop as a 'loop'. This repo uses A2A_AGENT_ID." },
      { q: "A downstream agent refuses with a JSON-RPC error. What should the user see?",
        opts: ["An empty COMPLETED task", "The refusal reason, surfaced by the calling agent", "A retry loop", "Nothing until timeout"],
        a: 1, why: "ADK otherwise ends the task COMPLETED with no text; surface the reason as the remote agent's answer." },
    ],
  });

  /* ════════════════════════════════════════════════════════════════════
   * Lesson: Testing agents
   * ════════════════════════════════════════════════════════════════════ */
  function frames(text) {
    return text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.startsWith("data:") || l.startsWith("{"); })
      .map(function (l) { return l.replace(/^data:\s?/, ""); });
  }
  function sse(objs) { return objs.map(function (o) { return "data: " + JSON.stringify(o); }).join("\n\n"); }
  function ev(result) { return { jsonrpc: "2.0", id: 1, result: result }; }
  function stU(state, text) { return SPEC.statusUpdate("task-31", "ctx-4", state, text); }
  const SAMPLES = {
    healthy: { label: "Healthy release (this repo)", text: sse([
      ev({ task: SPEC.task("task-31", "ctx-4", "SUBMITTED") }), ev(stU("WORKING")), ev(stU("WORKING", "Compliance scan running")),
      ev({ artifactUpdate: { taskId: "task-31", contextId: "ctx-4", artifact: { artifactId: "art-1", parts: [{ text: "readiness: ok" }] }, lastChunk: true } }),
      ev(stU("INPUT_REQUIRED", "Waiting on human approval for CHG-4D1A")) ]) },
    resurrected: { label: "Cancel resurrected (lab 84)", text: sse([
      ev({ task: SPEC.task("task-31", "ctx-4", "SUBMITTED") }), ev(stU("WORKING")), ev(stU("CANCELED")), ev(stU("INPUT_REQUIRED", "Waiting on human approval")) ]) },
    stuck: { label: "Stuck subscription (lab 84)", text: sse([ ev({ task: SPEC.task("task-31", "ctx-4", "WORKING") }) ]) },
    legacy: { label: "A 0.3 server", text: sse([
      ev({ kind: "task", id: "task-31", contextId: "ctx-4", status: { state: "submitted" } }),
      ev({ kind: "status-update", taskId: "task-31", contextId: "ctx-4", status: { state: "working" }, final: false }),
      ev({ kind: "status-update", taskId: "task-31", contextId: "ctx-4", status: { state: "completed" }, final: true }) ]) },
    broken: { label: "Broken stream", text: sse([
      ev({ task: SPEC.task("task-31", "ctx-4", "SUBMITTED") }),
      ev({ artifactUpdate: { taskId: "task-31", contextId: "ctx-4", artifact: { artifactId: "art-1", parts: [{ text: "part 1" }] }, append: true } }),
      ev(SPEC.statusUpdate("task-99", "ctx-4", "WORKING")),
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32601, message: "x" } } ]) },
  };

  function checkStream(text) {
    const out = [];
    const add = function (tone, name, detail) { out.push({ tone: tone, name: name, detail: detail }); };
    const raw = frames(text);
    if (!raw.length) { add("err", "Any frames at all", "No <code>data:</code> lines or JSON objects found."); return out; }
    const objs = [];
    let parseErr = 0;
    raw.forEach(function (r) { try { objs.push(JSON.parse(r)); } catch (e) { parseErr++; } });
    add(parseErr ? "err" : "ok", "Every frame is JSON", parseErr ? parseErr + " frame(s) do not parse." : objs.length + " frame(s).");
    let rpcBad = 0, both = 0;
    objs.forEach(function (o) { if (o.jsonrpc !== "2.0") rpcBad++; if (o.result !== undefined && o.error !== undefined) both++; });
    add(rpcBad || both ? "err" : "ok", "JSON-RPC 2.0 envelopes", rpcBad ? rpcBad + " frame(s) lack jsonrpc: \"2.0\"." : both ? both + " frame(s) carry both result and error, which JSON-RPC forbids." : "Each frame has exactly one of result or error.");
    const errs = objs.filter(function (o) { return o.error && o.result === undefined; });
    errs.forEach(function (o) {
      const known = SPEC.errors.find(function (e) { return e.code === o.error.code; });
      const std = [-32700, -32600, -32601, -32602, -32603].indexOf(o.error.code) >= 0;
      add(known || std ? "ok" : o.error.code <= -32000 && o.error.code >= -32099 ? "warn" : "err", "Error code " + o.error.code,
        known ? "A2A " + known.name + "." : std ? "A standard JSON-RPC error." : o.error.code <= -32000 && o.error.code >= -32099 ? "Server-defined range: fine, but callers will not know it. Document it, or prefer an A2A code." : "Outside the JSON-RPC ranges.");
    });
    let legacy = 0;
    const events = [];
    objs.forEach(function (o) {
      const r = o.result || {};
      if (r.kind) {
        legacy++;
        const st = (r.status || {}).state;
        events.push({ kind: r.kind, id: r.id || r.taskId, state: st ? st.toUpperCase().replace(/-/g, "_") : null, raw: r });
        return;
      }
      ["task", "statusUpdate", "artifactUpdate", "message"].forEach(function (k) {
        if (r[k]) {
          const b = r[k];
          const st = (b.status || {}).state;
          events.push({ kind: k, id: b.id || b.taskId, state: st ? st.replace("TASK_STATE_", "") : null, raw: b });
        }
      });
    });
    if (legacy) add("warn", "1.0 wire shape", legacy + " frame(s) use the 0.3 <code>kind</code> discriminator and lowercase states. A 1.0 client expects <code>{\"task\": …}</code> / <code>{\"statusUpdate\": …}</code> wrappers and <code>TASK_STATE_*</code>. Check the version you negotiated (<code>A2A-Version</code>).");
    if (!events.length) return out;
    const first = events[0];
    add(first.kind === "task" || first.kind === "message" ? "ok" : "warn", "Stream opens with the Task (or a Message)", first.kind === "task" || first.kind === "message" ? "First event: " + first.kind + "." : "First event is " + first.kind + "; a client that joins here has no task snapshot to build on.");
    const ids = {};
    events.forEach(function (e) { if (e.id) ids[e.id] = true; });
    const idList = Object.keys(ids);
    add(idList.length <= 1 ? "ok" : "err", "One task id throughout", idList.length <= 1 ? (idList[0] || "(message only)") : "Events mention " + idList.join(", ") + ". A stream belongs to one task.");
    const states = events.filter(function (e) { return e.state; }).map(function (e) { return e.state; });
    let after = null;
    states.forEach(function (s, i) { if (after === null && SPEC.terminal.indexOf(s) >= 0 && i < states.length - 1) after = { s: s, next: states[i + 1] }; });
    add(after ? "err" : "ok", "Nothing after a terminal state", after ? "<b>" + after.s + "</b> is followed by <b>" + after.next + "</b>. Terminal states are final (spec §4.1.3); this is the resurrected cancel of the replicas lesson." : states.length ? "States: " + states.join(" → ") : "No states.");
    const last = states[states.length - 1];
    const ends = SPEC.terminal.indexOf(last) >= 0 || SPEC.interrupted.indexOf(last) >= 0;
    add(ends ? "ok" : "warn", "Ends in a terminal or interrupted state", ends ? "Last state " + last + "." : "Last state " + (last || "none") + ". If the stream closed here, the client is left guessing; if it is still open with nothing coming, it is the stuck subscription of the replicas lesson.");
    const arts = {};
    events.filter(function (e) { return e.kind === "artifactUpdate"; }).forEach(function (e) {
      const id = ((e.raw.artifact || {}).artifactId) || "?";
      arts[id] = arts[id] || { last: false, n: 0 };
      arts[id].n++;
      if (e.raw.lastChunk) arts[id].last = true;
    });
    Object.keys(arts).forEach(function (id) {
      add(arts[id].last ? "ok" : "warn", "Artifact " + id + " is closed", arts[id].last ? arts[id].n + " chunk(s), the last with lastChunk." : arts[id].n + " chunk(s), none with lastChunk: a client streaming it into a page never knows it is complete.");
    });
    return out;
  }

  PG.lesson({
    id: "testing",
    track: "production",
    title: "Testing agents",
    short: "Testing",
    thesis: "Test an agent where it can actually break: on the wire, against real HTTP, with the model made deterministic. Assert on protocol behaviour (states, errors, streams) rather than on prose, and put the failure modes you have seen in production into the suite.",
    refs: "Spec §4.1.3 TaskState · §3.2 error codes · §3.1 operations · this repo: tests/, common/fake_llm.py, scripts/*_probe.py",
    brief: `
      <h2>Four layers</h2>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Layer</th><th>What it catches</th><th>How</th></tr></thead>
        <tbody>
          <tr><td><b>Card contract</b></td><td>A card a client cannot use: missing required fields, 0.3 shapes, a skill with no modes</td><td>Lint the card in CI (the <a href="#card">Agent Card workbench</a> runs the same checks)</td></tr>
          <tr><td><b>Wire behaviour</b></td><td>Illegal state transitions, streams that never end, wrong error codes</td><td>Real servers on real ports, driven over HTTP, with a <b>scripted model</b> so every run takes the same path</td></tr>
          <tr><td><b>Conformance</b></td><td>Where your server reads the spec differently from everyone else</td><td>The A2A project's conformance suite (the TCK) against your endpoint, plus an inspector for exploring by hand. Check their repositories for current usage.</td></tr>
          <tr><td><b>Production failure modes</b></td><td>The bugs only scale and failure reveal</td><td>Restarts, replicas, cancels across hops, loops, load: each a test that failed first</td></tr>
        </tbody></table></div>
      <h2>Make the model boring</h2>
      <p>An LLM in the loop makes every protocol test flaky. Replace it with a rule engine that reads the conversation and returns the same tool calls and texts every time. The protocol path (tasks, gates, artifacts, errors) is identical; only the words are canned. Keep a small, separate set of evaluations for the real model's behaviour.</p>
      <h2>Do not mock the hop</h2>
      <p>Card fetching, origin checks, streaming, timeouts and headers all live in the HTTP hop. Start the agents as processes on real ports and talk to them over the wire; mock the network and you test nothing that breaks in production.</p>
      <h2>What to assert</h2>
      <ul>
        <li>Every stream opens with the task and ends in a terminal or interrupted state.</li>
        <li>Nothing follows a terminal state.</li>
        <li>Errors are JSON-RPC errors with the A2A code you documented, never an empty success.</li>
        <li>Cancel is idempotent; a second cancel is not an error you did not expect.</li>
        <li>An unsupported <code>A2A-Version</code> gets <code>VersionNotSupportedError</code>, not a guess.</li>
      </ul>
      <div class="note ours"><span class="note-label">In this repo</span><code>POC_FAKE_LLM=1</code> swaps Gemini for <code>common/fake_llm.py</code>. <code>tests/test_production.py</code> and <code>tests/test_replicas_and_loops.py</code> start the real servers as subprocesses and drive them with the same probes the cluster labs use (<code>scripts/a2a_prod_probe.py</code>, <code>a2a_replica_probe.py</code>, <code>a2a_loop_probe.py</code>), asserting on outcomes such as <code>STUCK</code>, <code>RESURRECTED</code> and <code>Delegation loop</code>. Every production lab began as one of those tests failing.</div>`,
    lab: function (bench) {
      const a = PG.lab(bench, "Check a stream your agent produced", "Lab · stream checker");
      const ta = h("textarea", { class: "code", id: "stream-check", spellcheck: "false", style: { minHeight: "200px" }, "aria-label": "SSE transcript or JSON-RPC frames" });
      const out = h("div", { class: "stack" });
      let pick = "healthy";
      function load(k) { pick = k; ta.value = SAMPLES[k].text; run(); }
      function run() {
        out.innerHTML = "";
        const checks = checkStream(ta.value);
        const bad = checks.filter(function (c) { return c.tone === "err"; }).length;
        const warn = checks.filter(function (c) { return c.tone === "warn"; }).length;
        out.appendChild(h("div", { class: "result " + (bad ? "err" : warn ? "warn" : "ok"), html: bad ? "<b>✗ " + bad + " failure(s)</b>" + (warn ? ", " + warn + " warning(s)" : "") : warn ? "<b>⚠ " + warn + " warning(s)</b>" : "<b>✓ Every check passed.</b>" }));
        out.appendChild(h("div", { class: "table-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["", "Check", "Detail"].map(function (x) { return h("th", { text: x }); }))),
          h("tbody", {}, checks.map(function (c) {
            return h("tr", {}, h("td", {}, h("span", { class: "chip " + c.tone, text: c.tone === "ok" ? "pass" : c.tone === "warn" ? "warn" : "fail" })), h("td", { text: c.name }), h("td", { html: c.detail }));
          })))));
      }
      a.body.append(
        h("p", { class: "small muted", html: "Paste the raw output of <code>curl -N</code> against your agent's <code>SendStreamingMessage</code> or <code>SubscribeToTask</code> (the <code>data:</code> lines), or JSON-RPC frames one per line. Nothing leaves your browser." }),
        h("div", { class: "row" }, PG.seg(Object.keys(SAMPLES).map(function (k) { return { v: k, label: SAMPLES[k].label }; }), pick, load, "Samples")),
        ta,
        h("div", { class: "row" }, btn("Check", "client", run)),
        out);
      ta.addEventListener("input", function () { clearTimeout(ta._t); ta._t = setTimeout(run, 400); });
      load(pick);
    },
    quiz: [
      { q: "Why replace the LLM with a scripted model in protocol tests?",
        opts: ["It is faster to type", "So every run takes the same path through tasks, gates and errors; the protocol, not the prose, is under test", "A2A forbids LLMs in tests", "To avoid streaming"],
        a: 1, why: "Determinism. Evaluate the real model separately." },
      { q: "A stream shows CANCELED followed by INPUT_REQUIRED for the same task. Which rule does it break?",
        opts: ["None", "Terminal states are final", "Streams must start with a Message", "Artifacts must close"],
        a: 1, why: "§4.1.3: once terminal, a task does not change state. This is the replicas lesson's resurrected cancel." },
      { q: "Where should agent-to-agent tests talk to each other?",
        opts: ["Through mocked HTTP clients", "Over real HTTP on real ports, because card fetching, streaming and headers live in the hop", "Through function calls", "Only in production"],
        a: 1, why: "Mock the hop and you test nothing that breaks in production." },
    ],
  });
})();
