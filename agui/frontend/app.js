/* A minimal AG-UI client, written the way AG-UI clients work: the page owns the
 * conversation and sends ALL of it on every run (RunAgentInput.messages). That
 * is what makes ag-ui#2603 bite: the server must work out which messages are
 * new, and with ag-ui-adk 0.8.0 each pod only remembers what it processed
 * itself.
 *
 * Routing: nginx (agui/frontend/nginx.conf.template) serves this page and
 * proxies /api/ to the agui-server Service (load-balanced), /api/pod0/ and
 * /api/pod1/ to the two StatefulSet pods by name. Same origin, so no CORS. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const uid = (p) => p + "-" + crypto.randomUUID().slice(0, 8);
  let thread = uid("thread");
  let messages = [];
  let turn = 0;

  function base(route) {
    if (route === "alternate") return turn % 2 === 0 ? "/api/pod0" : "/api/pod1";
    if (route === "pod0") return "/api/pod0";
    if (route === "pod1") return "/api/pod1";
    return "/api";
  }
  function podClass(name) { return /-0$/.test(name) ? "pod0" : /-1$/.test(name) ? "pod1" : ""; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function render() {
    $("thread").textContent = thread;
    const chat = $("chat");
    chat.innerHTML = "";
    messages.forEach((m) => {
      const b = el("div", "msg " + m.role, m.content);
      if (m.via) {
        const v = el("div", "via muted");
        v.append("via ", el("span", podClass(m.via), m.via), " · ag-ui-adk " + (m.version || "?"));
        b.appendChild(v);
      }
      chat.appendChild(b);
    });
    chat.scrollTop = chat.scrollHeight;
  }

  async function runAgent(label) {
    const route = $("route").value;
    const url = base(route);
    const body = { threadId: thread, runId: uid("run"), state: {}, messages: messages.map(({ id, role, content }) => ({ id, role, content })), tools: [], context: [], forwardedProps: {} };
    $("send").disabled = $("reconnect").disabled = true;
    $("status").className = "note info";
    $("status").textContent = label + " → " + url + "/agui with " + body.messages.length + " message(s)…";
    const log = [];
    let served = "?", version = "?", reply = null;
    try {
      const res = await fetch(url + "/agui", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      served = res.headers.get("X-Served-By") || "?";
      version = res.headers.get("X-AG-UI-ADK") || "?";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = (buf + value).replace(/\r\n/g, "\n");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const ev = JSON.parse(data);
          log.push(ev.type + (ev.delta ? "  " + JSON.stringify(ev.delta).slice(0, 70) : ev.message ? "  " + ev.message : ev.toolCallName ? "  " + ev.toolCallName : ""));
          if (ev.type === "TEXT_MESSAGE_START") reply = { id: ev.messageId, role: "assistant", content: "", via: served, version: version };
          if (ev.type === "TEXT_MESSAGE_CONTENT" && reply) reply.content += ev.delta;
          if (ev.type === "TEXT_MESSAGE_END" && reply) { messages.push(reply); reply = null; render(); }
          if (ev.type === "RUN_ERROR") log.push("  ↳ " + ev.message);
        }
      }
      $("status").className = "note info";
      $("status").innerHTML = "";
      $("status").append(label + " served by ", el("span", podClass(served), served), " (ag-ui-adk " + version + ")" + (log.some((l) => l.startsWith("TEXT_MESSAGE_START")) ? "" : " — no new answer"));
    } catch (e) {
      $("status").className = "note err";
      $("status").textContent = label + " failed: " + e.message;
    }
    $("log").textContent = log.join("\n");
    turn++;
    $("send").disabled = $("reconnect").disabled = false;
    await inspect();
  }

  async function inspect() {
    try {
      const res = await fetch("/api/debug/threads/" + encodeURIComponent(thread));
      const s = await res.json();
      const box = $("stored");
      box.innerHTML = "";
      const dups = new Set((s.duplicates || []).map((d) => d.text));
      (s.turns || []).forEach((t) => {
        const d = el("div", t.author === "user" && dups.has(t.text) ? "dup" : "", (t.author === "user" ? "user · " : "agent · ") + t.text);
        box.appendChild(d);
      });
      const v = $("verdict");
      if (!s.exists) { v.className = "note info"; v.textContent = "No session yet."; return; }
      if (s.duplicates && s.duplicates.length) {
        v.className = "note err";
        v.textContent = "DUPLICATE: " + s.duplicates.map((d) => "“" + d.text + "” stored " + d.times + "×").join("; ") + ". A pod that had not processed this question itself treated the re-sent history as new and answered it again (ag-ui#2603).";
      } else {
        v.className = "note ok";
        v.textContent = s.user_turns + " question(s), each stored once (" + s.events + " session events).";
      }
    } catch (e) {
      $("verdict").className = "note err";
      $("verdict").textContent = "Could not read the session: " + e.message;
    }
  }

  $("send").addEventListener("click", () => {
    const text = $("text").value.trim();
    if (!text) return;
    messages.push({ id: uid("u"), role: "user", content: text });
    render();
    $("text").value = turn === 0 ? "Thanks. Is there anything else you can help with?" : "";
    runAgent("Run " + (turn + 1));
  });
  $("reconnect").addEventListener("click", () => runAgent("Reconnect (run " + (turn + 1) + ", nothing new)"));
  $("text").addEventListener("keydown", (e) => { if (e.key === "Enter") $("send").click(); });
  $("new").addEventListener("click", () => { thread = uid("thread"); messages = []; turn = 0; render(); $("stored").innerHTML = ""; $("log").textContent = ""; $("verdict").className = "note info"; $("verdict").textContent = "Nothing yet."; $("text").value = "What can you do?"; });
  render();
})();
