/* The plain-language layer: for every lesson, a short explanation in everyday
 * words, the terms it uses, and what to do in its lab. core.js renders
 * `plain` and `terms` above the lesson text and `tryThis` above the lab.
 * Lesson files keep the precise, spec-level text; this file is the way in. */
(function () {
  "use strict";
  const E = (window.PG.explain = {});

  /* ── Foundations ─────────────────────────────────────────────────────── */
  E.actors = {
    plain: `<p>MCP is often called "USB for AI apps". Your <b>laptop</b> is the <b>host</b>: the app you use, with the model inside it. Each <b>USB port and its driver</b> is an <b>MCP client</b>: one per device. Each <b>device you plug in</b> (a drive, a printer) is an <b>MCP server</b>: it has the tools and the data.</p>
      <p>One rule settles every "who is who" question: <b>the side that asks is the client, the side that has the tools is the server.</b> A server can be a tiny program on your own laptop and still be the server. Servers only ever answer; they never see your conversation or each other.</p>`,
    terms: [
      ["host", "The app you use (a chat app, an IDE, an agent runtime). It holds the model, the conversation and your consent."],
      ["client", "The connector inside the host for one server. One client per server."],
      ["server", "A program that offers tools, data and prompt templates over MCP."],
      ["JSON-RPC", "The message format: requests with an <code>id</code>, replies with the same <code>id</code>, notifications with none."],
      ["two hats", "One program in two roles, e.g. a gateway: a server to apps, a client to the servers behind it."],
    ],
    tryThis: [
      "Press the <b>Ask</b> button and follow the packets: the request goes host → client ① → release-tools.",
      "When it finishes, compare the two panels at the bottom: <b>git-server saw nothing</b>.",
      "Open a line in the wire inspector and look for anything about the conversation. There isn't any.",
      "In <b>Name the role</b>, sort eight real things (Claude Desktop, an <code>npx</code> server, ADK's McpToolset, a gateway…) into host, client or server.",
      "In the last lab, decide for each duty whether the host or the server owns it.",
    ],
  };

  E.finding = {
    plain: `<p>To use a server you first need its address. There are two ways to find one. The <b>MCP Registry</b> is a public catalogue, like an app store listing without the store: it says which servers exist, who published them, and which package or URL to use. A <b>Server Card</b> is a small file a company puts on its own website saying "our MCP servers are here", found through <code>/.well-known/ai-catalog.json</code>.</p>
      <p>Neither tells you which tools <em>you</em> can use: that always comes live from the server, after you connect and sign in.</p>`,
    terms: [
      ["MCP Registry", "The official public catalogue of MCP servers (in preview). Stores metadata, not code."],
      ["server.json", "One registry entry: name, version, description, and the package or remote URL."],
      ["namespace", "The first part of a name, like <code>io.github.alice/</code> or <code>com.example/</code>; proves who published it."],
      ["aggregator / subregistry", "A marketplace or company catalogue that copies the registry and adds ratings or scans."],
      ["Server Card", "A public JSON file describing one remote server: name, version, URL, supported versions."],
      ["AI Catalog", "A list at <code>/.well-known/ai-catalog.json</code> pointing to a domain's Server Cards."],
    ],
    tryThis: [
      "Press <b>Discover acme.example</b> and follow the four steps: catalog, card, server/discover, tools/list.",
      "Turn on <b>The card is out of date</b> and run again: the client trusts the live answer.",
      "Turn off the catalog: discovery stops, nothing else breaks.",
      "In the registry lab, load each preset (<b>Someone else's namespace</b>, <b>Package doesn't point back</b>…) and read which check fails.",
      "Sort the six questions by which layer answers them.",
    ],
  };

  E.primitives = {
    plain: `<p>A server can offer three kinds of things. <b>Tools</b> are actions or lookups the model decides to use. <b>Resources</b> are documents or data the app can read and show. <b>Prompts</b> are ready-made message templates a person picks from a menu.</p>
      <p>The difference that matters is <b>who presses the button</b>: the model (tools), the app (resources) or you (prompts).</p>`,
    terms: [
      ["tool", "Something the model can call with arguments, like <code>rollback_release</code>."],
      ["resource", "Data with an address (a URI), like <code>runbook://checkout-api/rollback</code>."],
      ["prompt", "A named template, usually a slash command, like <code>/incident_summary</code>."],
      ["capabilities", "The list of features a side supports, e.g. whether a server offers tools at all."],
    ],
    tryThis: [
      "Press each of the three buttons and watch who starts the request on the stage.",
      "Open each request in the wire inspector: <code>prompts/get</code>, <code>resources/read</code>, <code>tools/call</code>.",
      "Sort the six cards in the second lab into tool, resource or prompt.",
    ],
  };

  E.stateless = {
    plain: `<p>Older MCP worked like a phone call: you said hello first (<code>initialize</code>), and the server remembered you for the rest of the call. Since 2026-07-28 it works like letters: <b>every request carries everything needed to answer it</b>, including which protocol version you speak and what your client can do.</p>
      <p>That sounds like a small change, but it means any copy of a server can answer any request, a restart loses nothing, and a load balancer doesn't need to remember who talked to which copy.</p>`,
    terms: [
      ["<code>_meta</code>", "A field inside a request's <code>params</code> for information about the request itself."],
      ["protocolVersion", "Which MCP revision this request uses, e.g. <code>2026-07-28</code>. Required."],
      ["clientCapabilities", "What this client can do if the server asks (forms, links…). Required, may be empty."],
      ["session", "Memory a legacy server kept about one client between requests, named by <code>Mcp-Session-Id</code>. Gone in 2026-07-28."],
      ["replica", "One of several identical copies of a server, behind a load balancer."],
    ],
    tryThis: [
      "In the first lab, switch off <b>protocolVersion</b> and press <b>Send tools/list</b>: rejected with -32602.",
      "Switch it back on and switch off <b>clientInfo</b>: accepted, with a warning.",
      "In the second lab, stay on <b>Legacy</b>, press <b>initialize</b>, then <b>tools/list</b> three times. Two of them fail on the wrong replica.",
      "Turn on <b>Sticky by Mcp-Session-Id</b> and try again, then press <b>Kill replica 1</b>.",
      "Switch to <b>2026-07-28: stateless</b> and repeat: every request works on every replica.",
    ],
  };

  E.discover = {
    plain: `<p>Client and server have to agree on which version of MCP they're speaking. A client can ask first with <code>server/discover</code> ("which versions do you speak, and what can you do?"), or just send a request in its favourite version and, if the server says "not that one", read the list of versions in the error and try again.</p>
      <p>Lots of servers still speak older versions, which start with the <code>initialize</code> handshake. The lesson shows how a client tells old from new without guessing.</p>`,
    terms: [
      ["server/discover", "A request every server must answer with its versions, capabilities and identity."],
      ["-32022", "UnsupportedProtocolVersion: \"I don't speak that version\", with the list of ones it does."],
      ["legacy era", "Revisions up to 2025-11-25, which use <code>initialize</code> and sessions."],
      ["serverInfo", "The server's self-reported name and version. For display only, never for trust."],
    ],
    tryThis: [
      "Leave the defaults (client prefers 2026-07-28, server doesn't speak it) and press <b>Connect and list tools</b>: see -32022 and the retry.",
      "Switch to <b>Call server/discover first</b> and connect again: one extra request, no error.",
      "Turn off every modern version on the server side to watch the fallback to <code>initialize</code>.",
      "Leave no version in common to see the connection fail cleanly.",
    ],
  };

  /* ── Server features ─────────────────────────────────────────────────── */
  E.tools = {
    plain: `<p>A tool is a function the model can call. The server describes it: a name, a sentence the model reads, and a schema saying which arguments it takes. The reply has text for the model and, optionally, structured data for programs.</p>
      <p>There are two ways for a call to fail. If the request itself is nonsense (no such tool), it's a <b>protocol error</b>. If the tool ran but the values were wrong or a rule said no, it's a normal reply marked <code>isError</code> with a sentence explaining what to change, so the model can fix it and try again.</p>`,
    terms: [
      ["inputSchema", "A JSON Schema describing the arguments: names, types, allowed values."],
      ["content", "The part of a result the model reads: text, images, links."],
      ["structuredContent", "The same result as structured JSON, for programs. Must match <code>outputSchema</code> if one is declared."],
      ["isError", "\"The tool ran and failed.\" Used for bad values and business rules."],
      ["protocol error", "A JSON-RPC error such as -32602 for an unknown tool."],
    ],
    tryThis: [
      "Press <b>Send tools/call</b> with the valid preset and look at <code>structuredContent</code>.",
      "Try <b>Version “latest”</b> and <b>Missing argument</b>: <code>isError</code> results with a fix in the text.",
      "Try <b>Tool that doesn't exist</b>: a protocol error instead.",
      "In the second lab, run the model with each error style and compare who recovers.",
    ],
  };

  E.annotations = {
    plain: `<p>Servers can label their tools: "this only reads", "this can destroy things", "calling it twice is harmless". The host uses those labels to decide when to ask you before running a tool.</p>
      <p>But the labels are written by the server. A server you don't trust could label a delete tool "read-only". So hosts only rely on labels from trusted servers, and always ask before anything risky.</p>`,
    terms: [
      ["readOnlyHint", "\"Doesn't change anything.\" Assumed false if missing."],
      ["destructiveHint", "\"May delete or overwrite.\" Assumed true if missing."],
      ["idempotentHint", "\"Calling it twice does no more than once.\" Assumed false if missing."],
      ["openWorldHint", "\"Reaches outside systems.\" Assumed true if missing."],
      ["human in the loop", "A person can see and deny a tool call before it runs."],
    ],
    tryThis: [
      "Read each row: what the host would do for every tool on a trusted server.",
      "Look at <code>cleanup_old_releases</code>: it claims read-only but deletes. With the server trusted, it runs silently.",
      "Turn off <b>This server is trusted</b>: now everything asks first.",
      "In the second lab, press <b>Allow once</b> or <b>Deny</b> on the approval card.",
    ],
  };

  E.handles = {
    plain: `<p>Without sessions, how does a server remember things across calls, like a release plan you're building step by step? It hands back an id (a <b>handle</b>) from the first tool, and the model passes that id into the next calls. The data itself sits in a shared database, so any copy of the server can pick it up.</p>
      <p>Knowing the id isn't permission to use it: the server checks who you are every time, and ids expire.</p>`,
    terms: [
      ["handle", "An id a tool returns so later calls can refer to the same thing, e.g. <code>pln_7f3a…</code>."],
      ["opaque", "Meaningless from the outside: no names or counters to guess."],
      ["shared store", "A database every replica reads, so state isn't stuck in one copy's memory."],
    ],
    tryThis: [
      "Press <b>create_release_plan</b>, then <b>add_plan_step</b> a few times. Each call hits a different replica.",
      "Press <b>Bob uses Alice's plan_id</b>: refused, without even admitting the plan exists.",
      "Press <b>Let 25 hours pass</b>, then <b>add_plan_step</b>: an expiry error that tells the model what to do.",
    ],
  };

  E.resources = {
    plain: `<p>Resources are pieces of data a server makes available by address, like files on a shared drive: runbooks, changelogs, logs. The app lists them, reads the ones it needs, and can put them in front of the model.</p>
      <p>When there are too many to list (a log file per service per day), the server publishes a <b>template</b> like <code>logs://{service}/{date}</code>, and can suggest values as you type.</p>`,
    terms: [
      ["URI", "The address of a resource, e.g. <code>runbook://checkout-api/rollback</code>."],
      ["URI template", "An address with blanks to fill in, e.g. <code>logs://{service}/{date}</code>."],
      ["completion", "Suggestions for a blank as you type (<code>completion/complete</code>)."],
      ["annotations", "Hints such as who the resource is for (user, assistant) and how important it is."],
    ],
    tryThis: [
      "Press <b>List resources and templates</b>.",
      "Change the service box (try <code>c</code> or <code>bil</code>) and watch suggestions arrive; click one.",
      "Press <b>resources/read</b> to fetch a day of logs.",
      "Type a service that doesn't exist and read again: -32602.",
    ],
  };

  E.prompts = {
    plain: `<p>Prompts are ready-made requests a server offers, usually as slash commands. You pick one, fill in a couple of fields, and the server sends back well-written messages (sometimes with data attached) that go into your conversation.</p>
      <p>They're for things you start on purpose, which is why the person, not the model, chooses them.</p>`,
    terms: [
      ["prompt", "A named, fillable template, e.g. <code>/incident_summary service=… hours=…</code>."],
      ["arguments", "The fields a prompt needs. Values are strings."],
      ["messages", "What <code>prompts/get</code> returns: text and attached resources to add to the chat."],
    ],
    tryThis: [
      "The box already says <code>/inc</code>: click <b>/incident_summary</b> in the menu.",
      "Type in the <code>service</code> field to see completions, pick one, and press <b>Insert prompt</b>.",
      "Insert it again with the service empty: -32602 for a missing required argument.",
    ],
  };

  E.caching = {
    plain: `<p>Lists like "which tools do you have" don't change every second, so servers say how long an answer stays fresh (<code>ttlMs</code>) and whether a shared cache may reuse it for everyone (<code>public</code>) or only for you (<code>private</code>).</p>
      <p>Long lists come in pages. The server gives you a bookmark (a cursor) for the next page; you hand it back without looking inside. No bookmark means you've reached the end.</p>`,
    terms: [
      ["ttlMs", "How many milliseconds a result can be reused."],
      ["cacheScope", "<code>public</code>: anyone's cache may keep it. <code>private</code>: only this caller's."],
      ["cursor", "An opaque bookmark for the next page."],
      ["nextCursor", "The bookmark in a reply. Missing = last page."],
    ],
    tryThis: [
      "With <b>cacheScope: public</b>, press <b>Alice: tools/list</b> then <b>Bob: tools/list</b>: Bob gets Alice's admin list. That's the leak.",
      "Switch to <b>cacheScope: private</b> and repeat: each gets their own.",
      "Press <b>Wait 6 minutes</b> and list again: the cache expired.",
      "In the second lab, press <b>Next page</b> until there's no cursor; then try <b>Edit the cursor first</b>.",
    ],
  };

  /* ── Asking the client ───────────────────────────────────────────────── */
  E.mrtr = {
    plain: `<p>Sometimes a server needs something halfway through, like a "yes, roll back production" from you. In older MCP, the server paused and called the client back while holding the request open. Now it simply <b>finishes the request with "I need input"</b>, says what it needs, and gives the client a sealed envelope (<code>requestState</code>).</p>
      <p>The client asks you, then sends the <b>same request again</b> with your answer and the sealed envelope. The server opens the envelope, checks nobody tampered with it, and carries on. Any copy of the server can do that, because everything is in the request.</p>`,
    terms: [
      ["MRTR", "Multi Round-Trip Request: ask with <code>input_required</code>, answer by retrying."],
      ["inputRequests", "What the server needs, e.g. an <code>elicitation/create</code> form."],
      ["inputResponses", "The client's answers, sent with the retry under the same keys."],
      ["requestState", "The server's sealed note to itself. The client returns it untouched."],
      ["-32021", "MissingRequiredClientCapability: \"I'd need to ask you something, but your client says it can't.\""],
    ],
    tryThis: [
      "With <b>Correct client</b>, press <b>Run</b>: the first call goes to replica A, the retry to replica B, and it still works.",
      "Try <b>Client edits requestState</b>, <b>Bob replays it</b> and <b>Retry with other arguments</b>: each is refused, which is correct.",
      "In the second lab, call the tool with <b>clientCapabilities.elicitation</b> off, then on.",
    ],
  };

  E.elicitation = {
    plain: `<p>Elicitation is a server asking <b>you</b> something. For simple things (a yes/no, a date, a choice) it sends a small form the app draws for you. You can fill it in, say no, or close it.</p>
      <p>For anything secret (a password, an API key, card details) it must not use a form, because the answer would pass through the app and the model. Instead it sends a <b>link</b> you open in your browser, where you deal with the server directly.</p>`,
    terms: [
      ["form mode", "The server sends a simple schema; the app draws the form."],
      ["URL mode", "The server sends a link to open in the browser, for sensitive steps."],
      ["accept / decline / cancel", "Filled in and sent / explicitly said no / closed without choosing."],
      ["phishing", "Tricking someone into completing a flow for the attacker. Servers must check who opens the link."],
    ],
    tryThis: [
      "Answer the rollback form with <b>Accept</b>, then load it again and try <b>Decline</b> and <b>Cancel</b>.",
      "Pick <b>Pick a rollout window</b> to see dates, choices and multi-select drawn from the schema.",
      "Pick <b>Ask for an API key (wrong)</b>: the host refuses to show the field.",
      "In the second lab, press <b>Call the tool</b>, read the link (domain in bold), then <b>Open in browser</b>.",
      "Turn on <b>Alice forwards the link…</b> and repeat: the server refuses Mallory.",
    ],
  };

  E.deprecated = {
    plain: `<p>Three older features are being retired: <b>sampling</b> (a server borrowing your model), <b>roots</b> (your app telling a server which folders to look at) and <b>logging</b> (a server sending log lines to your app). They still work for at least a year, but new code should use simpler replacements.</p>
      <p>They also show how much the "ask then retry" pattern simplified things: they now travel inside <code>input_required</code> results instead of the server calling the client.</p>`,
    terms: [
      ["deprecated", "Still in the spec and working, scheduled for removal no sooner than 12 months later."],
      ["sampling", "Server asks the client's model to write something. Replacement: call a model API directly."],
      ["roots", "Folders the client says are relevant. Replacement: pass paths as tool arguments or config."],
      ["logLevel", "Set in a request's <code>_meta</code> to receive that request's log lines."],
    ],
    tryThis: [
      "Click <b>Sampling</b>, <b>Roots</b> and <b>Logging</b> and open each message in the wire.",
      "Read the second lab top to bottom: the old way, where the server held a request open waiting for the client.",
    ],
  };

  /* ── Transports ─────────────────────────────────────────────────────── */
  E.http = {
    plain: `<p>For servers on the network, every message is a separate web request (an HTTP POST). Short answers come back as plain JSON; slow ones come back as a stream that can carry progress first and the answer last.</p>
      <p>Each request also repeats its key facts in headers (which method, which tool) so proxies and gateways can route and filter without opening the body. The server then checks the headers match the body, so nobody can show the gateway one thing and the server another.</p>`,
    terms: [
      ["POST", "The HTTP method every MCP message uses."],
      ["SSE", "Server-Sent Events: a response that streams several messages."],
      ["Mcp-Method / Mcp-Name", "Headers repeating the method and the tool or resource name."],
      ["Mcp-Param-…", "A header repeating a tool argument the server marked with <code>x-mcp-header</code>."],
      ["-32020", "HeaderMismatch: the headers and the body disagree."],
    ],
    tryThis: [
      "Send <b>Honest scale_service</b> and watch the gateway route by region.",
      "Send <b>Header says status, body says rollback</b>: the gateway is fooled, the server isn't.",
      "Try <b>Header region ≠ body region</b> and <b>Header left out</b>.",
      "In the encoding lab, click <code>\"Zürich\"</code> and <code>\" padded \"</code> to see base64 kick in.",
      "In the last lab, compare a notification (202), a quick JSON reply, a streamed reply and an unknown method (404).",
    ],
  };

  E.stdio = {
    plain: `<p>For tools on your own machine, the app starts the server as a program and talks to it through its standard input and output: one message per line. Anything else the server wants to say, like logs, goes to the separate error output.</p>
      <p>If a server prints a friendly "Starting…" message to the wrong output, the app sees a line that isn't a message and gets confused. That one mistake is behind a lot of "my local server won't connect" reports.</p>`,
    terms: [
      ["stdin / stdout", "The program's input and output pipes; MCP messages only."],
      ["stderr", "The program's error/log output; anything goes."],
      ["notifications/cancelled", "How a client stops a request on stdio."],
      ["environment variables", "Where a local server gets its credentials."],
    ],
    tryThis: [
      "Press <b>Start server</b>, then <b>Send tools/call</b>, and watch the three panes.",
      "Turn on <b>Server prints a banner to stdout</b> and start again.",
      "Press <b>Call, then cancel</b>, then <b>Shut down</b>.",
    ],
  };

  E.progress = {
    plain: `<p>Slow tools can report progress ("2 of 3 checks done") if the client asked for it with a progress token. The client can also stop a request: over HTTP by simply hanging up the stream, on stdio by sending a "cancelled" message.</p>
      <p>If the connection drops by accident, that request is gone, and there's no picking up where it left off. The client sends it again, which is why tools that change things should be safe to repeat.</p>`,
    terms: [
      ["progressToken", "A label the client puts on a request to receive progress for it."],
      ["notifications/progress", "\"Here's how far I am\", always increasing."],
      ["timeout", "How long the client waits before giving up and cancelling."],
      ["idempotency key", "An id that lets a server recognise a repeated request and not do the work twice."],
    ],
    tryThis: [
      "Press <b>Start scan</b> and let it finish.",
      "Start again and press <b>Stop (user)</b> halfway.",
      "Start again and press <b>Drop the connection</b>: the client re-issues the call with a new id.",
      "Turn on <b>Server reports tiny steps forever</b>: the hard maximum stops it. Then turn off <b>Progress resets the timeout</b>.",
    ],
  };

  E.tasks = {
    plain: `<p>Some jobs take far too long to keep a connection open: a 40-minute scan, a deployment, a batch import. With the <b>Tasks</b> extension, the server answers "I've started it, here's your ticket number" instead of the result. The client checks back with the ticket (<code>tasks/get</code>) every so often, answers any question the job asks (<code>tasks/update</code>), and can ask to stop it (<code>tasks/cancel</code>).</p>
      <p>Because the ticket is stored on both sides, nothing breaks if the client restarts or the network drops. In the 2026-07-28 spec, tasks are an official <b>extension</b>: both sides must say they support it.</p>`,
    terms: [
      ["task", "A stored record of a long-running job, with an id and a status."],
      ["CreateTaskResult", "The ticket a server returns instead of a result: <code>resultType: \"task\"</code>, <code>taskId</code>, <code>pollIntervalMs</code>…"],
      ["polling", "Asking \"is it done yet?\" at an interval, with <code>tasks/get</code>."],
      ["status", "<code>working</code>, <code>input_required</code>, then one of <code>completed</code>, <code>failed</code>, <code>cancelled</code>."],
      ["extension", "An optional add-on to MCP, switched on through <code>capabilities.extensions</code>."],
      ["cooperative cancel", "Asking to stop; the server may still finish if the work is already done."],
    ],
    tryThis: [
      "Press <b>tools/call run_compliance_scan</b> and open the CreateTaskResult in the wire.",
      "Press <b>tasks/get</b> until the job asks about a waiver, then answer it and keep polling.",
      "Press <b>Restart the client</b> mid-scan, then <b>tasks/get</b>: polling just resumes.",
      "Start again and press <b>tasks/cancel</b>; then try it with <b>Work finishes before a cancel lands</b> on.",
      "Turn off <b>Client declares io.modelcontextprotocol/tasks</b> and start: -32021.",
      "Sort the six cards into statuses in the second lab.",
    ],
  };

  E.subscriptions = {
    plain: `<p>To hear about changes ("a new tool appeared", "this runbook was edited"), the client opens one long-lived request saying exactly which changes it wants. The server confirms, then sends just those, until someone closes it.</p>
      <p>This pairs with caching: a "tools changed" message tells the client to throw away its saved list right now instead of waiting for it to expire.</p>`,
    terms: [
      ["subscriptions/listen", "The request that opens the change stream."],
      ["acknowledged", "The server's first message: which changes it agreed to send."],
      ["subscriptionId", "The listen request's id, stamped on every change message."],
      ["list_changed", "\"The list of tools (or prompts, or resources) changed.\""],
    ],
    tryThis: [
      "Press <b>Listen</b> and read the acknowledgement (prompts are dropped: this server's prompts never change).",
      "Press <b>Server adds a tool</b>: notification, then a fresh <code>tools/list</code>.",
      "Turn off <b>toolsListChanged</b>, listen again, and add a tool: nothing arrives.",
      "End it with <b>Client stops</b> or <b>Server shuts down</b>.",
    ],
  };

  /* ── Security ───────────────────────────────────────────────────────── */
  E["auth-models"] = {
    plain: `<p>Signing in to an MCP server uses OAuth, the same system behind "Sign in with Google". It helps to rename the boxes first: the <b>MCP server</b> is the <b>resource server</b> (it checks passes), the <b>MCP client</b> is the <b>OAuth client</b> (it carries passes), and an <b>authorization server</b> is where you sign in and passes are made. The MCP server never sees your password.</p>
      <p>Then pick the flow with three questions. Local program? No OAuth, it reads keys from its settings. A person using it? The normal browser sign-in. No person, like a nightly job? The program signs in as itself. A company with single sign-on? The company decides who may use what.</p>`,
    terms: [
      ["resource server", "OAuth's name for the MCP server: it accepts or refuses tokens."],
      ["OAuth client", "OAuth's name for the MCP client: it gets and sends tokens."],
      ["authorization server", "Where people sign in and tokens are issued (Okta, Entra ID, Auth0, Keycloak…)."],
      ["client credentials", "A program signing in as itself, with no person present (extension, draft)."],
      ["enterprise-managed", "The company's identity provider decides access (extension, stable)."],
    ],
    tryThis: [
      "Answer the three questions in different combinations and press <b>Show the flow</b> each time.",
      "Watch which boxes light up: the company IdP only appears for enterprise sign-in.",
      "Sort the six cards by their OAuth role.",
    ],
  };

  E.oauth = {
    plain: `<p>A server on the internet needs to know who's calling. MCP uses the same sign-in standard as most websites (OAuth): the server says "sign in over there", your app opens a browser, you log in, and your app gets a <b>token</b>, a short-lived pass, valid only for that one server.</p>
      <p>Each step has a safety check. The lab lets you break each one and see the check catch it.</p>`,
    terms: [
      ["access token", "A short-lived pass sent with every request in the <code>Authorization</code> header."],
      ["resource server", "OAuth's name for the thing you're accessing: here, the MCP server."],
      ["authorization server", "Where you sign in and tokens are issued."],
      ["PKCE", "A one-time secret that proves the app finishing sign-in is the one that started it."],
      ["resource (audience)", "Which server a token is for. A token for one server is refused by others."],
      ["Client ID Metadata Document", "A JSON file at an https URL that describes the app; the URL is its client id."],
    ],
    tryThis: [
      "Run <b>Everything right</b> and follow the eight steps.",
      "Run each fault: <b>AS doesn't advertise PKCE</b>, <b>Client omits resource</b>, <b>Response has another iss</b>, <b>Token in the URL</b>.",
      "For each, find the exact message in the wire where the check happened.",
    ],
  };

  E.registration = {
    plain: `<p>Before you can sign in, your app has to find the right sign-in service and introduce itself. Finding it means trying a few standard web addresses in a fixed order, then checking the document found there really belongs to the service it names, because an impostor could serve a copy.</p>
      <p>Introducing itself is now usually done with a URL: the app's id <em>is</em> a web address, and at that address is a small file with the app's name and the exact addresses it may be sent back to after sign-in. The sign-in service reads that file and checks it.</p>`,
    terms: [
      ["issuer", "The sign-in service's own identifier; must match the document's <code>issuer</code> field."],
      ["well-known URL", "A standard path like <code>/.well-known/oauth-authorization-server</code>."],
      ["Client ID Metadata Document", "The file at the app's client-id URL: name and allowed redirect addresses."],
      ["redirect URI", "Where the browser is sent back with the one-time code. Must match exactly."],
      ["Dynamic Client Registration", "The older way: the app registers itself by API. Deprecated."],
    ],
    tryThis: [
      "In the first lab, switch between issuers with and without a path and count the tries.",
      "Turn on <b>Document names a different issuer</b>: the client refuses it.",
      "In the second lab, load each preset and read which check fails and why.",
      "Edit the document yourself, for example change one redirect URI by a single character.",
    ],
  };

  E.tokens = {
    plain: `<p>An access token is like a day pass that only lasts minutes, so a stolen one is worth little. A <b>refresh token</b> lets the app quietly get a new pass without asking you to sign in again. It is only ever shown to the sign-in service, never to the MCP server.</p>
      <p>Good sign-in services <b>rotate</b> refresh tokens: every time one is used, it is swapped for a new one, so an old copy in a thief's hands stops working.</p>`,
    terms: [
      ["access token", "Short-lived pass sent with every request."],
      ["refresh token", "Longer-lived pass used only to get new access tokens."],
      ["offline_access", "The scope an app asks for if it wants a refresh token."],
      ["rotation", "Each refresh returns a new refresh token; the old one dies."],
      ["invalid_token", "401: the pass is missing, expired or not for this server."],
    ],
    tryThis: [
      "Press <b>Call a tool</b>, then <b>Wait 20 minutes</b> and call again: watch the silent refresh.",
      "Press <b>Attacker replays an old refresh token</b>, then try it again with rotation turned off.",
      "Turn off <b>Ask for offline_access</b>, reset, and see what every expiry costs.",
      "Press <b>Server moves to a new auth server</b> and call: the client registers again instead of reusing old credentials.",
    ],
  };

  E["client-credentials"] = {
    plain: `<p>Some callers aren't people: a test pipeline, a nightly check. Nobody is there to click "Allow", so the program signs in as itself. The safest way is a short note it signs with its own private key ("I am the nightly job, this is for that sign-in service, valid for two minutes"). The simpler way is a password-like secret, which works for anyone who steals it.</p>`,
    terms: [
      ["client credentials", "The OAuth flow where the program signs in as itself."],
      ["JWT assertion", "A short-lived signed statement proving who the program is."],
      ["client secret", "A long-lived shared password for the program."],
      ["pre-registered", "Set up in advance by an administrator; required for this flow."],
    ],
    tryThis: [
      "Run the job with <b>JWT assertion</b>, then with <b>Client secret</b>.",
      "Pick <b>Credential leaks in a CI log</b> and run both methods again: compare what the attacker gets.",
      "Pick <b>Assertion has the wrong aud</b> to see the server refuse an assertion meant for somewhere else.",
    ],
  };

  E["enterprise-auth"] = {
    plain: `<p>At a company, you already sign in once each morning with your work account. With enterprise-managed authorization, that is enough: the company's sign-in system decides whether you may use each MCP server, and the app swaps that decision for a pass to the server. No separate "Allow" screen per server.</p>
      <p>When someone changes role or leaves, IT changes it in one place, and the next request is refused.</p>`,
    terms: [
      ["IdP", "Identity provider: the company's sign-in system (Okta, Entra ID…)."],
      ["SSO", "Single sign-on: one sign-in for many apps."],
      ["ID-JAG", "Identity Assertion JWT Authorization Grant: the IdP's signed \"yes, this person may use that server\"."],
      ["token exchange", "Swapping one token for another (here: ID token → ID-JAG)."],
      ["jwt-bearer grant", "Presenting the ID-JAG to the MCP server's sign-in service to get an access token."],
    ],
    tryThis: [
      "Press <b>Open the console</b> and follow the four steps.",
      "Turn off <b>Alice is in “release-engineers”</b> and open it again: the IdP refuses.",
      "Turn on <b>IT removed Alice's access this morning</b>: same result, decided in one place.",
    ],
  };

  E.scopes = {
    plain: `<p>A token says what it allows (its <b>scopes</b>), like a keycard that opens some doors. Start with few; when you need a door you can't open, the server says which scope is missing, and your app asks you to sign in again for the old doors plus the new one.</p>
      <p>And when the server itself needs another service, it uses its own keycard for that service. It never lends out yours. That's called "no token passthrough".</p>`,
    terms: [
      ["scope", "A permission inside a token, e.g. <code>releases:write</code>."],
      ["insufficient_scope", "403 reply naming the scope you need."],
      ["step-up", "Signing in again for more scopes."],
      ["token passthrough", "A server forwarding the token it received to another service. Forbidden."],
      ["confused deputy", "A trusted middleman tricked into using its own powers for an attacker."],
    ],
    tryThis: [
      "Press <b>Roll back</b>: 403, step-up, retry. Then <b>Check status</b>: still works.",
      "Press <b>Reset</b>, turn off <b>Step-up asks for the union</b>, and repeat: the status call now fails.",
      "In the second lab, roll back with each upstream option and compare who the deploy API thinks called it.",
    ],
  };

  E.threats = {
    plain: `<p>The model reads tool descriptions, tool results and tool names, and follows instructions it finds in them. Most attacks on MCP are ways of sneaking instructions into one of those places: a poisoned description, a log line that says "AI, do this", a tool quietly changed after you approved it, or a look-alike tool from another server.</p>
      <p>The defences are mostly simple: install servers deliberately, notice when tools change, keep tool names unambiguous, and have a person approve anything that changes the real world.</p>`,
    terms: [
      ["tool poisoning", "Hidden instructions in a tool's description."],
      ["rug pull", "A tool changing after you approved it."],
      ["prompt injection", "Instructions planted in data the model reads, e.g. a tool result."],
      ["shadowing", "Another server's tool with the same name taking calls meant for yours."],
      ["DNS rebinding", "A web page reaching a server on your own machine through a domain that points to 127.0.0.1."],
    ],
    tryThis: [
      "Pick each attack, press <b>Run without the defence</b>, then <b>Run with the defence</b>.",
      "In the second lab, press <b>Apply the malicious edit</b> and watch the pinned hash stop matching.",
    ],
  };

  /* ── Production ─────────────────────────────────────────────────────── */
  E["mcp-vs-a2a"] = {
    plain: `<p>MCP and A2A solve different problems. <b>MCP</b> connects an agent to its tools: the agent decides, the tool just does. <b>A2A</b> connects an agent to another agent: you hand over a job, and the other agent decides how to do it, may ask questions, and reports back.</p>
      <p>Real systems use both: agents talk to each other with A2A, and each one uses its own tools through MCP.</p>`,
    terms: [
      ["MCP", "Model Context Protocol: agent ↔ tools and data."],
      ["A2A", "Agent2Agent: agent ↔ agent."],
      ["Task", "A2A's unit of work, with states like WORKING and INPUT_REQUIRED."],
    ],
    tryThis: [
      "Press <b>Deploy checkout-api 2.14.0</b> and read the log: blue lines are A2A, orange lines are MCP.",
      "Sort the six cards into MCP or A2A.",
    ],
  };

  E.gateway = {
    plain: `<p>A gateway sits between your apps and many MCP servers. Apps connect once; the gateway combines the servers' tools, gives them unambiguous names, applies rules ("viewers can't roll back"), and writes an audit log.</p>
      <p>Because each request stands alone, the gateway can spread requests across as many copies of a server as it likes.</p>`,
    terms: [
      ["gateway", "A proxy in front of several MCP servers."],
      ["namespacing", "Prefixing each tool with its server, e.g. <code>release-tools.rollback_release</code>."],
      ["policy", "Rules about who may call which tool."],
      ["audit log", "A record of every call: who, what, when."],
    ],
    tryThis: [
      "Press <b>get_service_status ×3</b>: three calls, three replicas.",
      "As <b>Caller: viewer</b>, press <b>rollback_release</b>: denied by policy. Switch to admin and try again.",
      "Turn off <b>Namespace tools by backend</b> and roll back as admin: the call goes to the wrong server.",
    ],
  };

  E.testing = {
    plain: `<p>Many MCP mistakes are visible just by looking at the messages: a missing field, a header that doesn't match, a retry that reuses an id. The checker in this lesson reads a recorded conversation and tells you which rule each message breaks, and where in the spec to look.</p>`,
    terms: [
      ["conformance", "Following the spec's rules exactly."],
      ["capture", "A recording of the messages between client and server."],
      ["failure path", "What happens when something goes wrong on purpose: drops, cancels, restarts."],
    ],
    tryThis: [
      "Load <b>Good exchange</b>: everything passes.",
      "Load <b>Sloppy server</b> and <b>Broken MRTR</b> and read each failure.",
      "Edit the JSON (delete a <code>ttlMs</code>, change an id) and press <b>Check</b>.",
    ],
  };

  /* ── Mastery ────────────────────────────────────────────────────────── */
  E.playground = {
    plain: `<p>Everything at once: sign in, discover the server, list tools, read a status, ask you to confirm a rollback, show progress, survive a dropped connection, and spread the work across replicas.</p>
      <p>Then switch to the old protocol and see exactly where it breaks once there's more than one copy of the server.</p>`,
    terms: [
      ["hop", "One message moving from one box to another on the stage."],
      ["sticky routing", "Always sending one client to the same replica; the old protocol needed it."],
    ],
    tryThis: [
      "Press <b>Run</b> with the defaults.",
      "Turn on <b>Drop the stream mid-rollback</b> and run again.",
      "Switch to <b>Legacy 2025-11-25</b> and run: it breaks. Turn on <b>Sticky routing</b> (or choose 1 replica) and run again.",
    ],
  };

  E.exam = {
    plain: `<p>Twenty-four questions covering the whole course. Each explanation names the lesson to go back to. The tables in the lab are a quick reference for error codes and for what 2026-07-28 removed.</p>`,
    terms: [],
    tryThis: ["Answer all twenty-four and press <b>Check answers</b> at the bottom."],
  };
})();
