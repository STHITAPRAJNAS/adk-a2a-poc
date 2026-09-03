# Twelve pallets to Milan

Two agents haggle over a freight rate: an opening quote, a counter, a pause for a
human, a re-price that takes twenty minutes, a deal. Every A2A idea worth knowing
shows up somewhere in those six turns — so here they are in order, with what
actually goes over the wire.

Companion to [`a2a-protocol-mechanics.md`](./a2a-protocol-mechanics.md), which
covers the same machinery as reference rather than as a story. A styled version
of this page is in [`a2a-negotiation-walkthrough.html`](./a2a-negotiation-walkthrough.html).

| | |
|---|---|
| **Shipper** — opens the conversation | Acme freight desk agent · `logistics.acme.example` |
| **Carrier** — owns the task | Nordlane booking agent · `booking.nordlane.example` |

---

## Before anything happens

The shipper needs 12 pallets moved Rotterdam → Milan, collected Thursday,
delivered by Friday 18:00. It has found Nordlane's Agent Card and is about to
open a negotiation.

One thing decides the shape of everything that follows: **whoever speaks first is
the client, and the client is the only side that can ever make a call.** Nordlane
will never dial Acme. Not once in this whole negotiation. Every round trip is
Acme reaching out and Nordlane answering — even the turns where Nordlane is
clearly the one with something to say.

> **Hold on to this.** A2A is plain HTTP request/response. There is no channel
> for the server to call the client. So "the carrier gets back to us" is never
> something the carrier does — it is something the shipper arranges. Turn 4 and
> the epilogue are where that stops being a technicality.

---

## Turn 1 · Shipper — opens the task

> "12 pallets, RTM → Milan, pick up Thursday, delivered by Friday 18:00. What's
> your rate?"

```jsonc
// → POST /a2a/booking   message/stream
{ "method": "message/stream",
  "params": { "message": {
    "role": "user",
    // no taskId — this is what opens a new one
    "parts": [ { "kind": "text", "text":
        "12 pallets RTM→MXP, collect Thu, deliver by Fri 18:00. Rate?" } ]
  } } }
```

No `taskId` in the message, so Nordlane **mints one** — along with a `contextId`
that will group every task in this commercial conversation. The task is not one
message. **The task is the whole negotiation.**

**Task state → created**

---

## Turn 2 · Carrier — quotes

Nordlane checks Thursday capacity on the lane, prices it, and comes back:
**€148 per pallet, 2-day transit, quote held 4 hours.**

```jsonc
// ← SSE frames, same HTTP response
{ "kind": "task",          "id": "t-8f3c", "contextId": "c-a19b",
  "status": { "state": "submitted" } }

{ "kind": "status-update", "status": { "state": "working" } }
      // … capacity_check, tariff_lookup — tool calls stream past …

{ "kind": "status-update",
  "status": { "state": "input-required",
    "message": { "role": "agent", "parts": [ { "kind": "text", "text":
      "EUR 148/pallet, 2-day, held 4h. Confirm or counter." } ] } },
  "final": true }                        // ← the stream ends here
```

Nordlane has more to say later, so it does **not** finish the task.
`input-required` is the protocol's way of saying **"your move"** — it is not only
for human approval. And `final: true` closes the HTTP response: Acme's live view
of this task is now gone, though the task itself is very much alive.

**Task state → `input-required`**

---

## Turn 3 · Shipper — counters

Acme counters: **€120 per pallet**, and offers to flex collection to Wednesday if
that helps fill a truck.

```jsonc
// → POST /a2a/booking   message/stream
{ "method": "message/stream",
  "params": { "message": {
    "role": "user",
    "taskId": "t-8f3c",          // ← continues the negotiation
    "contextId": "c-a19b",
    "parts": [ { "kind": "text", "text":
        "EUR 120/pallet. Can flex collection to Wed if it helps." } ]
  } } }
```

The whole counter-offer is **one field**: `taskId`. Omit it and Nordlane opens a
second, unrelated negotiation and quotes €148 all over again, having no idea the
two are connected. This is the single most common A2A integration bug.

**Task state → `working`**

---

## Turn 4 · Carrier — blocks on a human

€120 is below Nordlane's auto-approve floor of €132, so a human has to sign it
off — and that human wants the Wednesday re-price first, which the pricing engine
takes about twenty minutes to produce.

```jsonc
// ← SSE frames: the pause
{ "kind": "status-update", "status": { "state": "working" } }

{ "kind": "status-update",
  "status": { "state": "input-required",
    "message": { "role": "agent", "parts": [ {
      "kind": "data",
      "data": { "id": "fc-4b1e",
                "name": "request_rate_approval",
                "args": { "lane": "RTM-MXP", "offered": 120,
                          "floor": 132, "repricing_for": "Wed" } },
      "metadata": { "adk_type": "function_call",
                    "adk_is_long_running": true }
    } ] } },
  "final": true }
```

Same state as turn 2, **completely different meaning**. There, the message was
text and Acme was expected to reply in words. Here it is a **DataPart** carrying a
function call flagged `adk_is_long_running` — a structured "I am blocked on this
specific thing, and here is its id".

Acme cannot tell these two situations apart from the state alone. It has to read
the parts.

**Task state → `input-required`**

---

## ⏸ Twenty minutes · nothing is happening

**This is the part that trips everyone up.**

It is tempting to picture Nordlane's agent sitting there, waiting for the pricing
engine, ready to tell Acme the moment it lands. That is not what is happening.
When the task parked, **Nordlane's agent finished running** — the process moved
on, nothing is holding the negotiation in memory. There is no coroutine watching
the pricing engine, because there is no coroutine at all.

So two separate things have to be arranged, and people usually only think of the
second:

**1. Something must wake Nordlane.** The pricing engine and the approval UI live
outside the agent. When the human clicks approve, *that system* sends the
decision into Nordlane's own A2A endpoint — same `taskId`, a DataPart answering
`fc-4b1e`. It arrives as an ordinary inbound call, no different from Acme's. The
worker becomes a client of its own agent.

**2. Acme must find out.** Its stream closed twenty minutes ago. Nordlane cannot
ring it. So Acme picks one of three:

| Option | What Acme does | What it costs |
|---|---|---|
| **Poll** | `tasks/get` every minute | Simple, always works, up to a minute stale. Fine here. |
| **Re-attach** | `tasks/resubscribe` and hold it open | Instant. But one held connection per open negotiation, and it dies if *Nordlane* restarts. |
| **Webhook** | register a URL, then hang up entirely | Survives anything. Requires Acme to **be a server** — with TLS, auth, and a public URL. |

Notice what the third option really is: to be told, Acme has to stop being purely
a client. That is why real A2A deployments make **every** agent a server, whether
or not it currently needs to receive anything.

**Task state → still `input-required`**

---

## Turn 5 · Carrier — comes back approved

The re-price lands at €126 cost on the Wednesday truck. Nordlane's pricing
manager approves **€128 per pallet**. The approval system posts that decision into
Nordlane's own endpoint, the agent wakes, and Acme — resubscribed since turn 4 —
watches it happen live.

```jsonc
// approval system → Nordlane's own /a2a/booking   message/send
{ "message": { "role": "user", "taskId": "t-8f3c",
    "parts": [ { "kind": "data",
      "data": { "id": "fc-4b1e",      // answers that exact call
                "name": "request_rate_approval",
                "response": { "approved": true, "rate": 128,
                              "valid_hours": 2, "by": "m.okafor" } },
      "metadata": { "adk_type": "function_response" } } ] } }
```

```jsonc
// ← Acme's held resubscribe stream — no request sent, events just arrive
{ "kind": "status-update", "status": { "state": "working" } }
{ "kind": "status-update",
  "status": { "state": "input-required",
    "message": { "role": "agent", "parts": [ { "kind": "text", "text":
      "EUR 128/pallet on Wed collection, valid 2h. Accept?" } ] } },
  "final": true }
```

Two different parties on two different connections, and neither knows about the
other. The approval system resumed the task; Acme's resubscribed stream received
the consequences. **Whoever moves a task and whoever watches it need not be the
same process** — that is the whole trick, and it is what makes hands-off
hand-offs possible.

**Task state → `input-required`**

---

## Turn 6 · Shipper — accepts

€128 clears Acme's own threshold. It accepts. Nordlane books the truck and closes
the negotiation.

```jsonc
// ← final SSE frames
{ "kind": "artifact-update",
  "artifact": { "name": "booking-confirmation",
    "parts": [ { "kind": "data", "data": {
      "booking_ref": "NL-77213", "rate_eur_per_pallet": 128,
      "collection": "2026-09-09T07:00+02:00", "pallets": 12 } } ] } }

{ "kind": "status-update", "status": { "state": "completed" }, "final": true }
```

The outcome comes back as an **artifact**, not as prose — a structured deliverable
Acme's systems can act on without parsing a sentence. And `completed` is a
**one-way door**: send another message on `t-8f3c` now and it is refused. Further
business means a new task, reusing `contextId: c-a19b` so both sides know it is
the same relationship.

**Task state → `completed`**

---

## Epilogue: the carrier wants to reopen

Wednesday morning, a different customer cancels. Nordlane suddenly has an empty
half-truck on the exact lane and would happily do Acme's pallets at €112 to fill
it. It wants to offer.

**It cannot.** Nordlane has no way to reach Acme. It has been the server all
along; it has never held Acme's address, and A2A gives a server no method to call
a client. The commercially obvious move is protocolically impossible — unless one
of two things was arranged *earlier*:

```
DURING THE NEGOTIATION
  ┌──────────┐   all six turns, one direction   ┌────────────┐
  │  Acme    │ ───────────────────────────────► │  Nordlane  │   Nordlane holds
  └──────────┘                                  └────────────┘   no way back

A · WEBHOOK REGISTERED IN ADVANCE
  ┌──────────────┐ ◄──────────────────────────  ┌────────────┐
  │ Acme hook URL│  POST — but only about an    │  Nordlane  │   no new offers
  └──────────────┘  existing task               └────────────┘

B · ACME ALSO RUNS AN A2A SERVER
  ┌──────────────┐ ◄══════════════════════════  ┌────────────┐
  │  Acme /a2a   │  opens a NEW task —          │  Nordlane  │   same contextId
  └──────────────┘  roles reverse               └────────────┘
```

A webhook only reports on a task that already exists — it cannot carry a fresh
proposal. To make an unprompted offer, Nordlane must become the client of an Acme
that is itself a server, opening a new task and reusing the context id to tie it
to the history.

So genuine two-way business between two agents needs both of them to be servers,
each acting as the other's client whenever it is the one with something to say.
**"Peer" is not a property of an agent in A2A — it is something you get by running
both halves.** That is why both agents in this repository are A2A servers.

---

## The six things to keep

| From turn | What to remember |
|---|---|
| 1 | **A task is a conversation, not a message.** The negotiation gets one task id and keeps it until someone closes it. |
| 3 | **Continuing means sending `taskId`.** Leave it out and you have silently started a second, unrelated negotiation. |
| 2 vs 4 | **`input-required` just means "your move".** Whether that is a question in words or a structured blocked call, you learn from the message parts, not the state. |
| the pause | **A parked agent is not running.** Whatever does the work has to call back into the agent's own endpoint to move the task. Nothing else can. |
| 5 | **Resumer and watcher are different roles.** One party moves the task, another receives the events — which is exactly how unattended hand-offs work. |
| 6 & epilogue | **Terminal is a one-way door, and the server can never dial out.** New business needs a new task, and an unprompted offer needs the other side to be a server too. |

> **One more, free of charge.** Anything the other side may need to act on later
> must be **data in the message** — a booking ref, a quote id, an expiry. Not
> state you are holding in a connection. Connections belong to one hop and die
> with it; a quote id survives a restart, a reconnect and a hand-off to a
> colleague's system.

---

*The freight is invented; the wire shapes are not. Payloads follow the A2A 0.3
JSON-RPC form, and the `adk_type` / `adk_is_long_running` metadata is exactly what
`google-adk 2.8.0` emits on a paused task — captured from the two ADK agents in
this repository talking over `a2a-sdk 1.1.2`. Timings and rates are illustrative.*
