// First-run onboarding intro. Printed once — on a user's first run (the
// no-JWT path in run.ts), right after consent and ABOVE the device-login
// instructions they must read, so it is guaranteed seen even though the pi TUI
// takes over the screen afterwards. A returning user (JWT on disk) never sees
// it again. Skippable with FREEPI_NO_INTRO. Deliberately Ardent-specific: it
// does NOT duplicate the pi TUI's own key-hint line (pi prints that itself).
//
// Kept OUT of consent.ts and the pi-ads sandbox surface on purpose — it's a
// plain pre-TUI console message via the caller's `log`, nothing more.
//
// The env knob keeps its free-pi name: it is an existing contract, not
// branding, and renaming it would silently break anyone's opt-out.

export const INTRO_ENV_SKIP = "FREEPI_NO_INTRO";

export const INTRO_TEXT = `
Ardent — an evidence-first security agent, free to use.

  • It's the pi coding agent with an Ardent engagement layer: scope, an action
    gate, and an evidence store. Ads in the terminal pay for the inference —
    ad content never reaches the model.
  • Evidence-first by construction: observations are recorded before findings,
    a finding with no cited evidence is rejected, and only verified findings
    are reported.
  • Host-only: Ardent runs on this machine, with no sandbox. Scope and
    guardrails come from your engagement config at
    ~/.free-pi/agent/ardent/engagement.json.
  • One session per account at a time. If you close the terminal, relaunch
    with "ardent" — or resume where you left off with
    "ardent --session <id>" (the id prints when you exit).

Run /scope to set up an engagement, or /ardent for status.
Set ${INTRO_ENV_SKIP}=1 to skip this next time.
`.trim();

/** True when the user opted out of the first-run intro via env. */
export function introSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[INTRO_ENV_SKIP];
  return v === "1" || v === "true";
}

/**
 * Print the first-run intro unless the user opted out. Pure I/O via `log` so
 * run.ts stays testable; call it only on the first-run (no-JWT) path.
 */
export function showIntro(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): void {
  if (introSkipped(env)) return;
  log(`\n${INTRO_TEXT}\n`);
}
