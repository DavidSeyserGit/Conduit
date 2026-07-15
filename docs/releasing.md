# GitHub CI/CD and Releases

## Continuous Integration

`.github/workflows/verify.yml` runs for every pull request and push to `main` and
is also reused by the release workflow. It installs from the lockfile and runs:

```bash
pnpm verify
```

In parallel, CI compiles the Rust backend and builds a real Debian installer.
Both gates must pass before any release build begins. Feature branches run once
through their pull request, and tag pushes do not start a second standalone CI
run; the release workflow calls the same CI workflow once.

## Continuous Delivery

`.github/workflows/release.yml` runs when a semantic version tag is pushed. It:

1. Reuses the complete CI verification job.
2. Verifies that the tag matches all four application version sources.
3. Builds Tauri installers for macOS Apple Silicon, macOS Intel, Linux x64, and
   Windows x64.
4. Publishes the installers to a generated GitHub Release with release notes.

The required version sources are:

- `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

`apps/desktop/src-tauri/Cargo.lock` is committed and release builds pass
`--locked`, so GitHub cannot silently resolve different Rust dependencies.

To publish version `0.2.0`, update all four files in a normal pull request, let
CI pass, verify the version locally, then tag the verified commit:

```bash
pnpm release:check -- v0.2.0
```

Publish only after that command succeeds:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Prereleases use tags such as `v0.2.0-beta.1` and are marked as prereleases on
GitHub automatically.

## Signing

macOS artifacts use Tauri's ad-hoc signing identity (`-`) so Apple Silicon builds
are signed without storing an Apple certificate. They are not notarized and may
still require user approval in Privacy & Security. Windows artifacts are built
without a trusted publisher certificate until signing secrets are configured.

For public production distribution, add Apple notarization and Windows signing
credentials using Tauri's official [macOS signing](https://v2.tauri.app/distribute/sign/macos/)
and [Windows signing](https://v2.tauri.app/distribute/sign/windows/) guides; do
not store certificates or passwords in the repository. Tauri's
[GitHub pipeline guide](https://v2.tauri.app/distribute/pipelines/github/) is the
upstream reference for the release matrix and required Linux packages.
