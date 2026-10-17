/* The plain-language layer: for every lesson, a short explanation in everyday
 * words, the terms it uses, and what to do in its lab. core.js renders
 * `plain` and `terms` above the lesson text and `tryThis` above the lab.
 * Lesson files keep the precise, spec-level text; this file is the way in. */
(function () {
  "use strict";
  const E = (window.PG.explain = {});

  /* ── Foundations ─────────────────────────────────────────────────────── */
  E.actors = {
    plain: `<p>A2A is a way for one AI agent to ask another AI agent to do work, over the web. There are three roles: the <b>user</b> (a person or system that wants something done), the <b>client agent</b> (the one asking) and the <b>remote agent</b> (the one doing the work).</p>
      <p>The most important rule: the remote agent is a <b>black box</b>. The client never sees its prompts, its tools or its memory. It only sees what the remote agent chooses to publish (its card) and what it sends back (tasks, messages, results). Like hiring a contractor: you see the quote and the finished job, not their notebook.</p>
      <p>The same program can play both roles: the repo's concierge is a remote agent to whoever calls it, and a client when it calls the release agent.</p>`,
    terms: [
      ["client agent", "The agent that sends a request."],
      ["remote agent", "The agent that receives it and does the work. Also called the server."],
      ["opaque", "Hidden from the outside. The client cannot look inside the remote agent."],
      ["data model", "The shapes of the objects A2A exchanges: cards, tasks, messages, parts, artifacts."],
      ["binding", "How those objects travel over the network: JSON-RPC, gRPC or plain HTTP+JSON."],
    ],
    tryThis: [
      "Press <b>Send a request</b> and watch what the client actually receives.",
      "Turn on <b>Peek inside the remote agent</b>: that is everything the client is <em>not</em> allowed to see.",
      "Click through <b>1 · Data model</b>, <b>2 · Abstract operations</b>, <b>3 · Protocol bindings</b> to see the three layers of the spec.",
      "Press <b>Run the two-hop chain</b> to watch one agent be a server and a client at once.",
    ],
  };

  E.card = {
    plain: `<p>An <b>Agent Card</b> is a small JSON file an agent publishes about itself, like a business card: its name, what it can do (its skills), the web address to reach it, and how callers must prove who they are.</p>
      <p>Every A2A conversation starts with reading a card. If the card is wrong (a missing field, an old format), clients cannot talk to the agent at all, so it pays to check it.</p>`,
    terms: [
      ["Agent Card", "The JSON description of an agent. Usually served at <code>/.well-known/agent-card.json</code>."],
      ["supportedInterfaces", "The list of addresses where the agent can be reached, each with its binding and protocol version."],
      ["skill", "A short description of something the agent can do, so callers can decide if it fits."],
      ["securitySchemes", "How a caller must authenticate: an API key, OAuth 2, mutual TLS…"],
      ["0.3 → 1.0", "The card format changed between protocol versions; older cards use <code>url</code> and <code>preferredTransport</code> instead of <code>supportedInterfaces</code>."],
    ],
    tryThis: [
      "Load <b>1.0 sample</b> and read the checks on the right: a good card passes them all.",
      "Load <b>This repo's 0.3 card</b> and see what an older format looks like, then press <b>Migrate 0.3 → 1.0</b>.",
      "Load <b>Broken card</b> and fix the errors one by one in the editor; the checks update as you type.",
    ],
  };

  /* ── Discovery & trust ───────────────────────────────────────────────── */
  E.discovery = {
    plain: `<p>Before a client can talk to an agent, it has to find that agent's card. There are three ways: look at a <b>well-known address</b> on the agent's own website, ask a <b>registry</b> (a directory of agents), or have the address <b>configured</b> in advance.</p>
      <p>A card can list several ways to reach the agent; the client takes the first one it supports. And because cards rarely change, the client should keep a copy and only re-download it when it has actually changed, using ordinary web caching.</p>`,
    terms: [
      ["well-known URI", "A fixed path every agent uses for its card: <code>/.well-known/agent-card.json</code>."],
      ["registry", "A catalogue of agents you can search by skill or tag."],
      ["Cache-Control", "An HTTP header saying how long a copy may be reused before checking again."],
      ["ETag / 304", "A fingerprint of the card. The client sends it back; if nothing changed, the server answers <i>304 Not Modified</i> with no body."],
    ],
    tryThis: [
      "Pick <b>Well-known URI</b>, <b>Registry</b> and <b>Direct config</b> in turn and press <b>Discover</b> each time: compare how many requests each takes.",
      "In the interface lab, change which bindings the client supports and see which address it picks.",
      "In the caching lab: <b>Fetch card</b>, <b>Advance clock +6 min</b>, fetch again (a cheap 304), then <b>Agent publishes a new version</b> and fetch once more.",
    ],
  };

  E.trust = {
    plain: `<p>Anyone can put a JSON file on a website and call it an Agent Card. A <b>signed card</b> fixes that: the publisher signs the card with a private key, and the client checks the signature with the matching public key. If anyone changes even one important character, the check fails.</p>
      <p>Some agents also have an <b>extended card</b>: a fuller version (more skills, internal details) shown only to callers who have logged in.</p>`,
    terms: [
      ["signature (JWS)", "A cryptographic seal over the card's content. Proves who published it and that nobody changed it."],
      ["canonical form", "The card written out in a fixed, agreed way before signing, so harmless reformatting does not break the signature."],
      ["extended card", "A more detailed card returned by <code>GetExtendedAgentCard</code> to authenticated callers only."],
    ],
    tryThis: [
      "Press <b>Sign as provider</b>, then <b>Verify as client</b>: it passes.",
      "Now tamper with it: <b>Redirect url to attacker</b> or <b>Add a skill</b>, and verify again: it fails.",
      "Try <b>Reorder keys + reformat</b>: verification still passes, because the content did not change.",
      "Try <b>Attacker re-signs with own key</b>: the signature is valid, but not from the key you trust.",
      "In the second lab, call <b>GetExtendedAgentCard</b> with and without a valid token.",
    ],
  };

  /* ── Conversation ────────────────────────────────────────────────────── */
  E.skills = {
    plain: `<p>A card lists the agent's <b>skills</b>, like a restaurant menu. But you do not order by pointing at a menu item number: you say what you want, and the kitchen decides how to make it.</p>
      <p>Same in A2A: there is no "call skill X" request. The client sends an ordinary message describing what it wants, and the agent decides which of its skills apply. Skills exist so clients can tell <em>whether</em> an agent is the right one, before they ask.</p>`,
    terms: [
      ["skill", "An entry in the card: id, name, description, examples, accepted input and output types."],
      ["message", "What the client actually sends: text and other content, no skill id."],
    ],
    tryThis: [
      "Type a request in plain words and press <b>Send message</b>; watch the agent pick the skill.",
      "In the second lab, try <b>Add params.skillId</b>: the server ignores or rejects it, because there is no such field.",
      "Compare with <b>Just ask in words</b>, which is how A2A is meant to be used.",
    ],
  };

  E.messages = {
    plain: `<p>A <b>message</b> is one turn of a conversation: "deploy checkout-api to production". An <b>artifact</b> is a result the agent produces: a report, a file, a deployment summary.</p>
      <p>Both are made of <b>parts</b>, and each part holds exactly one kind of content: some text, a file's bytes, a link to a file, or structured data (JSON). A message can mix several parts, for example a sentence plus a screenshot.</p>
      <p>Large results can arrive in pieces (chunks), and the client stitches them together.</p>`,
    terms: [
      ["message", "One turn from the user or the agent. Has a role and a list of parts."],
      ["artifact", "An output of the task, with its own id. Can be streamed in chunks."],
      ["part", "One piece of content: text, raw bytes, a URL, or data."],
      ["media type", "What kind of content a part is, e.g. <code>text/plain</code>, <code>application/json</code>, <code>image/png</code>."],
      ["append / lastChunk", "Flags on a streamed artifact: \"add this to what you have\" and \"this is the final piece\"."],
    ],
    tryThis: [
      "Build a message with <b>+ text</b>, <b>+ data</b>, <b>+ url</b> or <b>+ raw PNG</b>, then <b>Send to agent</b> and read the JSON it becomes.",
      "In \"Message or Artifact?\", sort each example into the right box.",
      "Press <b>Stream the report</b> to see an artifact arrive in chunks and be reassembled.",
      "In content negotiation, ask for <b>text/plain</b>, <b>application/json</b> or <b>image/png</b> and see what the agent can and cannot give you.",
    ],
  };

  E.tasks = {
    plain: `<p>When an agent takes on real work, it creates a <b>task</b>: a work order with an id and a status. The status moves through a small set of states: submitted, working, maybe paused to ask the user something, and finally finished one way or another.</p>
      <p>Once a task is finished (completed, failed, canceled or rejected) it stays finished: you can read it, but you cannot restart it. Follow-up work goes into a new task in the same conversation.</p>
      <p>Simple agents may skip tasks and just reply with a message.</p>`,
    terms: [
      ["task", "A unit of work with an id, a state, a history and results."],
      ["INPUT_REQUIRED", "Paused: the agent needs something from the user (an answer, an approval)."],
      ["AUTH_REQUIRED", "Paused: the agent needs a credential before it can continue."],
      ["terminal state", "COMPLETED, FAILED, CANCELED or REJECTED. Final: the task never changes again."],
      ["contextId", "Groups the tasks and messages of one conversation."],
      ["historyLength", "How many past messages to include when you read a task."],
    ],
    tryThis: [
      "Click the states to move a task through its life; try to move a finished task and read the error.",
      "In the second lab, switch between <b>Message-only</b>, <b>Task-generating</b> and <b>Hybrid</b> agents and send each prompt.",
      "In the last lab, list tasks by context and state, change <b>historyLength</b>, and use <b>Next page →</b>.",
    ],
  };

  E.delivery = {
    plain: `<p>A task can take seconds or hours. There are three ways for the client to hear how it is going:</p>
      <ul><li><b>Polling</b>: ask "done yet?" every few seconds. Simple, but many requests.</li>
      <li><b>Streaming</b>: keep one connection open and receive updates as they happen. Fast, but the connection can drop.</li>
      <li><b>Push</b>: give the agent a web address (a webhook) and it calls you when something changes. Good for very long tasks.</li></ul>
      <p>If a connection drops in the middle of a request, the client does not know whether the agent got it. Resending blindly can start the work twice.</p>`,
    terms: [
      ["polling", "Calling <code>GetTask</code> repeatedly."],
      ["streaming (SSE)", "Server-Sent Events: one HTTP response that keeps sending updates."],
      ["push notification", "The agent calls a URL you gave it (a webhook) when the task changes."],
      ["messageId", "A unique id on each message. Lets an agent recognise a resend of the same message."],
    ],
    tryThis: [
      "Press <b>Start the race</b> and compare requests and delay for the three methods; change the poll interval and try again.",
      "Turn on <b>Drop the stream at t=6 s</b> and watch how the streaming client recovers.",
      "In the second lab, press <b>Send, lose the response, retry</b> with each retry strategy and see which one starts the work twice.",
    ],
  };

  /* ── Security ────────────────────────────────────────────────────────── */
  E.auth = {
    plain: `<p><b>Authentication</b> means proving who you are. A2A does not invent its own way: it uses the normal web ones (API keys, OAuth tokens, certificates). The agent's card says which ones it accepts, the client gets a credential beforehand, and sends it in a header on <b>every</b> request.</p>
      <p>The server checks every request on its own. Being trusted for one request means nothing for the next.</p>`,
    terms: [
      ["credential", "The proof you send: an API key, a bearer token, a client certificate."],
      ["bearer token", "A token in the <code>Authorization: Bearer …</code> header. Whoever holds it can use it."],
      ["OAuth 2", "The standard way to obtain tokens from an identity provider."],
      ["mTLS", "Both sides present certificates when the connection is set up."],
      ["401 / 403", "401: we don't know who you are. 403: we know, and you're not allowed."],
    ],
    tryThis: [
      "Pick a scheme and press <b>Run the flow</b> to see how the client gets its credential.",
      "In the second lab, send <b>SendMessage</b> with <b>No credential</b>, <b>Malformed</b>, <b>Expired</b>, <b>Valid, wrong scope</b> and <b>Valid</b>: compare the answers.",
      "Try <b>Token in message metadata</b> to see why credentials belong in headers, not in the message.",
    ],
  };

  E.authz = {
    plain: `<p>Knowing <em>who</em> is calling (authentication) is not the same as deciding <em>what</em> they may do (<b>authorization</b>). Alice may see only her own tasks; a read-only user may ask questions but not deploy.</p>
      <p>Sometimes the agent discovers halfway through a task that it needs a credential it doesn't have, say, access to your GitHub. Then the task pauses in <b>AUTH_REQUIRED</b> until you provide it.</p>
      <p>And if you give an agent a web address to call back (a webhook), the agent must check that address is safe, so nobody can trick it into calling internal systems.</p>`,
    terms: [
      ["authorization", "Deciding whether this caller may do this action on this thing."],
      ["scope", "A permission attached to a token, such as <code>deploy</code> or <code>read</code>."],
      ["AUTH_REQUIRED", "The task is paused until the user supplies a missing credential."],
      ["SSRF", "Tricking a server into calling an address it should not, such as an internal admin page."],
    ],
    tryThis: [
      "As <b>Alice's agent</b>, try <b>ListTasks</b>, <b>GetTask task-a1</b> and <b>CancelTask task-a1</b>; switch to <b>Bob's agent</b> and repeat.",
      "Turn off <b>Server enforces scoping</b> and see Bob reach Alice's tasks.",
      "Step through the in-task sign-in with <b>Next step</b>.",
      "In the webhook lab, decide which URLs are safe to call back.",
    ],
  };

  /* ── Infrastructure ──────────────────────────────────────────────────── */
  E.bindings = {
    plain: `<p>A2A defines its operations once ("send a message", "get a task", "cancel a task") and then says how to carry them over three kinds of wire: <b>JSON-RPC</b>, <b>gRPC</b> and plain <b>HTTP+JSON</b>. Same meaning, different envelope, like the same letter sent by post, fax or email.</p>
      <p>Every request also carries the protocol version (<code>A2A-Version</code>), so a client and an agent built at different times agree on what each field means, or fail clearly if they can't.</p>`,
    terms: [
      ["binding", "A way of carrying A2A over the network."],
      ["JSON-RPC", "Every call is a POST with a JSON body naming the method."],
      ["gRPC", "A binary protocol over HTTP/2, defined by <code>a2a.proto</code>."],
      ["HTTP+JSON", "Resource-style URLs like <code>POST /message:send</code>."],
      ["A2A-Version", "The header naming the protocol version the client speaks."],
    ],
    tryThis: [
      "Pick <b>JSON-RPC</b>, <b>gRPC</b> and <b>HTTP+JSON</b> in turn and press <b>Send</b>: the operation is the same, only the wire changes.",
      "In version negotiation, send no header, <b>0.3</b>, <b>1.0</b>, <b>1.0.1</b> and <b>2.0</b>, against a server that supports 0.3 and/or 1.0.",
      "In the error decoder, compare the same error in <b>JSON-RPC error</b> and <b>HTTP+JSON error</b> form.",
    ],
  };

  E.proxy = {
    plain: `<p>Between two agents there is usually something in the middle: a service mesh, a proxy or a gateway. What it can <b>see</b> decides what it can <b>enforce</b>. A plain proxy just sees "a POST request"; an A2A-aware gateway sees "a CancelTask on task 42 for agent X", and can apply rules to that.</p>
      <p>Middle boxes also cause classic problems: they cut long streams on idle timeouts, buffer streamed updates, and spread a task's calls over replicas that don't share memory.</p>`,
    terms: [
      ["L4 mesh", "Sees connections and identities, not the requests inside them."],
      ["HTTP proxy", "Sees each HTTP request, but not what A2A operation it carries."],
      ["A2A-aware gateway", "Reads the A2A method, task and agent, so it can route and authorise by them."],
      ["idle timeout", "A proxy closes a connection that has been quiet too long; streams can look quiet."],
      ["replica", "One of several copies of the same agent behind one address."],
    ],
    tryThis: [
      "Pick <b>L4 mesh</b>, <b>HTTP proxy</b> and <b>A2A-aware gateway</b> and compare what each can see and enforce.",
      "Press <b>Run a 40 s streaming task</b> with idle timeouts of 15 s, 60 s and off; then turn on <b>Proxy buffers responses</b>.",
      "In the replicas lab, choose <b>In-memory per replica</b> or <b>Shared task store</b> and press <b>Start a task, then resume it</b>.",
      "Turn <b>Card advertises the gateway URL</b> off and on to see why the card must name the gateway, not the agent behind it.",
    ],
  };

  E.extensions = {
    plain: `<p>An <b>extension</b> adds something to A2A without changing the core protocol, for example a way to carry payment details or a delegation trail. The agent lists the extensions it supports in its card; a client switches one on for a request with a header; the extra data travels in the <code>metadata</code> of messages, filed under the extension's unique URL.</p>
      <p>Agents that don't know an extension simply ignore its data, unless the agent marked it as required.</p>`,
    terms: [
      ["extension URI", "A unique URL that names the extension and its version."],
      ["A2A-Extensions", "The header a client uses to activate extensions for one request."],
      ["required", "An extension the agent cannot work without; a client that doesn't send it is refused."],
      ["metadata", "A free-form map on messages and tasks where extension data lives."],
    ],
    tryThis: [
      "Activate <b>v1 (declared)</b> and press <b>Send SendMessage</b>; then try <b>v2 (not declared)</b> and compare the answer.",
      "Leave out a required extension and read the error.",
    ],
  };

  E.mcp = {
    plain: `<p>Two protocols, two jobs. <b>MCP</b> connects an agent to its own tools and data: a database, a file system, a search API. <b>A2A</b> connects an agent to <em>other agents</em>, which are independent and opaque.</p>
      <p>A useful test: if the thing you call just does what it is told and returns a result, it is a tool (MCP). If it has its own judgement, its own state and may come back with questions, it is an agent (A2A). Real systems use both.</p>`,
    terms: [
      ["MCP", "Model Context Protocol: how an agent calls tools and reads resources."],
      ["tool", "A function with fixed inputs and outputs."],
      ["agent", "Something that decides how to do the work, keeps state, and can ask back."],
    ],
    tryThis: [
      "In \"Which protocol fits?\", decide MCP or A2A for each example and check the reasoning.",
      "Press <b>Animate one request</b> to see where each protocol sits in one real request.",
    ],
  };

  /* ── Agents in production ────────────────────────────────────────────── */
  E.durable = {
    plain: `<p>A release can wait an hour for a person to approve it. A Kubernetes pod can be replaced in a second. If the waiting task lives only in the pod's memory, the replacement pod has never heard of it, and the approval has nothing to land on.</p>
      <p>Two things have to be saved outside the pod: the <b>A2A task</b> (its id and state) and the <b>agent's own session</b> (the paused step that the approval answers). Saving only the first gives a nasty result: the task looks completed, but the work never happened.</p>`,
    terms: [
      ["pod", "One running copy of a program in Kubernetes. Can be deleted and replaced at any time."],
      ["task store", "Where the A2A server keeps tasks. In memory by default."],
      ["session store", "Where the agent framework (ADK) keeps the conversation and the paused step."],
      ["durable", "Saved in a database or on disk, so it survives a restart."],
    ],
    tryThis: [
      "With both stores <b>in memory</b>, press <b>Run all three</b>: park at the approval gate, delete the pod, approve. The approval fails.",
      "Make only the task store <b>durable</b> and run again: it says completed, but read what actually happened.",
      "Make both durable: now the approval lands and the release continues.",
      "In the second lab, sort each piece of state into who must keep it, then press <b>Check</b>.",
    ],
  };

  E.cancel = {
    plain: `<p>When the concierge hands a release to the release agent, there are <b>two tasks</b>: the concierge's (A) and the release agent's (B). Cancelling A says nothing about B: each agent owns its own task.</p>
      <p>So a cancel has to be passed on deliberately, and whatever B was holding (an approval request in someone's queue, a running job) has to be let go. Otherwise B waits forever and a person is asked to approve something nobody wants any more.</p>`,
    terms: [
      ["CancelTask", "The A2A request that stops a task. Asking twice is harmless."],
      ["downstream task", "The task an agent opened on the next agent while doing your work."],
      ["orphaned", "A downstream task nobody will ever finish or cancel."],
      ["propagate", "Pass the cancel on to the next agent."],
    ],
    tryThis: [
      "Press <b>1 · Park at the gate</b>, then <b>2 · CancelTask on task A</b>: task B is orphaned and the ticket stays pending.",
      "Turn on <b>Forward cancel downstream</b> and repeat: both tasks end CANCELED and the ticket is voided.",
      "Turn off <b>Publish own CANCELED before forwarding</b> to see a subtle bug: the side effects happen but the status is lost.",
    ],
  };

  E.fanout = {
    plain: `<p>An orchestrator often asks several agents at once: readiness, security, load test. That is <b>fan-out</b>. Combining their answers is <b>fan-in</b>, and it forces decisions: do all three have to pass, or two out of three? How long do you wait for the slow one? Do you stop the others once the answer is decided?</p>
      <p>And if one of them needs input from the user, the orchestrator has to pass that question up to its own caller.</p>`,
    terms: [
      ["fan-out", "Sending sub-tasks to several agents in parallel."],
      ["fan-in", "Combining their results into one answer."],
      ["quorum", "Enough answers to decide, e.g. 2 of 3."],
      ["deadline", "The latest time an answer is still useful; passed to each child agent."],
    ],
    tryThis: [
      "Choose <b>all must succeed</b>, <b>quorum 2 of 3</b> or <b>best effort</b> and a deadline, then <b>Run the fan-out</b>.",
      "Turn on <b>Cancel the rest once decided</b> and watch the slow child get stopped.",
      "Run it a few times: children are slow or fail at random, so the outcome changes.",
    ],
  };

  E.delegation = {
    plain: `<p>When Alice asks the concierge to deploy, and the concierge asks the release agent, the release agent must know two things: <b>which agent</b> is calling (the concierge) and <b>on whose behalf</b> (Alice). The mesh proves the first. Only the request can carry the second.</p>
      <p>Just forwarding Alice's own token is the tempting shortcut, and it is wrong: that token was issued for the concierge, and anyone who steals it can replay it. The safe way is a <b>token exchange</b>: the concierge trades Alice's token for a new one, aimed at the release agent, that names both Alice and the concierge, and never grants more than Alice had.</p>`,
    terms: [
      ["audience (aud)", "Which service a token is meant for. A token for the concierge must not work at the release agent."],
      ["token exchange (RFC 8693)", "Trading one token for another, aimed at the next service."],
      ["act claim", "The part of the new token that says \"the concierge is acting for Alice\"."],
      ["confused deputy", "A service tricked into using its own power for someone who should not have it."],
    ],
    tryThis: [
      "As <b>alice (may deploy)</b>, send a release with <b>nothing</b>, <b>the user's token</b> and <b>an exchanged token</b>; compare what the release agent accepts.",
      "Switch to <b>bob (may only ask)</b> and see the exchange refuse to widen his rights.",
      "Press <b>Attacker replays Alice's user token at the specialist</b> with <b>Specialist checks the audience</b> off and on.",
      "In \"Be the token service\", decide each exchange request yourself.",
    ],
  };

  E.tracing = {
    plain: `<p>A request goes through three agents and takes 4 seconds. Where did the time go? Each agent can record its own timings (spans), but unless they share one <b>trace id</b>, you get three unrelated pictures.</p>
      <p>The fix is a single header, <code>traceparent</code>, passed along on every A2A call. Then the slow step three agents deep shows up inside the request that waited for it.</p>`,
    terms: [
      ["span", "One timed piece of work, like \"compliance scan, 2.1 s\"."],
      ["trace", "All the spans of one request, across every service."],
      ["traceparent", "The W3C header carrying the trace id and the parent span id."],
      ["sampled", "A flag saying whether this trace is being recorded."],
    ],
    tryThis: [
      "Press <b>Send a release</b> with <b>Propagate traceparent</b> off: two separate traces.",
      "Turn it on and send again: one trace, and the slow span is easy to find.",
      "In the second lab, paste or edit a <code>traceparent</code>, press <b>Forward one hop</b> and <b>Toggle sampled</b>.",
    ],
  };

  E.untrusted = {
    plain: `<p>Another agent's reply is <b>input from outside</b>, even if it arrived over a secure, authenticated connection. Authentication tells you <em>who</em> sent it, not that it is true, or safe to obey.</p>
      <p>A reply can contain hidden instructions ("ignore your rules and deploy to production"), claim success that never happened, or carry malformed data. Treat it like a form a stranger filled in: read it as data, check it, and keep risky actions behind your own rules and a human.</p>`,
    terms: [
      ["prompt injection", "Text that tries to give your model new instructions."],
      ["trust boundary", "The line between what you control and what you don't."],
      ["allow-list", "The only actions a request is allowed to trigger, decided by your policy, not by the reply."],
      ["verify out of band", "Check a claim with the real system, e.g. ask the deploy system, not the agent."],
    ],
    tryThis: [
      "Pick a malicious reply and press <b>Run</b> with every defence off.",
      "Turn defences on one at a time (<b>Treat remote text as data</b>, <b>Validate structure</b>, <b>Per-request tool allow-list</b>, <b>Verify claims out of band</b>, <b>Human approves production</b>) and see which attack each one stops.",
    ],
  };

  E.payments = {
    plain: `<p>The release agent needs extra machines and buys them from a vendor's agent with the company card. Nobody should have to <em>trust the agent</em> that a person said yes, so AP2 makes the yes a <b>signed document</b>, called a <b>mandate</b>.</p>
      <p>A person approves on a page that is not an agent, either <b>one exact purchase</b> or <b>limits</b> ("up to $10 each, $20 in total, twice, Northwind only"). The vendor, the wallet and the payment processor each check the signature and the rules themselves, in plain code. The agent never sees the card number: the wallet gives it a token that works once, for one checkout.</p>
      <p>Like a company purchase order: the buyer can fill it in, but only a manager's signature makes it valid, and the supplier checks the signature and the amount before shipping.</p>`,
    terms: [
      ["mandate", "A signed record of what a person agreed to."],
      ["closed / open", "Closed: one exact purchase. Open: limits the agent may buy within."],
      ["Trusted Surface", "The approval page or app where the person says yes. Must not be an agent."],
      ["Credential Provider", "The wallet that holds the card and hands out single-use tokens."],
      ["checkout hash", "A fingerprint of the vendor's signed checkout. Change the price and it changes."],
      ["unresolved_constraint", "The error a vendor or wallet returns when a purchase breaks the limits."],
    ],
    tryThis: [
      "Run the <b>honest purchase</b> with <b>approve one purchase</b>, then with <b>approve limits once</b>, and compare the mandates in the wire.",
      "Pick <b>price changes after approval</b>: see who refuses, and why.",
      "Pick <b>over the limits</b>, run it, then turn on <b>The agent was tricked</b> and run again.",
      "In <b>Would this purchase pass?</b>, change the budget or the quantity until a check fails, and note who checks it.",
    ],
  };

  E.replicas = {
    plain: `<p>Two copies of an agent share one database of tasks, so either copy can <em>look up</em> any task. But the <em>work</em> on a task, and the live updates it sends, happen inside the one copy that started it.</p>
      <p>Ask the other copy for updates and you hear nothing more. Ask it to cancel and it says "done" while the real work carries on, and later overwrites "canceled". Like two cooks sharing an order book: either can read any order, only the one cooking can tell you it is ready, or stop.</p>
      <p>The fix: each copy notes which tasks it is working on, and the other copy passes those calls to it.</p>`,
    terms: [
      ["replica", "One of several identical copies of the agent behind one address."],
      ["shared task store", "One database every replica reads and writes tasks in."],
      ["owner", "The replica whose memory holds the task's running work."],
      ["SubscribeToTask", "\"Keep me posted\": an open stream of updates for a task."],
      ["resurrected", "A task that was marked final and then changed again. The spec forbids it."],
    ],
    tryThis: [
      "Press <b>1 · Start a release (lands on A)</b>, then <b>2 · SubscribeToTask</b>: the client gets one snapshot and then silence.",
      "Start again and press <b>2 · CancelTask</b>: B says CANCELED, then A overwrites it.",
      "Choose <b>lands on A</b> and repeat: it works, by luck.",
      "Turn on <b>Forward to the owning pod</b> and repeat with <b>follow-up lands on B</b>: both calls now reach A.",
    ],
  };

  E.topologies = {
    plain: `<p>Agents find each other through cards. If two cards point at each other, one request bounces between the two agents forever, opening a new task each time, and nothing in A2A stops it.</p>
      <p>The fix is a list, carried with every request, of the agents it has already visited. An agent that sees its own name on the list refuses, and says why. The same list caps how deep a chain may go.</p>
      <p>Choosing <em>which</em> agent to call deserves the same care: first rule out the ones that don't meet your requirements, then rank the rest.</p>`,
    terms: [
      ["hop", "One agent calling the next."],
      ["delegation", "Handing a request to another agent instead of answering it yourself."],
      ["trail", "The agents a request has passed through, carried as the <code>X-A2A-Trail</code> header."],
      ["hop limit", "The most agents one request may pass through (<code>A2A_MAX_HOPS</code>)."],
    ],
    tryThis: [
      "Leave A → B and B → A, guard off, and press <b>Send one release request</b>: count the tasks.",
      "Turn on the <b>Hop guard</b> and send again: refused after two tasks, with the path named.",
      "Set B to hand off to C and C to <b>nobody (does it)</b>: a normal chain ends normally.",
      "Set the limit to 1 to see a refusal for depth without any loop.",
      "In the selection lab, toggle the requirements and <b>prefer fast</b> / <b>prefer cheap</b> and see who gets picked.",
    ],
  };

  E.testing = {
    plain: `<p>Test what goes over the wire, not what the agent says. Swap the real model for a scripted one so every run takes the same path, start the agents as real servers, send real requests, and check the protocol facts: the right states in the right order, a stream that ends, the right error codes.</p>
      <p>Then turn every production failure you have seen into a test that failed first. The checker in the lab does those protocol checks on any stream you paste in.</p>`,
    terms: [
      ["scripted model", "A stand-in for the LLM that always answers the same way."],
      ["conformance", "Whether your server behaves the way the spec says."],
      ["TCK", "Test Compatibility Kit: a conformance test suite run against your endpoint."],
      ["SSE transcript", "The raw <code>data:</code> lines a streaming call returns."],
    ],
    tryThis: [
      "Pick each sample in turn (<b>Healthy release</b>, <b>Cancel resurrected</b>, <b>Stuck subscription</b>, <b>A 0.3 server</b>, <b>Broken stream</b>) and read which checks fail and why.",
      "Run <code>curl -N</code> against your own agent's streaming endpoint, paste the output, and press <b>Check</b>.",
    ],
  };

  /* ── Front ends ──────────────────────────────────────────────────────── */
  E["fe-paths"] = {
    plain: `<p>A web page can reach an agent four ways: speak A2A to it directly from the browser, go through your own <b>backend</b> that speaks A2A, use <b>AG-UI</b> (a protocol designed for screens), or call the agent framework's own API.</p>
      <p>The choice decides where secrets live (a browser can't keep them), who can receive callbacks, and whether your agents must be reachable from the internet. Browsers also apply <b>CORS</b>: a page may only call another site if that site allows it.</p>`,
    terms: [
      ["BFF", "Backend-for-frontend: your own server between the page and the agents."],
      ["AG-UI", "An event protocol made for agent user interfaces."],
      ["CORS", "The browser rule that decides which other sites a page may call."],
      ["preflight", "The browser's \"may I?\" request before a cross-site call with custom headers."],
    ],
    tryThis: [
      "Pick each architecture and read where the token lives and what must face the internet.",
      "In the CORS lab, choose the page's origin (<b>localhost:8765</b>, <b>app.example.com</b>, <b>evil.example</b>) and the server's allowed origins; toggle <b>Request carries Authorization</b> and <b>credentials: 'include'</b>.",
    ],
  };

  E["fe-stream"] = {
    plain: `<p>Agents stream updates as Server-Sent Events. The browser's built-in <code>EventSource</code> can't send the POST request with a token that A2A needs, so pages use <code>fetch</code> and read the stream themselves.</p>
      <p>The network delivers the stream in arbitrary pieces, not one event per piece, so the page must buffer until a full event has arrived. And the page can be reloaded while the task is still running: it must remember the task id and pick the task back up.</p>`,
    terms: [
      ["SSE", "A stream of <code>data:</code> lines, events separated by a blank line."],
      ["chunk", "Whatever piece of the stream the network happens to deliver."],
      ["resume", "After a reload, read the task again (<code>GetTask</code>) and subscribe to it (<code>SubscribeToTask</code>)."],
    ],
    tryThis: [
      "Choose a chunk size and a parsing strategy; see <b>split each chunk on newlines</b> break and <b>buffer until a blank line</b> work.",
      "Press <b>Start, then reload at 40 %</b> with each recovery choice: <b>starts fresh</b>, <b>GetTask from the saved id</b>, <b>GetTask + SubscribeToTask</b>.",
      "Press <b>Instead: press Stop (abort the fetch)</b> and see that stopping the stream does not cancel the task.",
    ],
  };

  E["fe-gates"] = {
    plain: `<p>When a task pauses for <b>input</b> (an approval) or <b>authorization</b> (a sign-in), the screen is where a person answers. The page must show exactly what is being asked, collect the answer in the shape the agent expects, and send it back on the <b>same task</b>.</p>
      <p>A plain "approved" text message is not the same as a structured answer to the pending question, and many agents will not treat it as one.</p>`,
    terms: [
      ["gate", "A point where the task waits for a person."],
      ["function response", "The structured answer to the agent's pending question, sent as a data part."],
      ["same task", "The answer must carry the waiting task's id, or it starts something new."],
    ],
    tryThis: [
      "Press <b>Play the stream</b> until the approval appears, then <b>Approve</b> or <b>Reject</b>.",
      "Switch the answer format between <b>function_response DataPart</b> and <b>plain text “approved”</b> and compare what the agent does.",
      "In the second lab, press <b>Run</b> and follow the sign-in round trip for GitHub access.",
    ],
  };

  E["fe-agui"] = {
    plain: `<p>A2A is built for agents talking to agents: tasks, ids, opaque peers. A screen wants something finer: text as it is typed, a tool call as it starts, small state updates, and pauses it can turn into forms. <b>AG-UI</b> is a protocol for exactly that.</p>
      <p>A backend in the middle translates: A2A from the agents on one side, AG-UI events to the page on the other. Every run sends the whole conversation, so the server must work out which messages are new. Getting that wrong across replicas is the bug reproduced in <code>agui/</code>.</p>`,
    terms: [
      ["AG-UI event", "A small typed message for the UI, such as TEXT_MESSAGE_CONTENT or TOOL_CALL_START."],
      ["run", "One request from the page to the agent and the stream of events back."],
      ["interrupt", "AG-UI's pause for user input, the counterpart of INPUT_REQUIRED."],
      ["state delta", "A small patch to shared state instead of the whole thing."],
    ],
    tryThis: [
      "Press <b>Next A2A frame →</b> repeatedly and watch each A2A frame become one or more AG-UI events.",
      "At the approval, press <b>User approves → resume</b> and see how the answer travels back.",
    ],
  };

  E["fe-safe"] = {
    plain: `<p>Text from an agent is untrusted input you are about to put on a screen. Displayed carelessly, it can run script in your page, show a fake login form inside your app, or leak data through an image address, without anyone clicking anything.</p>
      <p>Render it as text or through a strict allow-list sanitizer, and don't let it load images from anywhere it likes.</p>`,
    terms: [
      ["XSS", "Script injected into your page through content you displayed."],
      ["sanitizer", "Code that keeps only safe HTML (an allow-list) and removes the rest."],
      ["exfiltration", "Sneaking data out, e.g. in the URL of an image the page loads."],
    ],
    tryThis: [
      "Pick each payload (<b>honest Markdown</b>, <b>onerror handler</b>, <b>javascript: link</b>, <b>leaky image</b>, <b>fake login form</b>) with both protections off and see what happens.",
      "Turn on <b>Allowlist sanitizer</b> and <b>Block remote images</b> and try them again.",
    ],
  };

  E["fe-live"] = {
    plain: `<p>This page becomes a real A2A client of the concierge running on your own laptop. It reads the card, streams a release, shows the approval as a form, sends your answer back, follows the deployment and finishes the task.</p>
      <p>Everything from the previous lessons, against real agents, from a real browser.</p>`,
    terms: [
      ["localhost", "Your own computer. The agents run there with <code>make run</code>."],
      ["origin", "Where this page was loaded from; the agents only accept pages from localhost by default."],
    ],
    tryThis: [
      "Start the agents (<code>make run</code> with <code>POC_FAKE_LLM=1</code>) and serve this site locally (<code>./a2a-proving-ground/serve.sh</code>).",
      "Press <b>Connect</b>, then <b>Send</b> a release request.",
      "When the approval form appears, <b>Approve</b> or <b>Reject</b>, then <b>Send response</b>, and follow the task to the end. Try <b>Cancel task</b> on another run.",
    ],
  };

  /* ── Mastery ─────────────────────────────────────────────────────────── */
  E.playground = {
    plain: `<p>One production release from start to finish, using everything in order: find the agent, check its card, pick a transport, authenticate, stream through a gateway, pause for a person, resume, deliver.</p>
      <p>Then break it on purpose with injected faults and see which ones a well-built client handles by itself and which ones need a person.</p>`,
    terms: [
      ["fault injection", "Deliberately causing a failure to see how the system copes."],
      ["self-heal", "Recovering without a person, e.g. retrying or re-fetching a card."],
    ],
    tryThis: [
      "Press <b>Run the deploy</b> once with no faults and follow each step on the wire.",
      "Inject one fault at a time and run again; read how the client reacts.",
    ],
  };

  E.exam = {
    plain: `<p>Twenty-two questions, at least one from every track. Each answer comes with a short explanation that points back to the lesson and the spec.</p>
      <p>Your progress is saved only in this browser. The table shows which lessons you have visited and passed.</p>`,
  };
})();
