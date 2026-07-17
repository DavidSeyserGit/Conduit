# Conduit working conventions

## Issue-driven work

- Work is tracked as GitHub issues under milestones that map 1:1 to release tags (milestone `v0.2.2` → tag `v0.2.2`).
- Each issue gets its **own branch and its own PR** — never batch multiple issues into one PR.
- PRs are squash-merged (linear history on `main`), so each issue lands as exactly one commit on `main`.
- Put `Closes #N` in the squash commit message so GitHub auto-closes the issue with the merge commit hash; no manual closing.
- Reference the issue in discussion with its commit hash after merge (e.g. comment on the milestone or in chat).

## Code review

- PRs are reviewed by Copilot and Kilo Code Review. Wait for their reviews and address every finding before merging: apply valid suggestions, or reply with the reasoning when deliberately not applying one.

## Releases

- Release process, version sources, and signing setup: `docs/releasing.md`.
- `main` requires PRs and green checks (`verify` + `Build Linux desktop bundle`) before merge.
