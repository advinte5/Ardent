// Ardent status text for the `/ardent` command.
//
// The startup engagement splash used to live here too. It was removed because
// it re-announced the same scope the persistent HUD strip already shows, and
// it made every startup noisy. Scope is still visible in the HUD (`N targets`),
// via `/scope`, and in full here.
//
// This module is pure: `statusText` is a plain builder with no terminal I/O, so
// it is testable with no fake theme.

export interface ArdentStatusInput {
  /** Build version of the running CLI. */
  version: string;
  /** Absolute path the engagement config is read from. */
  configPath: string;
  /** Whether that file exists right now. */
  configExists: boolean;
  engaged: boolean;
  label?: string;
  targets: string[];
  observations: number;
  findings: number;
  verified: number;
  relations: number;
  paths: number;
}

/**
 * Plain-text status for the `/ardent` command.
 *
 * The point of this command is diagnosis: when someone reports "the TUI looks
 * wrong", this answers build, engagement state, config path and evidence counts
 * in one screen, so the difference between "old build" and "Ardent is idle" is
 * never a guess.
 */
export function statusText(input: ArdentStatusInput): string {
    const head = input.engaged
        ? `ardent ${input.version} · ENGAGEMENT ACTIVE${input.label === undefined ? "" : ` (${input.label})`}`
        : `ardent ${input.version} · idle — no engagement scope`;
    const lines = [`● ${head}`];

    if (input.engaged) {
        const preview = input.targets.slice(0, 6).join(", ");
        const more = input.targets.length > 6 ? ` +${input.targets.length - 6}` : "";
        lines.push(`  ◎ ${input.targets.length} target(s): ${preview}${more}`);
    }
    lines.push(
        `  ✦ ${input.observations} observation(s) · ${input.findings} finding(s) · ${input.verified} verified · ${input.relations} relation(s) · ${input.paths} attack path(s)`,
    );
    lines.push(`  config: ${input.configPath}${input.configExists ? "" : "  (missing)"}`);
    if (!input.engaged) lines.push("  /scope to set up an engagement, or write that config file directly.");
    return lines.join("\n");
}
