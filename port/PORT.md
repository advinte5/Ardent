# Porting Ardent into the monorepo (`packages/cli`)

This directory is a **ready-to-apply port bundle** for the Ardent engagement layer.
It exists because `free-pi-cli` is a one-way mirror: editing `src/`, `test/`,
`README.md`, `CHANGELOG.md`, or `package.json` here is temporary — the next sync
from the private monorepo overwrites them and refuses to run if it finds hand
edits. The real fix is to land these changes in `dennisonbertram/free-pi` under
`packages/cli`.

The private monorepo is not reachable from the environment that generated this
bundle, so the changes are packaged as a patch instead of committed directly.

## Contents

| File | Purpose |
|---|---|
| `ardent-port.patch` | `git apply`-able diff, paths rooted at `packages/cli/` |
| `MANIFEST.txt` | Every ported file with its post-port sha256 and status |
| `regenerate.sh` | Rebuilds the patch + manifest from the current working tree |

Base commit (the mirror state the patch was generated against):
`d8a2252f0445ad133eb3e70b71fad2dea2b0de81`.

## Apply

From the **monorepo root** (`free-pi/`):

```bash
git checkout -b ardent-phase-2
git apply --index port/ardent-port.patch
```

`git apply` strips the leading `a/`, so the patch writes to `packages/cli/...`
(`packages/cli/src/ardent/*`, `packages/cli/src/paths.ts`,
`packages/cli/src/pi-launch.ts`, `packages/cli/src/onboarding.ts`,
`packages/cli/src/header.ts`, `packages/cli/test/...`, `packages/cli/ARDENT.md`).

If context lines have drifted on `main`, apply with 3-way merge. The mirror keeps
blobs byte-identical, so the base objects resolve:

```bash
git apply -3 port/ardent-port.patch
```

## Verify

From `packages/cli/`:

```bash
./node_modules/.bin/tsc --noEmit
bun test          # or: ./node_modules/@oven/bun-linux-x64/bin/bun test
```

Expected: typecheck clean and **582 tests, 0 fail** (the pre-Ardent baseline was
308; this adds 274). One of those is a live screenshot integration test
(`test/ardent-screenshot.test.ts`) that skips itself when no browser is
installed, so a browserless CI runner reports **581 pass, 1 skip**. The
structural guarantee in `test/no-subagents.test.ts`
still asserts `maxOpen <= 1`, and `test/ardent-subagent-runtime.test.ts` proves
nested subagent completions are serialized.

> `test/ardent-subagent-runtime.test.ts` measures abort latency against a 400 ms
> wall-clock budget. It passes comfortably on its own but can flake when the
> whole suite runs under load; re-run that file alone to confirm.

## Notes

- **No dependency or manifest changes.** `package.json` and the lockfile are
  untouched; Ardent only uses `typebox` and `@earendil-works/pi-coding-agent`,
  both already present.
- **TUI workover (ops console).** The TUI now carries a visual identity. A new
  `src/ardent/theme.ts` builds an in-memory pi `Theme` (graphite + amber) at the
  terminal's exact colour mode and applies it via `ctx.ui.setTheme(instance)` on
  `session_start` — **no theme file and no `~/.pi` writes**, because an existing
  pi install must stay untouched and `resources_discover` fires after
  `session_start`. `ARDENT_THEME=off` opts out. `src/header.ts` is now a grouped
  console header (wordmark, `▸ ENGAGE` / `▸ FREE-PI`), `src/ardent/hud.ts` also
  builds the footer status segment and window title, and new
  `src/ardent/overlay.ts` + `src/ardent/dashboard.ts` add framed full-screen
  modals behind `/posture`, `/findings`, `/scope` and `/sessions`; the HUD has a
  second posture row when the terminal is wide enough; the streaming loader shows
  an Ardent verb; and the recovery nudge renders as a visible warning strip. The
  built-in footer is intentionally not replaced (it carries pwd, context usage and
  the model). `/scope` is read-only: a scope change is an authorization change and
  there is deliberately no silent config writer yet.
- **Refusal handling is prompt + one bounded nudge, never a gate change.**
  `src/ardent/refusal.ts` detects a first-person refusal in the assistant's own
  reply and, at most once per user objective, injects an authorization reminder
  that restarts the turn. It re-authorizes declining anything genuinely out of
  scope and leaves the deterministic scope gate untouched. See `ARDENT.md`,
  “Refusals on authorized work” and “The recovery loop.”
- **New tools in the allowlist.** `spawn_agent` joined `ALLOWED_TOOL_NAMES` in
  `src/pi-launch.ts`. It is gated on an active engagement and is
  `executionMode: "sequential"`, so the no-concurrent-completion guarantee holds.
  `test/no-subagents.test.ts` was updated deliberately to record this one
  exception (every other generic subagent/background tool name stays banned).
- **Screenshot tool + vision enablement.** `ardent_screenshot` (new
  `src/ardent/screenshot.ts`) captures a URL with a host-installed headless
  Chromium, hashes the PNG, and records it as a hashed `Artifact`. Nothing is
  bundled: it uses `$ARDENT_BROWSER` or the first browser found on `PATH`, and
  never passes `--no-sandbox`. It joins `ARDENT_EVIDENCE_TOOL_NAMES`. Separately,
  `src/provider.ts` now declares the provider model's `input` as
  `["text", "image"]` so the model actually receives attached images (the
  blanket form — the catalog exposes no per-model modalities yet).
- **Testing the screenshot path.** No browser is bundled and none is added as a
  dependency. To exercise the live path locally, install a Chromium/Chrome
  however you prefer (e.g. the `google-chrome-stable` `.deb`) or point
  `$ARDENT_BROWSER` at one; the live integration test then runs instead of
  skipping. The tool never passes `--no-sandbox`, so a container running it as
  an unprivileged user needs a working browser sandbox (user namespaces).
- **Server-side unknown remains.** The tests prove the SDK mechanics against a
  stub, not that the real free-pi lease accepts a nested completion while the
  parent is paused. Default subagent depth is 1; parallel workers stay off until
  that is confirmed. See `ARDENT.md`.
- **After landing,** the next mirror sync overwrites the mirrored copies of the
  modified files and adds the new ones; `.mirror-state.json` updates
  automatically. This `port/` directory is not part of the package and can be
  deleted once the patch is applied.
