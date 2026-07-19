# Conduit Goal Specification (CGS)

`@conduit/cgs` is the reference TypeScript implementation of CGS 0.1. CGS is
Conduit's application-independent goal and verification format. It defines
portable JSON artifacts shared by clients, runtimes, reviewers, evidence
collectors, and report renderers; it contains no UI, persistence, provider, or
operating-system behavior.

```ts
import { parseGoalSpecification, serializeCgsArtifact } from "@conduit/cgs";

const goal = parseGoalSpecification(JSON.parse(input));
const canonicalJson = serializeCgsArtifact(goal);
```

All top-level artifacts carry `cgsVersion`, `kind`, a stable string `id`, and
an RFC 3339 timestamp. Parsers reject artifacts that do not implement CGS
0.1. Unknown object fields are retained so a client can round-trip extensions.

The normative prose for this release candidate is under `specs/cgs/0.1/`.
