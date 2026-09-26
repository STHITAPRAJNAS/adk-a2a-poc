/* Home: a live A2A exchange as the hero, then the course map. */
(function () {
  "use strict";
  const PG = window.PG, h = PG.h;

  const SCRIPT = [
    ["client", "registry", "find: skill=deploy", "Discover. The client asks a registry for an agent that can deploy."],
    ["registry", "client", "card URL", null],
    ["client", "gw", "GET agent-card.json", "Fetch the Agent Card and verify its signature."],
    ["gw", "client", "Agent Card ✓", null],
    ["client", "auth", "client_credentials", "Authenticate. The card says OAuth2 client credentials, so get a scoped token."],
    ["auth", "client", "Bearer token", null],
    ["client", "gw", "SendStreamingMessage", "Send. One JSON-RPC call through the A2A-aware gateway."],
    ["gw", "agent", "SendStreamingMessage", null],
    ["agent", "gw", "WORKING", "Stream. Task status arrives as Server-Sent Events."],
    ["gw", "client", "WORKING", null],
    ["agent", "gw", "INPUT_REQUIRED", "Pause. Production needs a human approval."],
    ["gw", "client", "INPUT_REQUIRED", null],
    ["client", "gw", "approve · taskId", "Resume on the same taskId."],
    ["gw", "agent", "approve · taskId", null],
    ["agent", "gw", "artifact · COMPLETED", "Deliver. The rollout report arrives as an Artifact."],
    ["gw", "client", "artifact · COMPLETED", null],
  ];

  PG.renderHome = function (main) {
    const tok = PG.session;
    const left = h("div", {},
      h("p", { class: "eyebrow", text: "Agent2Agent protocol · specification 1.0" }),
      h("h1", { html: 'Every A2A concept, <span class="c">on the</span> <span class="s">wire.</span>' }),
      h("p", { class: "lede", text: "Sixteen hands-on labs for A2A 1.0: agent cards, discovery, skills, tasks, streaming, authentication, gateways and extensions. Each lab runs in your browser and shows the exact requests that would cross the network." }),
      h("div", { class: "row cta" },
        h("a", { class: "btn primary", href: "#actors", text: "Start with lesson 1" }),
        h("a", { class: "btn", href: "#playground", text: "Jump to the full run" }),
        h("a", { class: "btn", href: "#auth", text: "Go to authentication" })),
      h("div", { class: "legend-row", "aria-label": "Colour key" },
        h("span", { class: "chip client", text: "client agent" }), h("span", { class: "chip server", text: "remote agent" }),
        h("span", { class: "chip proxy", text: "gateway / proxy" }), h("span", { class: "chip auth", text: "authorization server" }),
        h("span", { class: "chip registry", text: "registry / store" })));
    const right = h("div", { class: "stack" });
    main.appendChild(h("section", { class: "hero" }, left, right));

    const stage = PG.stage(right, {
      size: "tall",
      actors: [
        { id: "client", role: "client", label: "Client agent", sub: "ops_concierge", x: 11, y: 52 },
        { id: "registry", role: "registry", label: "Registry", sub: "catalog", x: 30, y: 88 },
        { id: "auth", role: "auth", label: "Auth server", sub: "OAuth2", x: 34, y: 13 },
        { id: "gw", role: "proxy", label: "A2A gateway", sub: "agentgateway", x: 56, y: 52 },
        { id: "agent", role: "server", label: "Remote agent", sub: "deployment_agent", x: 89, y: 52 },
      ],
      links: [["client", "registry"], ["client", "auth"], ["client", "gw"], ["gw", "agent"]],
    });
    let playing = !PG.reducedMotion;
    const toggle = h("button", { class: "btn small", type: "button", text: playing ? "Pause" : "Play the exchange" });
    right.appendChild(h("div", { class: "row" }, toggle, h("span", { class: "small muted", text: "A complete deploy, looping: discover → authenticate → stream → pause → resume → deliver." })));
    toggle.addEventListener("click", function () {
      playing = !playing;
      toggle.textContent = playing ? "Pause" : "Play the exchange";
      if (playing) loop();
    });
    stage.caption("Discover. The client asks a registry for an agent that can deploy.");
    let running = false;
    async function loop() {
      if (running) return;
      running = true;
      while (playing && PG.alive(tok)) {
        for (const s of SCRIPT) {
          if (!playing || !PG.alive(tok)) break;
          if (s[3]) stage.caption("<b>" + s[3].split(". ")[0] + ".</b> " + s[3].split(". ").slice(1).join(". "));
          await stage.send(s[0], s[1], s[2], { dur: 1000 });
          await PG.sleep(120);
        }
        await PG.sleep(900);
      }
      running = false;
    }
    if (playing) loop();

    /* course map */
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
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Read" }), h("span", { text: "Each lesson opens with the spec's rules in plain language, with section numbers so you can check the source." })),
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Play" }), h("span", { text: "Labs animate the exchange and log every request in the wire inspector. Click a line to see the HTTP start line, headers and JSON body." })),
        h("div", { class: "note" }, h("span", { class: "note-label", text: "Check" }), h("span", { text: "A short quiz closes each lesson. Pass it to mark the lesson done; progress stays in this browser." })))));

    main.appendChild(h("section", { class: "home-section" }, h("h2", { text: "Built from this repository" }),
      h("div", { class: "note ours" },
        h("span", { class: "note-label", text: "adk-a2a-poc" }),
        h("span", { html: "The running example is this repo's pair of ADK agents: <code>ops_concierge</code> delegates release work to <code>deployment_agent</code> over A2A, with a human approval in the middle. The Kubernetes labs put them behind a mesh (lab 40), an HTTP gateway (lab 50), OPA (lab 55) and agentgateway (lab 60). <code>docs/a2a-conformance.md</code> records how the repo measures up to the 1.0 spec." }))));
  };
})();
