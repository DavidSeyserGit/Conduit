# Conduit 0.3.2

Conduit 0.3.2 fixes goal runs failing while the same reviewer finding remains
open across multiple review rounds.

The goal database now scopes stable finding IDs to their review result instead
of treating them as globally unique. Existing 0.3.1 databases migrate
transactionally on startup without losing prior findings, repeated saves remain
idempotent, and reports retain findings from every review round.
