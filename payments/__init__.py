"""Agent payments with AP2 (Agent Payments Protocol, v0.2 / "V2").

A realistic ops purchase: the release agent buys burst compute capacity from a
vendor's agent, either with a person approving the exact checkout (human
present) or on its own within limits a person approved in advance (human not
present). Every AP2 role runs as its own small service:

=========================  ===============================  ======================
AP2 role                   Here                             Module
=========================  ===============================  ======================
Shopping Agent (SA)        the release agent's wallet code  ``payments.shopper``
Merchant (M)               Northwind Compute's sales agent  ``payments.merchant``
                           (an A2A server, AP2 extension
                           required)
Credential Provider (CP)   Acme's corporate-card wallet     ``payments.credential_provider``
Merchant Payment           Northwind's payment processor    ``payments.processor``
Processor (MPP)
Trusted Surface (TS)       Acme's approval page (Trusted    ``payments.trusted_surface``
                           Agent Provider model)
=========================  ===============================  ======================

Mandates, chains, constraints and receipts come from the official AP2 SDK
(``ap2.sdk``, google-agentic-commerce/AP2). This package only adds the roles
around it and the commerce messages, which AP2 leaves to the commerce protocol.
Start them with ``python -m payments.server <role>``.
"""
