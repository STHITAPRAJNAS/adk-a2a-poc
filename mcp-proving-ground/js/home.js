/* Home: a live MCP exchange as the hero, then the course map. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h;

  const SCRIPT = [
    ["client", "server", "tools/call", "Call. The model wants rollback_release; the client sends it with the bearer token.", function (st) { st.hold("client", "server", true, "server"); }],
    ["server", "client", "401 · resource_metadata", "Authorize. No valid token yet: the server points at its protected-resource metadata.", function (st) { st.hold("client", "server", false); }],
    ["client", "auth", "authorize · PKCE · resource", "The client signs you in at the authorization server, with PKCE and the server's URI as resource.", null],
    ["auth", "client", "access token", null, null],
    ["client", "server", "tools/call · Bearer", "Call again. Version and capabilities ride in _meta on this request; there is no session.", function (st) { st.hold("client", "server", true, "server"); }],
    ["server", "client", "input_required", "Ask. Rolling back production needs a confirmation, so the server answers input_required with a form and a requestState.", function (st) { st.hold("client", "server", false); }],
    ["client", "user", "confirm rollback?", "The host shows you who is asking and what. You confirm.", null],
    ["user", "client", "accept", null, null],
    ["client", "server", "retry · inputResponses", "Retry. Same call, new id, with your answer and the requestState echoed back unchanged.", function (st) { st.hold("client", "server", true, "server"); }],
    ["server", "api", "own token → deploy API", "The server calls the deploy API with its own credential. Your token never passes through.", null],
    ["api", "server", "rolled back", null, null],
    ["server", "client", "progress 60% · result", "Deliver. Progress arrives on the same response stream, then the result with structuredContent.", function (st) { st.hold("client", "server", false); }],
  ];

  PG.renderHome = function (main) {
    const tok = PG.session;
    const left = h("div", {},
      h("p", { class: "eyebrow", text: "Model Context Protocol · revision 2026-07-28" }),
      h("h1", { html: 'Every MCP concept, <span class="c">on the</span> <span class="s">wire.</span>' }),
      h("p", { class: "lede", text: "Hands-on labs for the stateless MCP: tools, resources and prompts; servers asking for input mid-call; Streamable HTTP and stdio; OAuth; and the attacks that only exist when a model picks the tools. Each lab runs in your browser and shows the exact messages that would cross the network." }),
      h("div", { class: "row cta" },
        h("a", { class: "btn primary", href: "#actors", text: "Start with lesson 1" }),
        h("a", { class: "btn", href: "#stateless", text: "What changed in 2026-07-28" }),
        h("a", { class: "btn", href: "#playground", text: "Jump to the full run" })),
      h("div", { class: "legend-row", "aria-label": "Colour key" },
        h("span", { class: "chip client", text: "host / MCP client" }), h("span", { class: "chip server", text: "MCP server" }),
        h("span", { class: "chip proxy", text: "gateway / proxy" }), h("span", { class: "chip auth", text: "authorization server" }),
        h("span", { class: "chip registry", text: "model / upstream API" })));
    const right = h("div", { class: "stack" });
    main.appendChild(h("section", { class: "hero" }, left, right));

    const stage = PG.stage(right, {
      size: "tall",
      actors: [
        { id: "user", role: "user", label: "You", sub: "operator", x: 12, y: 86 },
        { id: "client", role: "client", label: "Host + client", sub: "ops-console", x: 14, y: 40, glyph: "H" },
        { id: "auth", role: "auth", label: "Auth server", sub: "OAuth 2.1", x: 50, y: 12 },
        { id: "server", role: "server", label: "MCP server", sub: "release-tools", x: 60, y: 62 },
        { id: "api", role: "registry", label: "Deploy API", sub: "upstream", x: 88, y: 30, glyph: "A" },
      ],
      links: [["client", "user"], ["client", "auth"], ["client", "server"], ["server", "api"]],
    });
    let playing = !PG.reducedMotion;
    const toggle = h("button", { class: "btn small", type: "button", text: playing ? "Pause" : "Play the exchange" });
    right.appendChild(h("div", { class: "row" }, toggle, h("span", { class: "small muted", text: "One tool call, looping: authorize → call → ask you → retry → deliver." })));
    toggle.addEventListener("click", function () {
      playing = !playing;
      toggle.textContent = playing ? "Pause" : "Play the exchange";
      if (playing) loop();
    });
    stage.caption("<b>Call.</b> The model wants rollback_release; the client sends it with the bearer token.");
    let running = false;
    async function loop() {
      if (running) return;
      running = true;
      while (playing && PG.alive(tok)) {
        for (const s of SCRIPT) {
          if (!playing || !PG.alive(tok)) break;
          if (s[3]) stage.caption("<b>" + s[3].split(". ")[0] + ".</b> " + s[3].split(". ").slice(1).join(". "));
          await stage.send(s[0], s[1], s[2], { dur: 1000, tone: /401/.test(s[2]) ? "err" : undefined });
          if (s[4] && PG.alive(tok)) s[4](stage);
          await PG.sleep(140);
        }
        await PG.sleep(900);
      }
      running = false;
    }
    if (playing) loop();

    const map = h("section", { class: "home-section" }, h("h2", { text: "The course" }));
    const grid = h("div", { class: "tracks-grid" });
    PG.tracks.forEach(function (t) {
      const ls = PG.lessons.filter(function (l) { return l.track === t.id; });
      grid.appendChild(h("div", { class: "track-card" },
        h("h3", { text: t.title }),
        h("p", { text: t.blurb }),
        h("ol", {}, ls.map(function (l) {
          return h("li", {}, h("a", { href: "#" + l.id, text: l.title }), " ",
            h("span", { class: "dot", "data-dot": l.id, style: { display: "inline-block", verticalAlign: "middle", marginLeft: "4px" }, "aria-hidden": "true" }));
        }))));
    });
    map.appendChild(grid);
    main.appendChild(map);

    main.appendChild(h("section", { class: "home-section" }, h("h2", { text: "How the labs work" }),
      h("div", { class: "grid3" },
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Read" }), h("span", { text: "Each lesson opens with a plain-words summary and the words it uses, then the spec's rules, with section names so you can check the source." })),
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Play" }), h("span", { text: "Labs animate the exchange and log every message in the wire inspector. Click a line to see the HTTP start line, headers and JSON-RPC body." })),
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Check" }), h("span", { text: "A short quiz closes each lesson. Pass it to mark the lesson done; progress stays in this browser." })))));

    main.appendChild(h("section", { class: "home-section" }, h("h2", { text: "Which spec, and what about older servers" }),
      h("div", { class: "grid2" },
        h("div", { class: "note spec" }, h("span", { class: "note-label", text: "Revision 2026-07-28" }),
          h("span", { html: "The labs follow the current revision: no <code>initialize</code>, no sessions, <code>_meta</code> on every request, <code>server/discover</code>, Multi Round-Trip Requests, <code>subscriptions/listen</code>, and required <code>ttlMs</code>/<code>cacheScope</code> on lists." })),
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Legacy era" }),
          h("span", { html: "Most servers in the wild still speak 2025-11-25 or earlier. Where it matters, a lab lets you switch to the legacy behaviour (handshake, <code>Mcp-Session-Id</code>, server-to-client requests) so you can see what changed and why." })))));

    main.appendChild(h("section", { class: "home-section" }, h("h2", { text: "Built alongside this repository" }),
      h("div", { class: "note ours" },
        h("span", { class: "note-label", text: "adk-a2a-poc" }),
        h("span", { html: "The running example, <code>release-tools</code>, offers the release work this repo's <code>deployment_agent</code> does over A2A as MCP tools, resources and prompts instead. The companion <a href=\"../a2a-proving-ground/index.html\">A2A Proving Ground</a> covers agent-to-agent; the last track here compares the two." }))));
  };
})();
