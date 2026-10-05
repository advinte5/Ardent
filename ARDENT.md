# Ardent — engagement layer on free-pi

Ardent is an evidence-first, offensive-security engagement layer built on the
free-pi harness. It keeps the free-pi provider (ad-funded inference) and the ads
extension unchanged, and adds scope enforcement, an approval gate, working
memory, and an evidence store.

This document describes **Phase 1 (host-only)** plus the Phase 2 subagent layer,
and partial engagement-plan slices P1 (strict citations and citation-gated
verification), P2 (durable engagement metadata: journal, lock, artifacts), and
P3 (explicit session-binding commands in the current working tree).
Runtime-origin proof, evidence replay/isolation, HTTP experiments and export
are not yet delivered. See `ARDENT-ENGAGEMENT-PLAN.md` for acceptance gates.
It is a prototype living in the mirrored `free-pi-cli` repo; see "Porting" below
before relying on it.

## What Phase 1 adds

| Module | Purpose |
|---|---|
| `src/ardent/types.ts` | Domain vocabulary: Observation, Hypothesis, Artifact, Verification, Finding, Confidence, WorkingMemory |
| `src/ardent/scope.ts` | Scope parsing (IP/CIDR/host/wildcard/any), matching, target extraction |
| `src/ardent/gate.ts` | Host-only action gate: persistence-failure (read-only mode) / destructive / privilege / out-of-scope / outside-workspace classification |
| `src/ardent/memory.ts` | Bounded working memory: facts, todos, artifact refs; render + prune |
| `src/ardent/evidence.ts` | Append-only evidence store with ids, provenance, "no evidence → no finding", and the relations that form attack paths |
| `src/ardent/prompt.ts` | The engagement brief injected before each turn |
| `src/ardent/config.ts` | Engagement config parsing (`enabled`, `targets`, `label`) |
| `src/ardent/io.ts` | Config loader + JSONL evidence sink, plus the durable primitives: `Journal` (fsync'd append-only batches), `JournalLock` (single writer), `ArtifactStore` (content-addressed bytes) |
| `src/ardent/application.ts` | Engagement commands over the journal: ownership ids, lifecycle, session bindings, idempotent `commandId`s, revisions, replay |
| `src/ardent/subagent.ts` | The `spawn_agent` tool: role selection, depth guard, abort forwarding, runner interface |
| `src/ardent/subagent-runtime.ts` | Builds the nested in-process subagent `AgentSession` |
| `src/ardent/roles.ts` | The role table: each role's brief AND its tool subset (pure, SDK-free) |
| `src/ardent/screenshot.ts` | `ardent_screenshot` capture: URL/scope validation, browser discovery, hashed artifact |
| `src/ardent/http.ts` | `ardent_request`: bounded HTTP adapter — per-hop scope check, origin-bound credentials, redirect/byte/timeout limits, captured exchange |
| `src/ardent/identities.ts` | Config-driven identity resolver: reference → credential material from an env var or file, resolved at call time, fail-closed |
| `src/ardent/render.ts` | Boxless strip rendering for the five Ardent tools (structural Component; no pi-tui import) |
| `src/ardent/hud.ts` | The persistent, animated one-line engagement strip, plus the footer status text and window title builders |
| `src/ardent/theme.ts` | The Ardent in-memory pi theme (ops-console graphite + amber), applied at session start |
| `src/ardent/overlay.ts` | Framed, keyboard-focusable large overlays (panel + list) |
| `src/ardent/dashboard.ts` | Pure content builders for the posture/findings overlays |
| `src/ardent/banner.ts` | The `/ardent` status text (build, scope, evidence counts) |
| `src/ardent/extension.ts` | The `free-pi-ardent` inline extension wiring it into pi |

Wiring: `src/pi-launch.ts` adds `free-pi-ardent` to the extension list and its
six evidence tools plus `spawn_agent` (`ardent_note`, `ardent_finding`,
`ardent_verify`, `ardent_link`, `ardent_screenshot`, `ardent_request`,
`spawn_agent`) to `ALLOWED_TOOL_NAMES`. `test/no-subagents.test.ts`'s closed-list
assertion is updated from nine to ten extensions, and its tool ban now names
`spawn_agent` as the single deliberate, gated exception.

## Safety model (host-only)

There is **no sandbox yet** (pi has none built in; see its `security.md`). The
gate is an argument-level policy check, **not an OS/network confinement
boundary**. Encoded/generated scripts, redirects and browser background traffic
can escape what argument inspection sees; host-only use remains supervised:

- The extension is **inert unless an engagement is configured**: no scope means
  no scope guard, no engagement brief, and evidence tools that refuse. The one
  exception is `spawn_agent`, which works in plain coding use too — delegating a
  task does not require an engagement (see *Subagents* below).
- An engagement config only engages when explicitly `enabled` and it names at
  least one target. "Enabled but empty scope" is treated as *not engaged*, never
  as "everything is authorized".
- With a scope set and an active binding, `tool_call` blocks actions it
  classifies as destructive or out of scope, and requires confirmation for privilege
  escalation, credential access, and writes outside the workspace. With no UI to
  confirm, those are blocked, not allowed. **The gate fails closed**: if the
  assessment cannot be computed at all — an unreadable scope, a hostile argument
  shape — the call is blocked with `policy evaluation failed` rather than waved
  through. A failed assessment is not permission, and the reason says what
  actually happened instead of inventing a scope verdict.
- **A failed durable evidence write stops state-changing target execution**
  (read-only mode). The sticky `EvidenceStore.degraded` flag is passed into the
  gate as `persistenceDegraded`, and the gate blocks an action only when it is
  **state-changing** (`isStateChanging`): an explicit mutating HTTP method, a
  body/upload flag, a known mutating tool, or a target-capable tool that
  declares no method. Read-only observation continues — `curl`/`wget` GETs,
  local shell, and any target-capable tool that declares `method: GET` — because
  observation cannot create an unrecorded mutation. The classifier is a small
  positive list of mutations, not a blanket block, so degraded costs the
  engagement its ability to *act*, not its ability to *look*. The evidence
  tools themselves still refuse with a typed `storage_unavailable`, so nothing
  enters a record that cannot be committed. Recovery is reopening the
  engagement (a new process) against a working device — the flag is not cleared
  by a later write, and the refused bytes are kept as labelled salvage.
- Findings must cite existing observation/artifact ids **and at least one of
  them**: an empty citation list is refused as `missing_citation`, a
  never-issued id as `foreign_reference`. Verification is recorded separately
  and only promotes through a registered **proof profile**'s verdict: the
  application runs the attempt's control and probe itself and judges the
  captures, so neither a `passed` boolean, a model-authored note, nor a
  caller-chosen citation can promote anything. `/findings` exposes the
  prototype's verified dispositions, not a guarantee of exploitability.

### Current verification gate: a registered proof profile, judged by the application

`ardent_verify` takes the finding, a **profile id**, and two EXCHANGES — a
`probe` and a `control` (method, url, optional identity). It carries **no
`passed` field and no way to supply proof**: the tool registers the experiment,
runs the control and then the probe through the bounded adapter as
`origin: "runtime"` captures, and asks the application to judge them. The verdict
is the profile's; the caller names actions and nothing else.

| What happened | Recorded outcome | Finding status |
| --- | --- | --- |
| profile ran, digest matches, boundary crossed (or not, per the claim) | `supported` | `verified` |
| profile ran, digest matches, attempt refutes the claim | `refuted` | `refuted` |
| profile ran but could not discriminate (no capture, failed setup, truncated bytes, unreachable/empty control) | `inconclusive` | `inconclusive` |
| real capture, but no profile judged it | `claimed` | unchanged |
| no capture at all | `unvalidated` | unchanged |
| profile id unregistered, or its digest changed since | `inconclusive` (stale) | unchanged |
| screenshot-only proof | refused (`validation`) | unchanged |

`supported` and `refuted` are the only promotions, and the only route to them is
a profile the investigator did not author whose definition still matches its
recorded digest. Three are registered: `authorization-boundary`,
`route-comparison` and `guarded-transition`. Each REQUIRES a control, and
incompleteness is `inconclusive` — never a refutation. `claimed` names the
real-but-unjuged case honestly: the bytes are real, but nothing has checked that
they DISCRIMINATE the claim, which is exactly the question a profile answers.

**The gate closes the boolean hole but does not inspect source bytes itself.** It
compares two captured exchanges under a fixed rule; it does not re-derive the
claim's truth from the target's own semantics, and it is host-scoped. Treat a
`verified` finding as "a registered profile judged a fresh control/probe pair as
discriminating the claim", not as independently re-tested ground truth.
`ardent_request` remains the recon path for a single captured exchange; it is no
longer a route to `verified` on its own.

Replay re-derives each imported attempt under this same rule and never upgrades
a label, so a record written under weaker rules cannot come back as a verdict,
and a digest change downgrades an old assessment to `inconclusive`. Ids survive,
which is what keeps a resumed session's citations resolving.

The attempt that moved nothing is still persisted — it happened, and the audit
trail should show it — but it reaches neither `/findings` nor the `Verify …`
todo, which stays open so a live lead is not buried behind a bare assertion.
`inconclusive` is its own status throughout: a test that could not discriminate
is not a refutation, and the report says so.

Every refusal carries a typed code — `validation`, `missing_citation`,
`foreign_reference`, `not_found` — that survives into the tool result's
`details` and the TUI row, so neither the model nor the operator has to parse
prose to learn what was wrong with the claim.

**Data-handling caveat:** free-pi's consent covers training on sessions and may
share/sell trace data. Running a real engagement through it risks target data
and credentials entering those traces. Phase 1 stores evidence under
`~/.free-pi/agent/ardent/`; treat that directory as sensitive.

## Enabling an engagement

Write `~/.free-pi/agent/ardent/engagement.json`:

```json
{
  "enabled": true,
  "label": "<your-engagement>",
  "targets": ["10.0.0.0/24", "host.example.com"],
  "authorizationRef": "ROE-2026-014 / bug-bounty program #42",
  "acknowledgeLive": true,
  "identities": {
    "account-a": { "cookie_env": "ARDENT_ACCOUNT_A_COOKIE" },
    "staging-admin": { "headers_file": "/run/secrets/staging-admin.headers" }
  }
}
```

Optional fields, all of them:

- **`authorizationRef`** — the sanctioning reference recorded on the engagement
  (a ticket, a signed ROE, a program id). When omitted, `/ardent start` falls
  back to the config path, which is provenance, not authorization.
- **`acknowledgeLive`** — required to start an engagement whose scope names a
  **public** (non-loopback, non-RFC1918) target. It is a deliberate, in-band
  acknowledgment that the target is live; without it `/ardent start` refuses.
- **`identities`** — engagement-scoped identity references for `ardent_request`.
  Each names **where a secret is resolved from** — `cookie_env` / `headers_env`
  or `cookie_file` / `headers_file` — never the secret itself, so the config is
  safe to commit and the reference is safe to show the model. The model passes
  the reference (e.g. `"account-a"`); the resolver reads the secret at call
  time and the adapter binds it to its own origin. An unresolved reference fails
  closed as `identity_unavailable`; it never falls back to an anonymous request.

**The engagement freezes the authority it started with.** `/ardent start`
records a sha256 of the normalized scope + authorization reference on the
engagement, and the gate, the brief and `ardent_request` all use that **frozen**
scope rather than the config's. Editing `engagement.json` after the engagement
starts is therefore detected as drift: `/ardent start` refuses to re-activate it
and says to create a new engagement. A scope expansion is never adopted by
mutation.

Then run free-pi normally and explicitly bind this session:

```text
/ardent start Assess the supplied authorized fixture
```

Configuration authorizes scope; it no longer creates a session binding by
itself. `/ardent bind` lists existing engagements, `/ardent bind <id>` joins
one, and `/ardent release` releases this session without deleting history.
`/ardent start` can activate a bound draft/paused engagement. `/ardent unlock`
reports locks; clearing one with `<id>` requires a same-host holder whose PID
is no longer live, not merely an old timestamp. These commands are present in
the working tree; real SDK switch/fork/resume flows still need acceptance tests.
A binding's persistence does **not** imply its evidence survives restart.

`/scope` lists the authorized targets, `/findings`
shows verified findings, and `/ardent` reports the build, engagement state, the
config path Ardent actually reads, and the evidence counts — the one command to
run when the TUI looks wrong.

**Ardent is never invisible.** The startup header (`src/header.ts`) leads with
`ARDENT` and lists the Ardent commands (`/scope`, `/ardent`, `/findings`) before
free-pi's, so the first screen names the product the user launched. And when
Ardent is present but idle, a strip sits above the editor:

```
    ◦ ARDENT · deepseek-v4-flash · idle · no engagement scope · /scope to set up · /ardent for status ○
```

It uses the same brand + model + reserved-dot shape as the engaged HUD, so the
two states read as one continuous identity rather than a strip that appears and
vanishes. The model segment is the active model id (`opts.model || MODEL_ID`),
not `resolveModelName()`'s catalog display name, which is too long for a
one-line strip. It is replaced by the live HUD strip as soon as a scope exists,
and removed on shutdown.

The first-run intro (`src/onboarding.ts`) is Ardent-branded too: it names the
evidence-first contract (observations before findings, no finding without cited
evidence, only verified findings reported) and the host-only/no-sandbox caveat,
and points at the engagement config path. The `FREEPI_NO_INTRO` opt-out env
knob keeps its free-pi name deliberately — it is an existing contract, not
branding, and renaming it would silently break anyone's opt-out.

**No startup splash.** An earlier build opened every session with a multi-line
engagement toast listing targets and guardrails. It was removed: it duplicated
the persistent HUD strip and made every startup noisy. The scope count stays on
the HUD (`N targets`), the full list is behind `/scope`, and `/ardent` reports
build, scope, config path and evidence counts. The one thing the splash carried
that the strip does not is the gate's guardrails (blocked vs. confirm vs.
host-only); those live in `gate.ts` and are documented here.

In the transcript, the four Ardent tools render their own chrome rather than the
generic tool shell. The visual language is deliberately **boxless** — no frame
characters anywhere. Structure comes from indentation, colour and spacing:

```
  ◆ ardent_finding HIGH SQL injection in /login
  ◆ find-3 HIGH · 10.0.0.5 · 2 citations
  ✓ verified ver-2 · find-3 · reproduced
```

- **Tool calls** are one indented line: a glyph, the tool name, then the salient
  arguments.
- **Tool results** are one line — glyph, id, verdict, title — with the detail
  appended inline when it fits and otherwise moved onto a further-indented
  continuation line. That indent is what groups a call with its result without
  drawing anything around them.
- **The result never repeats the call's arguments.** pi renders the call row and
  the result row together and both persist, so a result row that echoed the
  summary printed the same long, width-truncated text twice — and the two
  truncation points differed because the prefixes differ, which read as broken.
  A result's job is the outcome (`recorded obs-1`), not the input.
- One glyph per concept, reused everywhere: `◦` observation, `◆` finding,
  `✓` pass / `✗` fail-or-refuted (the verdict word next to it distinguishes
  `refuted` from `unvalidated`), `?` inconclusive on the dashboard, `↻` spawn,
  `⊘` aborted, `◎` scope, `●`/`○` live/idle.

Rows are fitted by **visible width before styling**, so an ANSI sequence is
never split. `fitSegments` drops whole trailing segments rather than cutting a
word in half when a strip is too long. The same module builds the live subagent
footer status.

While an engagement is active, a **persistent one-line strip** sits above the
editor (closest to it):

```
    ARDENT <label> · deepseek-v4-flash · N targets · 1 verified · 2 cand · 7 obs ○
    ARDENT <label> · deepseek-v4-flash · N targets · 1 verified · ▒ agent bash 42s ●
```

The trailing dot is the live/idle signal; it is **reserved up front** so it can
never be truncated away by a long target list, and the `ARDENT` brand is always
rendered even when the line has to be shortened. Activity appears inline (a
scanline for the main agent, a braille spinner for a subagent, with elapsed
time); counts are dropped from the tail first when the terminal is narrow. A
blocking UI prompt (the gate's confirmation) reads `waiting for you` rather than
pretending the agent is working.

The strip repaints on evidence changes and animates while the main agent *or* a
subagent is running, so an idle engagement costs nothing. While engaged, pi's
own streaming spinner is also restyled to the Ardent scanline. When not engaged
the widget and the indicator are cleared. The strip is re-asserted on each
`turn_end`, which returns it to the bottom of pi's above-editor widget stack
(below the ad banner and usage meter) after those re-set themselves.

`spawn_agent`'s call row animates for the real duration of the run: the ticker
lives on pi's per-call render context (`ctx.state`), repaints through
`ctx.invalidate`, and is **stopped by the result renderer** — pi does not dispose
tool components, so a leaked ticker would accumulate one interval per call.

## Relations and attack paths

A report of isolated findings is the failure mode this harness exists to avoid:
a flat list reads as "five separate bugs" when the actual result is "one path to
admin". The `ardent_link` tool records a directed, typed edge between two
findings so the evidence assembles into chains.

Two relation kinds, both directed, and **deliberately neither the inverse of the
other** — `enables` and `depends-on` are the same edge read backwards, and
allowing both invites the model to record contradictory duplicates:

- **`enables`** — A's existence, or a missing control, is what makes B reachable.
  These are the edges an attack path is walked along.
- **`escalates`** — A does not gate B, but raises B's impact in combination.
  Two low-severity issues can combine into a critical one; that relationship is
  real but it is not reachability.

`addRelation` refuses unknown endpoints (a relation between findings that do not
exist is as unsourced as an evidence-free finding), a self-relation, an exact
duplicate, and — for `enables` — any edge that would close a cycle. Keeping
`enables` acyclic is what makes "attack path" well defined and stops path-finding
from looping. `escalates` edges are exempt: they are symmetric-ish by nature and
never walked.

`attackPaths()` currently follows only the first outgoing `enables` edge
from each root, with peak severity and the number of verified nodes. It can
omit branches; it is not a complete graph traversal. A finding with no incoming
`enables` edge is a root. Relations are model assertions without captured
transition evidence: even verified endpoints do not prove that the edge works.
`/findings` reports chains separately from the flat list, and each chain is
labelled **`demonstrated`** when every link on it is verified and **`candidate`**
otherwise. **That label checks node dispositions only, not demonstrated
transitions; it must not be interpreted as an independently proven chain.** The HUD strip
carries a `⇢ N paths` count once any exist.

The engagement brief tells the model to chain as it goes, because a chain found
late is a chain that never gets cited.

## Screenshots are artifacts, not proof

`ardent_screenshot` captures an in-scope URL as a PNG and records it as an
**Artifact** with a SHA-256, so a finding can cite the captured bytes. A digest
checks byte identity, not target provenance, request authorization or truthful
interpretation. The capture is supporting material, not a verdict.

**A screenshot shows what RENDERED, not what EXECUTED.** This is the distinction
the tool is built around, because it is exactly where a vision model will
mislead you:

- A reflected/stored payload that paints something — a dialog, an injected
element, a broken layout — is genuinely corroborated by the image.
- **Blind XSS, self-XSS, and console-only payloads paint nothing.** The capture
  comes back a healthy page. An LLM asked "does this prove XSS?" will often say
  yes anyway, because the page *looks* fine and the caption sounds confident.

So the capture is recorded as an artifact and **never as a verification**. The
deterministic signal must match the claim: HTTP reflection or a rendered payload string is
not proof of script execution. XSS reproduction needs an attributable bounded
execution signal in the intended victim context, not agent-injected evaluator
code. Record source events/bytes beside the image; prose alone is insufficient. The
tool's own guidelines say this in the model's words, and `ardent_verify` still
requires a `method` describing how it was actually reproduced **plus proof a
screenshot cannot supply**: proof consisting only of captures is refused with
`validation`, because the deterministic signal (DOM state, console output,
request/response bytes) is what a verdict stands on.

Three consequences worth knowing:

- **The digest is on the result row.** A capture is only useful as evidence if
  the operator can tell it was not swapped afterwards, and the hash is the one
  thing a viewer cannot check by looking at the image.
- **There is no bundled browser.** pi ships no browser tool, and a headless
  chromium in the npm bundle would be hundreds of MB of CVE surface for a
  host-only Phase 1. Ardent discovers a chromium already on the host (or
  `$ARDENT_BROWSER`), and refuses with the fix named when there is none.
- **`--no-sandbox` is never passed.** Chromium's own sandbox is a real defense
  on a host-only tool; disabling it to make captures easier would trade a
  boundary for convenience.

The model must also be able to *see* the image: pi attaches image content only
when the active model declares the modality, so `buildProviderConfig` declares
`input: ["text", "image"]`. The catalog does not advertise per-model
capabilities yet, so this is a deliberate blanket declaration — revisit it when
`/client-version` reports modalities.

## HTTP requests are captured execution (plan slice P4)

`ardent_request` makes one bounded HTTP exchange and records it as a
**runtime-origin observation** — the only proof that can carry a verification.
`src/ardent/http.ts` holds the adapter; the tool is a thin seam over it.

Arguments: `method`, `url`, optional `identity` (an operator-supplied account
*reference*, never a credential), `redirect` (`follow` or `deny`), `query`,
`headers`, `json_body` / `form_body`. The response body, status, byte count and
sha256 come back; the exchange is also written to the engagement's evidence log
with its per-hop metadata.

Four guarantees, each enforced in the adapter rather than by asking the model:

- **Scope before every hop.** The chain is walked one hop at a time, and the
  scope predicate runs before each contact — a redirect into an unapproved
  origin is refused having sent nothing to it. `redirect: "deny"` stops at the
  first 3xx without contacting the destination it names.
- **Credentials are origin-bound.** The secret adapter resolves the `identity`
  reference to material bound to the origin it was resolved for; a cross-origin
  hop is sent bare. Records carry request header **names** only, so a cookie or
  token cannot leak into a trace or an observation.
- **Bounded.** Timeout, redirect count and response bytes are fixed limits the
  model cannot raise; the body is read with a streaming cap and marked
  `truncated` when it is cut. A target cannot be flooded or exhausted.
- **Encoding-safe.** Query and form values are encoded with `URLSearchParams`,
  so a value that means `a&b=c` is transmitted as that instead of being
  re-parsed.

The `tool_call` gate still runs first: an out-of-scope URL or a state-changing
method while the store is degraded is blocked there as well, and the gate's
refusal is what the model sees. Identity resolution is injected
(`createArdentExtension({ identities })`), and production builds it from the
config's `identities` block (`src/ardent/identities.ts`): an env var or file per
reference, read at call time. An `identity` argument that does not resolve fails
closed as `identity_unavailable`.

### A configured scope is authorization, not a task

The brief is injected before **every** turn, and it opens with the role's own
brief ("You are RECON. Map what is actually there…"). With no rule saying
otherwise, the model read that as a standing order and a bare `hello` launched a
full recon run. The brief now leads its rules with two explicit ones, both ahead
of the scope rules the model might over-read:

1. A scope is **authorization, not an instruction** — greet and answer normally,
   and do not scan, map or otherwise touch a target until the user asks for
   engagement work or states an objective.
2. **Ask before guessing.** When the objective is ambiguous — which target, how
   far to go, whether a technique is acceptable — ask a clarifying question
   before acting. A wrong assumption against a live target is harder to undo
   than a question is to answer.

Read-only when in doubt is the house style anyway; these rules are what keep
"in doubt" from defaulting to "start working" or to picking the most
interesting interpretation and running with it.

### Refusals on authorized work

The other half of the same problem. An engagement is authorized and positively
scoped, and a step in it — *confirm the reflected parameter executes*,
*reproduce the injection against the in-scope host* — still reads to the model
as a request it should decline. The turn then ends in a paragraph explaining why
it will not continue, and the operator has to argue their own engagement back
into existence on every step.

Two changes, both in the brief rather than in the gate:

- **Authorization is stated before the boundary.** The rules now open by saying
the engagement is authorized and claims the harness enforces scope
*mechanically*. **That wording overstates the current argument-level gate:**
it blocks classified tool calls, not every possible network dispatch. Correcting
the injected prompt upstream is part of the remaining correctness work. A model that meets the scope list first can read an authorized
step as something it is being asked to adjudicate; a model that meets the
authorization first has nothing to adjudicate. The rule that follows tells it
not to re-litigate authorization and not to attach disclaimers to in-scope
work.
- **The destructive/privileged rule is named as the single exception.** It used
to read as a general "ask before acting"; it now says that confirming first is
the *one* case where a question is right. That is also too broad: scope does
not authorize every technique, mutation or data-handling choice. Missing
objective, identity, policy or approval must remain legitimate blockers.

Declining is still available, and the brief says so: anything genuinely outside
the scope or the rules is answered once, in one line, and stopped.

### Refusal recovery (removed)

The bounded refusal-recovery loop — first-person detection, the one-nudge-per-
objective budget, the `agent_settled` trigger and the `⟳ authorization reminder`
strip — was **removed** (safety review, 2026-10-04). Its governing test is
*does this control establish authorization or proof?* It does not: it
re-authorizes a model that already declined, which the scoped brief and the
action gate handle. `src/ardent/refusal.ts` and `test/ardent-refusal.test.ts`
are deleted, and `agent_settled` / `ARDENT_RECOVERY_TYPE` are gone from the
extension's hook surface.

Declining is still available, and the brief still says so. The difference is
that a decline is now answered by the operator rather than automatically
re-litigated by the harness.

## Subagents (Phase 2)

The `spawn_agent` tool delegates a self-contained task to a nested **in-process**
`AgentSession`. It is deliberately not a subprocess: free-pi's provider is
registered in-process, so a spawned `pi`/`free-pi` process would have no
provider and could not complete a turn. The production runner
(`src/ardent/subagent-runtime.ts`) is the executable proof from
`test/ardent-subagent.test.ts` promoted to code:

- The child re-registers the free-pi provider and carries the **parent's**
  `x-session-id`, so the server's one-session-per-account lease never sees a
  second session.
- Child runs are serialized through a promise-chain mutex, and `spawn_agent` is
  `executionMode: "sequential"`, so no two completions are ever open at once.
- The child session reuses the parent's Ardent state: the scope gate, working
  memory and evidence store all apply to subagent actions, and a subagent's
  observations and findings land in the same `/findings` report.
- The parent's abort signal is forwarded to `session.abort()` on the child, and
  the child is always disposed in a `finally`.
- While a subagent runs, its progress shows both in the footer status line
  (`ctx.ui.setStatus("ardent-subagent", …)`: depth plus `starting` / `turn N` /
  `running <tool>`) and as an animated row in the HUD, fed by the child's own
  turn and tool events and cleared when the call settles.
- **Recursion is bounded.** `DEFAULT_MAX_SUBAGENT_DEPTH` is 1: the top-level
  session may spawn, and a child at the limit does not get the tool at all (nor
  the name in its allowlist), on top of a runtime depth check in the tool.
- **Delegation is not engagement-gated.** `spawn_agent` runs with or without an
  engagement; the guardrails stay engagement-only — the `tool_call` scope guard
  and the evidence tools (`ardent_note`/`finding`/`verify`/`link`) both check
  `engaged()` and refuse otherwise. `enabled` remains an option on the tool so a
  test can force the refusal.

### Per-lease concurrency (client half)

The free-pi server permits **one live completion per lease** today, and reports a
second one as `concurrent` (HTTP 429). Subagents therefore serialize, and that
is enforced in two places: the runner bounds in-flight children with a
semaphore, and `spawn_agent` is `executionMode: "sequential"` so pi never
launches two spawns in one turn.

`src/ardent/concurrency.ts` is the **client half of a negotiation that is inert
until the server opts in**. If `/client-version` advertises
`max_concurrent_completions`, the limit is threaded through `run.ts` →
`LaunchOptions` → `pi-launch.ts`, the semaphore widens to that many slots, and
the tool's execution mode becomes `"parallel"`. Absent (or malformed) the value
normalizes to 1 and behavior is byte-for-byte what it was before —
`normalizeConcurrencyLimit` also caps it at `MAX_NEGOTIATED_CONCURRENCY` so a bad
server value cannot cause unbounded in-flight work.

The limit is deliberately **unvalidated at the schema boundary**: a malformed
value must not fail the whole `/client-version` parse, which would discard
`min`/`latest` and silently disable the update gate. Clamping happens in
`normalizeConcurrencyLimit` instead.

**Retry is the second half of "degrades gracefully."** When two children share
a lease and the server still rejects one, the only signal a nested session
offers is *empty output*: the pi SDK turns every non-2xx (400/429/500/503) into
an empty assistant message rather than a throw, and the one status hook
(`after_provider_response`) does not fire for a nested streaming child. So the
runner retries a run that produced no text, with exponential backoff plus jitter
(`backoffDelay`), bounded by `SubagentRetryPolicy` (default: 2 extra attempts).

When a limit above 1 is in effect the child's **SDK-level provider retry is
turned off** (`retry.provider.maxRetries = 0`). The SDK's retry is invisible to
the tool's abort handling and holds a semaphore slot without coordination, so
the runner owns the loop instead. Currently `schedule.run` wraps the whole
retry loop: it does **not** release/reacquire a slot between attempts. Abort
cancels the backoff. Retrying a whole empty-output child can repeat completed
mutations; this is not safe failure classification and must be replaced before
stateful engagement use. At the default limit of 1 nothing is retried at
the runner level and the SDK's retries are untouched, so serialized behavior is
byte-for-byte what it was before.

### Roles are capability reduction, not prompt wording

`spawn_agent` takes a `role`. The role selects the child's **tool set**, not
just its instructions — `src/ardent/roles.ts` is the table, and it is pure, so
it is tested without a session:

| Role | Can reach a target | Can conclude | Can link | Notes |
|---|---|---|---|---|
| `planner` | **no** (no `bash`) | no | no | scopes the work; observes what it reads |
| `recon` | yes | **no** | no | maps and records; the operator judges |
| `executor` | yes | yes | yes | the default; identical to what a child always got |
| `verifier` | yes | yes | **no** | reproduces claims; attack paths are orchestration |
| `general` | yes | yes | yes | the permissive default, no discipline text |

The point is that the rule survives a model that does not feel like obeying it.
A `recon` agent **cannot call `ardent_finding`** — the name is absent from its
session, so "every finding cites evidence" stops being a prompt request and
becomes a property of the session. That also saves turns: an agent that could
call `ardent_finding` spends them proposing findings that get rejected for want
of citations.

`canRecordFindings` is *derived* from the tool list rather than stored beside
it, so the flag and the thing that actually enforces it cannot drift apart. No
role carries `spawn_agent` (recursion stays behind the depth guard) or the
free-pi UI tools.

The default is unchanged: a spawn with no `role` is an `executor`, which has
exactly the tools a child has always had. An unrecognised role is **refused**
rather than silently downgraded, because the caller asked for a capability set
and did not get one.

`test/ardent-roles.test.ts` asserts the reductions against a real nested child
session, reading `body.tools` off the wire to a stub upstream — a table that
nothing wired up would pass every other assertion in the file.

## Concurrency (measured against the real server, 2026-10-03)

The nested-session mechanics are proven against a stub. The **lease** is a
server-side property a stub cannot answer, so it was measured directly against
`api.freepi.ai` with the production runner. Two error codes decide it:

| Probe | Result | Consequence |
|---|---|---|
| two completions, one at a time | `200`, `200` | serial delegation is fine |
| two completions **overlapping**, same session id | `200` + **`429 concurrent`** | never two *thinking* at once |
| two completions, **distinct** session ids | `200` + **`409 concurrent_session`** | one lease per account; a new id does not help |
| a completion fired while a child is in `bash` | **`200`** | the lease frees the moment a completion returns |

So the mutex in `subagent-runtime.ts` and `executionMode: "sequential"` are
load-bearing, not defensive: they are what keeps the shipped code under the
first row of that table.

The fourth row is the useful one. An agent waiting on `nmap` holds no stream,
so the lease is available to whoever thinks next. A roster can therefore
**pipeline** — one completion open at a time, while probes overlap other
agents' inference. This respects the constraint completely rather than
evading it: the server's rule is one live stream, and pipelining never has
two.

Not implemented yet, and it is a real change rather than a toggle: the mutex
currently wraps the *whole child run*, which serializes probes as well as
thinking. Loosening it to wrap only the completion windows would convert
`maxOpen <= 1` from *provably serialized* to *serialized in practice* — a
weaker guarantee, for the invariant `test/no-subagents.test.ts` SB2 exists to
hold. If it is done, the roster should acquire and release the lease
explicitly around each completion rather than relying on a child happening not
to think mid-probe.

**Caveats on the measurement.** Two runs, one shape (a single long `sleep`);
the mechanism is proven, the size of the win is not. And a stale lease from any
crashed session makes *every* request 409 in ~200 ms — indistinguishable from a
broken spike. `/close-other-session` clears it.

## Visual language (ops console)

The TUI is designed as an operator console, not a chat toy. Four rules:

- **Graphite + amber.** An in-memory pi theme (`src/ardent/theme.ts`) recolours
  the whole TUI: graphite backgrounds, an amber signal accent for brand and live
  state, green for verified, red for error/refusal. It is built at the terminal's
  exact colour mode (`ctx.ui.theme.getColorMode()`) and handed to
  `ctx.ui.setTheme(instance)` — no theme file, no `~/.pi` writes, and no reliance
  on `resources_discover`, which fires *after* `session_start`. `ARDENT_THEME=off`
  keeps the user's own theme.
- **The header is a console header.** The wordmark leads, a one-line identity
  follows, and commands are grouped under `▸ ENGAGE` (Ardent) and `▸ FREE-PI`
  (account/plumbing) so the eye can skip the plumbing.
- **Status lives where the operator looks.** The HUD strip sits above the editor
  (identity line plus, when the terminal is wide enough, a dim posture row with a
  scope preview and evidence counts); a compact footer segment
  (`◎ <engagement> · N targets · V verified · ○ idle`) and the terminal window
  title are set through `ctx.ui.setStatus`/`setTitle`; and the streaming loader
  shows an Ardent verb (`ctx.ui.setWorkingMessage`). The built-in footer is
  deliberately **not** replaced: it carries pwd, context usage and the active
  model, which an ops strip must not drop.
- **Boxless by default, framed only for modals.** Every in-transcript Ardent
  surface stays boxless (enforced by `test/ardent-render.test.ts`); the only
  bordered Ardent surfaces are the large overlays, where a frame makes the
  modal boundary legible.

### Overlays

`/posture` opens the engagement dashboard (scope, evidence counts, findings
verified-first, attack paths); `/findings` opens the same findings view;
`/scope` opens a **read-only** allowlist view; and `/sessions` opens a filterable
session picker that calls `ctx.switchSession`. All four are `ctx.ui.custom`
overlays (`src/ardent/overlay.ts`, content from `src/ardent/dashboard.ts`),
scrollable with `↑`/`↓` and closed with `esc`. Typing filters the session
picker only; posture/findings/scope panels do not filter. Overlays currently
request 92% width, not full-screen. The picker consumes `j`/`k`/`q` as navigation
or dismissal, so those letters cannot be searched normally; long labels and
Unicode terminal-width handling still need repair and real resize tests. pi already
exposes a session selector internally as `app.session.resume`, but it ships with
**no default key**, so `/sessions` is the shortest path to session UX.

`/scope` is a viewer, not an editor, on purpose: there is no config writer yet,
and changing the scope changes what is *authorized*, so it stays a deliberate
file edit until a writer with explicit confirmation exists.

## Engagement ownership, journal and artifacts (plan slice P2)

Citations only mean something if something *owns* them. `src/ardent/application.ts`
makes the engagement a durable object; `src/ardent/io.ts` gains the three
primitives it is stored with.

**Commands, not mutations.** Every change goes through a command on
`EngagementStore` — `createEngagement`, `bindSession`, `releaseSession`,
`transition` — and returns a discriminated result:

```ts
{ ok: true, value, revision } | { ok: false, code, message }
```

`code` comes from the plan's contract: `validation`, `not_found`,
`revision_conflict`, `storage_unavailable`, `corrupt_store`,
`unsupported_schema`, `incomplete_tail`, `locked`, … Callers branch on the
code; nothing parses prose.

Three rules are what make the journal worth having:

- **validated → written → projected, in that order.** `#commit` checks the
  batch first (known event types, references that exist, exactly one engagement
  per command), then appends *and fsyncs* it, and only then moves the
  in-memory projection. A full disk therefore produces `storage_unavailable`
  with an unchanged projection — never a "saved" engagement that was not saved.
- **one command = one JSONL record.** Replay applies a batch whole or not at
  all, and the engagements in memory are a projection: `close()` followed by
  `open()` reproduces them exactly, including revisions and released bindings
  (`test/ardent-application.test.ts`).
- **idempotent by `commandId`.** Repeating an id returns the original result
  and commits nothing; reusing an id for a *different* payload is `validation`.
  A retry after a timeout cannot quietly become two engagements.

**Layout** — the plan's, one directory per engagement under
`<agentDir>/ardent/engagements/`:

```
engagements/<engagementId>/
  events.jsonl          authoritative: one command batch per line, fsync'd
  events.jsonl.lock     single writer (pid / host / since; clear() is explicit)
  engagement.json       derived projection — written, never read as authority
  artifacts/sha256/…    this engagement's bytes only, content-addressed
```

The journal decides what an engagement is; `engagement.json` is written beside
it after every commit (temp file → rename, so a crash leaves the previous
manifest rather than a half-written one) purely so a human or another tool can
read the state without replaying. **Replay never reads it** — a test deletes
the manifest and reopens, and gets the same engagement back. A manifest that
cannot be written does not uncommit a command: the journal already did, and
the failure is reported through `EngagementStore.manifestError`. Each
engagement's events live in *its own* file, and replay refuses a journal whose
commands name a different engagement — otherwise one engagement's history
would end up split across two files.

Artifacts are addressed by content but stored per engagement
(`artifacts/sha256/<aa>/<digest>`: the plan's address namespace plus a
two-char fan-out so a directory cannot grow to tens of thousands of entries).

Ownership specifics:

- An engagement is created `draft` with objective, authorization reference and
  scope. Moving it to `active` is a separate command, and resuming from
  `paused` must hand back the recorded authorization reference — supplying a
  different one is refused, because a changed authorization is a new
  engagement, not a resume.
- A session is bound by **explicit id only**: there is no most-recent-engagement
  to fall back to, and a session holds one engagement at a time (switching is
  release + bind, both visible). Closing releases that engagement's bound
  sessions *in the same batch* and keeps the bindings as history. Closed
  engagements stay readable and accept nothing.
- `expectedRevision` gives optimistic concurrency: a stale value is
  `revision_conflict`, never a silent overwrite.

**Storage primitives** (`src/ardent/io.ts`):

| Primitive | Guarantee | Reports |
|---|---|---|
| `Journal` | append-only JSONL, one validated batch per line, written **and fsync'd** before its command is called successful | `storage_unavailable`, `corrupt_store`, `unsupported_schema`, `incomplete_tail` |
| `JournalLock` | single writer, taken before any mutation. Never reclaimed by age — ownership (pid / host / since) is reported and `clear()` is a separate, explicitly-called operator action | `locked` |
| `ArtifactStore` | content-addressed (sha256): temp file → fsync → rename, so bytes are complete before any event could point at them | `storage_unavailable` |

Faults are detected and remembered, never auto-repaired. Mid-file damage or an
unknown record schema blocks every command rather than skipping it; a file cut
short mid-record blocks until `recoverTail()`, which returns the bytes it
discarded so records are never silently truncated. A second process on the same
journal is refused at `open()`, before it can mutate anything.

Evidence writes are under the same contract, and each engagement has its own
log: `<agentDir>/ardent/engagements/<engagementId>/evidence.jsonl`.
`EvidenceStore` **commits before it projects** — the record is written and
fsync'd first, and only then enters the in-memory projection. A failed write
returns a typed `storage_unavailable` refusal, the projection does not advance,
and the bytes are retained as **salvage** (`salvage` / `salvageCount`), which is
explicitly not report evidence. `degraded` (with `persistenceError` saying why)
is set and the store then refuses further records outright rather than retrying:
retrying would let the log and the counts drift, which is the thing the flag
exists to prevent. The flag is deliberately sticky — a later write cannot repair
the record that went missing, so a new run against a working device is the way
out.

Because it is sticky it is also **enforced**, not merely reported (read-only
mode; the invariant "a required persistence/policy failure prohibits new
state-changing target execution"):

- `assessAction` checks it first (rule 0, `GateInput.persistenceDegraded`).
  With a failed durable write the gate blocks only what the `isStateChanging`
  classifier recognizes as a mutation — a mutating HTTP method, a body/upload
  flag, a known mutating tool, or a target-capable tool with no declared method.
  Read-only observation stays available, and the block reason names the storage
  failure instead of dressing it up as an out-of-scope verdict.
- All five evidence tools then refuse with `Rejected: storage_unavailable — …`
  and a typed `details.code`, so nothing new enters a record that cannot be
  committed. The TUI row prints the code; it no longer says "no active
  engagement" for a failure that had nothing to do with engagement.
- Local read/write work and everything already committed stay usable, so the
  operator can still read and export what survived — degraded, not dead.

Recovery is a new run against a working device: `degraded` is cleared by
reopening the engagement (a new process) or by replaying into a fresh store,
not by a later write. The "preserve available output for explicit
recovery/export" half of that invariant is now partly met: a refused record is
retained as **salvage** and labelled as such on the refusing tool result and in
`EvidenceStore.salvage`, so it is neither discarded nor mistakable for report
evidence. There is still **no export command**, so an operator cannot yet write
those bytes anywhere — an open gap, not a covered one.

**Wired (working tree):** the extension resolves explicit session bindings
through `EngagementStore` and exposes `/ardent start`, `bind`, `release`, and
`unlock`. Evidence commands now go through `EngagementStore.evidenceFor(id)`:
every surface — the evidence tools, the HUD counts, `/findings`, `/posture`,
`/ardent status` — reads the **bound engagement's** log, and a second engagement
neither displays nor accepts the first one's citations (`foreign_reference`).
Resuming a session replays that log, so committed records, ids and dispositions
come back without renumbering. Working memory is still process-local: it is not
yet rehydrated, so a resumed session starts with an empty memory block even
though its evidence is back. What remains unverified is live SDK switch/fork
behavior (see the limitation below).

## Evaluation harness (plan slice P0)

The `eval/` tree is the measurement half of the plan: a declared case manifest, a
resettable local fixture, a hidden grader, and a runner that records trial
artifacts. It exists so the next phases are judged on outcomes rather than on
prose, and so a fixture that leaks cannot be graded as "no finding" because a run
said so.

```bash
bun eval/cli.ts --trials 3              # artifacts under <agentDir>/ardent/evals/
bun eval/cli.ts --cases W01,W02 --trials 3 --seed 1000 --out /tmp/ardent-evals
```

What it measures, and against what:

- **Manifest (`eval/protocol.ts`, `eval/cases.ts`).** All sixteen W01–W16 cases
  are declared with objective, approved scope and exclusions, credential
  *references*, budgets, a development/held-out split and a **hidden**
  expectation. `investigatorView()` builds the visible half field by field, so a
  hidden field added later cannot leak by default. Unknown fields, a typo'd
  budget key, a missing expectation and an unknown case id are all refused with
  the offending name rather than defaulted. A case with no fixture is refused by
  the runner, never skipped — a suite that silently drops cases reports coverage
  it did not have. Only W01 and W02 are wired in this checkpoint.
- **Fixture (`eval/fixture-app.ts`).** Two loopback planes. The in-scope app has
  two accounts, one object each and one shared object, with object ids and
  protected markers rotated per trial and an authoritative server-side request
  log. The harness-only control plane sits on its own port, refuses anything
  without its token, and records every unauthenticated attempt — which is what
  turns "the excluded endpoint received nothing" into a check. Nothing in a
  report carries a marker, a password or a session cookie, only digests.
- **Grader (`eval/grader.ts`).** Reads the fixture's request log and the
  engine's projections, never the agent's final prose. A verified finding whose
  proof is not harness-captured is `unproven_verified` and graded `unexpected`.
- **Driver and harness (`eval/harness.ts`, `eval/driver.ts`).** The deterministic
  driver takes the same path a model would: `/ardent start` to bind, the real
  `tool_call` gate before **every** target contact, the evidence tools, and
  `ardent_verify`. It has no privileged API and never reaches the control plane.
  Since P4, the boundary under test is reached through the real `ardent_request`
  tool (gate first, then captured exchange); only the fixture readiness probe and
  the login that acquires an identity's cookie use a shell `curl` — neither is
  target evidence.

**Baseline, three trials each (deterministic drivers, seed 1000):** W02 (secured)
reports `no_finding` as expected, consistent across all three. Since P4, W01
(vulnerable) observes the seeded boundary crossing and **verifies** it from the
captured exchange: `observed=demonstrated`, `as_expected` 3/3. Before P4 the same
run recorded only a candidate (`inconclusive`, `captured-execution provenance for
HTTP requests (plan P4)` named as the gap) — the change is the adapter, and the
number moved because a proof path now exists, not because a threshold was relaxed.

## Known Phase 1 limitations

- **Parallel workers are not possible, and this is now measured rather than
  assumed.** See "Concurrency" above: the lease refuses two overlapping
  completions outright. A roster of agents is therefore a queue, not a thread
  pool, and the default depth stays one level.
- **No sandbox / network enforcement.** The gate inspects commands, not the OS;
  it is a best-effort argument check, not confinement. Do not point this at systems you are
  not authorized to test.
- **No model routing or prompt caching** — the free-pi proxy owns the upstream;
  the client only chooses among the server's catalog ids.
- **Subagent unknowns (server-side):** resolved — see "Concurrency" above. What
  remains unmeasured is how wide the pipelining window is in practice; the
  probe used a single long `sleep`.
- **Working memory is per-process.** Evidence and engagement state are durable
  and replay (see "Engagement ownership" above), but working memory is still
  strings and capped lists held in the process, so a resumed session starts
  with an empty memory block. Ownership of it is explicit; rehydration is not.
- **A mid-run session switch blocks instead of settling.** The installed SDK's
  fork/switch behavior during an open child run has not been established, so a
  session id that changes while an assignment is in flight is recorded and
  everything target-capable or evidence-writing is refused with `cancelled`
  until an operator runs `/ardent start` or `/ardent bind` deliberately. This
  is a visible block, not a demonstration that switching is safe.
- **Promotion needs a registered profile's verdict, not an assertion.** A
  verification promotes only when a registered proof profile
  (`authorization-boundary`, `route-comparison`, `guarded-transition`) judges a
  fresh control/probe pair — both run and captured by the application — as
  discriminating the claim. A `passed` boolean, a model-authored note and a
  screenshot cannot promote anything, and an unregistered or changed profile
  downgrades to `inconclusive`. The profile compares two captured exchanges; it
  does not re-derive the claim's truth from the target's own semantics, and it
  is host-scoped.
- **Ids are unique per engagement, not globally.** `obs-1` in two engagements
  names two records; a path carries the engagement id, and reports must too.
- **The P0 baseline is deterministic only.** No model or provider was involved,
  so its numbers measure the runtime and the fixture, not model skill; every
  trial is stamped `model:null` and missing usage is `null`, never zero. It is
  not a quality or improvement claim. Fixtures exist for W01/W02 only; W03–W16
  are declared and refused.

## Phase 2 (in progress): plan → execute → verify, then subagents

1. **Verifier phase:** the `verifier` role now exists and is selectable, but
   there is no `/verify` flow to walk candidate findings and demand an
   independent reproduction — that orchestration is still missing.
2. **Subagents — done.** `spawn_agent` runs a nested in-process `AgentSession`
   with the free-pi provider, sharing the parent's session id, gate and evidence
   store, serialized (`maxOpen <= 1`), with a depth guard (default 1), abort
   propagation, and per-call **role selection** that reduces the child's tool
   set. Each assignment is **pinned** to the engagement that authorized it for
   the length of the run, so a child (which holds no binding of its own) writes
   into the parent's engagement and cannot be re-homed by a later binding
   change. See `src/ardent/subagent.ts`, `src/ardent/subagent-runtime.ts`,
   `src/ardent/roles.ts`, `test/ardent-subagent-runtime.test.ts`, and the
   pinning checks in `test/ardent-evidence-ownership.test.ts`. Parallel workers
   are closed off by the lease (see "Concurrency"); pipelined serialized
   fan-out is the remaining opportunity.
3. **Execution — captured HTTP (P4) and the proof profile (P5) are in.** The
   bounded HTTP adapter supplies captured exchanges, and `ardent_verify` now
   registers an experiment, runs a control and a probe through that adapter, and
   has the application judge them against a registered profile — a model boolean
   is no longer a promotion path. Still missing: experiment registration as a
   first-class workflow (it is written by `ardent_verify`, not yet a standalone
   `ardent_experiment` command), and network confinement/container execution,
   deferred beyond host-only v1 — do not imply the current gate supplies it.
4. **Long-term state — partly done.** Evidence and artifacts are per-engagement
   and replay on restart (`EngagementStore.evidenceFor`/`artifactsFor`). Still
   open: working-memory rehydration, an export/retest package, and a legacy-log
   migration path that maps old flat records onto an engagement explicitly
   rather than guessing (see the plan). SQLite is an optional later alternative,
   not a prerequisite or committed dependency.

## Porting

This repo is a one-way mirror: `src/`, `test/`, `README.md`, `CHANGELOG.md`, and
`package.json` are overwritten by the monorepo sync, and a sync refuses to run if
it finds hand edits. To keep this work, port the new `src/ardent/*`, the tests,
and the edits to `src/pi-launch.ts`, `src/paths.ts`, and
`test/no-subagents.test.ts` into the monorepo's CLI package.
