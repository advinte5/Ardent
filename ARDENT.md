# Ardent — engagement layer on free-pi

Ardent is an evidence-first, offensive-security engagement layer built on the
free-pi harness. It keeps the free-pi provider (ad-funded inference) and the ads
extension unchanged, and adds scope enforcement, an approval gate, working
memory, and an evidence store.

This document describes **Phase 1 (host-only)** plus the Phase 2 subagent layer,
and engagement-plan slices P1 (strict citations, proof-gated verification) and
P2 (durable engagement ownership: journal, lock, artifacts).
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
| `src/ardent/refusal.ts` | Refusal detection (first-person only) + the bounded one-shot authorization recovery message |
| `src/ardent/config.ts` | Engagement config parsing (`enabled`, `targets`, `label`) |
| `src/ardent/io.ts` | Config loader + JSONL evidence sink, plus the durable primitives: `Journal` (fsync'd append-only batches), `JournalLock` (single writer), `ArtifactStore` (content-addressed bytes) |
| `src/ardent/application.ts` | Engagement commands over the journal: ownership ids, lifecycle, session bindings, idempotent `commandId`s, revisions, replay |
| `src/ardent/subagent.ts` | The `spawn_agent` tool: role selection, depth guard, abort forwarding, runner interface |
| `src/ardent/subagent-runtime.ts` | Builds the nested in-process subagent `AgentSession` |
| `src/ardent/roles.ts` | The role table: each role's brief AND its tool subset (pure, SDK-free) |
| `src/ardent/screenshot.ts` | `ardent_screenshot` capture: URL/scope validation, browser discovery, hashed artifact |
| `src/ardent/render.ts` | Boxless strip rendering for the five Ardent tools (structural Component; no pi-tui import) |
| `src/ardent/hud.ts` | The persistent, animated one-line engagement strip, plus the footer status text and window title builders |
| `src/ardent/theme.ts` | The Ardent in-memory pi theme (ops-console graphite + amber), applied at session start |
| `src/ardent/overlay.ts` | Framed, keyboard-focusable full-screen modals (panel + list) |
| `src/ardent/dashboard.ts` | Pure content builders for the posture/findings overlays |
| `src/ardent/banner.ts` | The `/ardent` status text (build, scope, evidence counts) |
| `src/ardent/extension.ts` | The `free-pi-ardent` inline extension wiring it into pi |

Wiring: `src/pi-launch.ts` adds `free-pi-ardent` to the extension list and its
five evidence tools plus `spawn_agent` (`ardent_note`, `ardent_finding`,
`ardent_verify`, `ardent_link`, `ardent_screenshot`, `spawn_agent`) to
`ALLOWED_TOOL_NAMES`. `test/no-subagents.test.ts`'s closed-list assertion is
updated from nine to ten extensions, and its tool ban now names `spawn_agent` as
the single deliberate, gated exception.

## Safety model (host-only)

There is **no sandbox yet** (pi has none built in; see its `security.md`). So the
gate is the boundary:

- The extension is **inert unless an engagement is configured**: no scope means
  no scope guard, no engagement brief, and evidence tools that refuse. The one
  exception is `spawn_agent`, which works in plain coding use too — delegating a
  task does not require an engagement (see *Subagents* below).
- An engagement config only engages when explicitly `enabled` and it names at
  least one target. "Enabled but empty scope" is treated as *not engaged*, never
  as "everything is authorized".
- With a scope set, `tool_call` blocks destructive commands and out-of-scope
  egress outright, and requires interactive confirmation for privilege
  escalation, credential access, and writes outside the workspace. With no UI to
  confirm, those are blocked, not allowed. **The gate fails closed**: if the
  assessment cannot be computed at all — an unreadable scope, a hostile argument
  shape — the call is blocked with `policy evaluation failed` rather than waved
  through. A failed assessment is not permission, and the reason says what
  actually happened instead of inventing a scope verdict.
- **A failed durable evidence write stops target execution** (read-only mode).
  The sticky `EvidenceStore.degraded` flag is passed into the gate as
  `persistenceDegraded`, checked *before* any classification: every shell call
  and every tool naming an outbound `url` is blocked for the rest of the run,
  and the evidence tools themselves refuse with a typed `storage_unavailable`
  so nothing enters a record that cannot be committed. Local read/write work
  continues — an engagement that has lost its audit trail may still be read and
  exported, but it may not act on a target. Recovery is a new run against a
  working store (there is no rehydration path yet).
- Findings must cite existing observation/artifact ids **and at least one of
  them**: an empty citation list is refused as `missing_citation`, a
  never-issued id as `foreign_reference`. Verification is recorded separately
  and **only promotes a finding when the attempt cites the proof carrying its
  result** — `passed: true` on its own is stored as an `unvalidated` attempt
  and leaves the finding a candidate. Only verified findings appear in
  `/findings`.

### Verification promotes only on proof

`ardent_verify` takes `proof_observation_ids` / `proof_artifact_ids` alongside
`passed` and `method`. The store derives the outcome **from the proof, never
from `passed`**:

| Proof cited | Claim | Recorded outcome | Finding status |
| --- | --- | --- | --- |
| none | `passed: true` | `unvalidated` | unchanged (still a candidate) |
| yes | `passed: true` | `supported` | `verified` |
| yes | `passed: false` | `refuted` | `refuted` |
| yes | `inconclusive: true` | `inconclusive` | `inconclusive` |
| screenshot-only | any | refused (`validation`) | unchanged |

This is what stops a worker promoting its own candidate by asserting a boolean.
The unvalidated attempt is still persisted — it happened, and the audit trail
should show it — but it reaches neither `/findings` nor the `Verify …` todo,
which stays open so a live lead is not buried behind a bare assertion.
`inconclusive` is its own status throughout: a test that could not discriminate
is not a refutation, and the report says so.

Screenshot-only proof is refused because a capture shows what rendered, not
what executed (see *Screenshots are artifacts, not proof*): the deterministic
signal has to be recorded as an observation, or as a non-image artifact, beside
the image.

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
{ "enabled": true, "label": "<your-engagement>", "targets": ["10.0.0.0/24", "host.example.com"] }
```

Then run free-pi normally. `/scope` lists the authorized targets, `/findings`
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

`attackPaths()` returns the maximal `enables` chains from root to leaf, each with
its **peak severity** (the most urgent link, not the first) and how many links
are actually verified. A finding with no incoming `enables` edge is a root; a
node with two parents appears in both routes, because both genuinely get there.
`/findings` reports chains separately from the flat list, and each chain is
labelled **`demonstrated`** when every link on it is verified and **`candidate`**
otherwise — an unproven route never reads as a proven one. The HUD strip
carries a `⇢ N paths` count once any exist.

The engagement brief tells the model to chain as it goes, because a chain found
late is a chain that never gets cited.

## Screenshots are artifacts, not proof

`ardent_screenshot` captures an in-scope URL as a PNG and records it as an
**Artifact** with a SHA-256, so a finding can cite an image that provably came
from the target. That is the whole value: a receipt, not a verdict.

**A screenshot shows what RENDERED, not what EXECUTED.** This is the distinction
the tool is built around, because it is exactly where a vision model will
mislead you:

- A reflected/stored payload that paints something — a dialog, an injected
element, a broken layout — is genuinely corroborated by the image.
- **Blind XSS, self-XSS, and console-only payloads paint nothing.** The capture
  comes back a healthy page. An LLM asked "does this prove XSS?" will often say
  yes anyway, because the page *looks* fine and the caption sounds confident.

So the capture is recorded as an artifact and **never as a verification**. The
deterministic signal (DOM state, console output, a network call, the payload
string in the returned HTML) is the observation; the image is attached to it. The
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
the engagement is authorized and that the harness enforces the scope
*mechanically* — out-of-scope egress and destructive commands are blocked before
they execute. A model that meets the scope list first can read an authorized
step as something it is being asked to adjudicate; a model that meets the
authorization first has nothing to adjudicate. The rule that follows tells it
not to re-litigate authorization and not to attach disclaimers to in-scope
work.
- **The destructive/privileged rule is named as the single exception.** It used
to read as a general "ask before acting"; it now says that confirming first is
the *one* case where a question is right, and that everything in scope short of
it proceeds.

Declining is still available, and the brief says so: anything genuinely outside
the scope or the rules is answered once, in one line, and stopped.

### The recovery loop (bounded)

Prompt wording alone does not fix a model that has already decided. The harness
answers a refusal once, in-band:

- `agent_end` captures the assistant's last text; `agent_settled` (the agent is
  idle, so `triggerTurn` starts a real continuation turn) runs the detector.
- Detection is **first-person only** (`src/ardent/refusal.ts`). A pentest
  transcript is full of *"connection refused"*, *"the server declined the
  request"*, *"403"* — those are observations, not the model refusing, and a
  detector that flagged them would fire on nearly every recon turn.
- Recovery is **bounded to one nudge per user objective**, reset when the user
  speaks again. A model that declines twice has made its position known;
  repeating the nudge is nagging, not recovery.
- The nudge itself **re-authorizes declining**: if the request is genuinely
  outside scope, saying so in one line is the correct answer and the reminder
  says exactly that. It re-states the authorization and points at the gate as
  the boundary — it does not override the provider's own judgement.

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
the runner owns the loop instead — it can release and re-acquire the slot, and
its abort cancels the backoff. At the default limit of 1 nothing is retried at
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
  bordered Ardent surfaces are the full-screen overlays, where a frame makes the
  modal boundary legible.

### Overlays

`/posture` opens the engagement dashboard (scope, evidence counts, findings
verified-first, attack paths); `/findings` opens the same findings view;
`/scope` opens a **read-only** allowlist view; and `/sessions` opens a filterable
session picker that calls `ctx.switchSession`. All four are `ctx.ui.custom`
overlays (`src/ardent/overlay.ts`, content from `src/ardent/dashboard.ts`),
scrollable with `↑`/`↓`, filtered by typing, and closed with `esc`. pi already
exposes a session selector internally as `app.session.resume`, but it ships with
**no default key**, so `/sessions` is the shortest path to session UX.

`/scope` is a viewer, not an editor, on purpose: there is no config writer yet,
and changing the scope changes what is *authorized*, so it stays a deliberate
file edit until a writer with explicit confirmation exists.

When the bounded recovery loop re-frames a refusal, the nudge is now visible in
the transcript as a boxless warning strip (`⟳ authorization reminder`) — the
renderer reports that a nudge happened and that the action gate is unchanged, and
deliberately does not echo the instruction that was sent to the model.

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

Evidence writes are now under the same contract: `createJsonlEvidenceSink` no
longer swallows errors, so a failed durable write sets
`EvidenceStore.degraded` (with `persistenceError` saying why) instead of
reporting success over a hole. The flag is deliberately sticky — a later
successful write does not repair the record that went missing.

Because it is sticky it is also **enforced**, not merely reported (read-only
mode; the invariant "a required persistence/policy failure prohibits new
target execution"):

- `assessAction` checks it first (rule 0, `GateInput.persistenceDegraded`):
  with a failed durable write every shell call and every tool naming an
  outbound `url` is blocked for the rest of the run, with a reason that names
  the storage failure instead of dressing it up as an out-of-scope verdict.
- All five evidence tools then refuse with `Rejected: storage_unavailable — …`
  and a typed `details.code`, so nothing new enters a record that cannot be
  committed. The TUI row prints the code; it no longer says "no active
  engagement" for a failure that had nothing to do with engagement.
- Local read/write work and everything already committed stay usable, so the
  operator can still read and export what survived — degraded, not dead.

Recovery is a new run against a working store: there is still no rehydration
path (below), so nothing can clear the flag honestly. The "preserve available
output for explicit recovery/export" half of that invariant is only partly
met — nothing is discarded (the failed records stay in memory for the life of
the process), but there is **no export command yet**, so an operator cannot
salvage them to a file. That is an open gap, not a covered one. Surfacing the
flag in `/ardent` and the HUD is plan Phase 6's "durable-write status", not
wired yet.

**Not wired yet:** the extension still keeps config and evidence state in
process. Plan slice P3 is what moves session binding and the evidence commands
onto this application service while keeping the external tool names stable.

## Known Phase 1 limitations

- **Parallel workers are not possible, and this is now measured rather than
  assumed.** See "Concurrency" above: the lease refuses two overlapping
  completions outright. A roster of agents is therefore a queue, not a thread
  pool, and the default depth stays one level.
- **No sandbox / network enforcement.** The gate inspects commands, not the OS;
  it is a strong deterrent, not a boundary. Do not point this at systems you are
  not authorized to test.
- **No model routing or prompt caching** — the free-pi proxy owns the upstream;
  the client only chooses among the server's catalog ids.
- **Subagent unknowns (server-side):** resolved — see "Concurrency" above. What
  remains unmeasured is how wide the pipelining window is in practice; the
  probe used a single long `sleep`.
- Working memory and evidence are per-process; v1 does not yet reload a store
  across sessions. Engagements themselves are durable now (journal + replay,
  see "Engagement ownership" above), and a failed evidence write is both
  *visible* and *enforced* via `EvidenceStore.degraded` — read-only mode, see
  *Safety model* above — but the evidence records still have no rehydration
  path, so the flag reports a hole nothing can yet fill, and the only way out
  of read-only mode is a new run.

## Phase 2 (in progress): plan → execute → verify, then subagents

1. **Verifier phase:** the `verifier` role now exists and is selectable, but
   there is no `/verify` flow to walk candidate findings and demand an
   independent reproduction — that orchestration is still missing.
2. **Subagents — done.** `spawn_agent` runs a nested in-process `AgentSession`
   with the free-pi provider, sharing the parent's session id, gate and evidence
   store, serialized (`maxOpen <= 1`), with a depth guard (default 1), abort
   propagation, and per-call **role selection** that reduces the child's tool
   set. See `src/ardent/subagent.ts`, `src/ardent/subagent-runtime.ts`,
   `src/ardent/roles.ts`, and `test/ardent-subagent-runtime.test.ts`. Parallel
   workers are closed off by the lease (see "Concurrency"); pipelined
   serialized fan-out is the remaining opportunity.
3. **Isolation:** move execution into a container (whole-process, per pi's own
   guidance) and enforce scope at the network layer, replacing the host gate as
   the primary boundary.
4. **Long-term memory:** SQLite findings DB (query previous findings per
   target). Artifact content-addressing now exists as `ArtifactStore`
   (sha256, temp → fsync → rename); what remains is routing evidence
   artifacts through it and reloading them on restart.

## Porting

This repo is a one-way mirror: `src/`, `test/`, `README.md`, `CHANGELOG.md`, and
`package.json` are overwritten by the monorepo sync, and a sync refuses to run if
it finds hand edits. To keep this work, port the new `src/ardent/*`, the tests,
and the edits to `src/pi-launch.ts`, `src/paths.ts`, and
`test/no-subagents.test.ts` into the monorepo's CLI package.
