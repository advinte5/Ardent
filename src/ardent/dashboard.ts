// Pure content builders for the Ardent overlays.
//
// Plain strings only: `overlay.ts` owns the frame and applies one theme colour
// per row, so these functions stay trivially testable and width-agnostic. The
// panel scrolls, so "too long" is never a correctness problem here.
import type { AttackPath } from "./evidence";
import { SEVERITY_ORDER } from "./types";
import type { Artifact, Finding, Severity } from "./types";

export interface DashboardInput {
    label?: string;
    modelName?: string;
    /** In-scope target strings, already serialized by scope.ts. */
    scope: string[];
    version: string;
    observations: number;
    artifacts: Artifact[];
    findings: Finding[];
    paths: AttackPath[];
}

/** Verified before candidates, then most severe first. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
    const rank = (f: Finding): number => (f.status === "verified" ? 0 : 1);
    const sev = (f: Finding): number => SEVERITY_ORDER.indexOf(f.severity);
    return [...findings].sort((a, b) => rank(a) - rank(b) || sev(b) - sev(a));
}

function severityIndex(severity: Severity): number {
    return SEVERITY_ORDER.indexOf(severity);
}

/** One finding line, worst-first fields. */
export function findingLine(f: Finding): string {
    // Inconclusive gets its own mark: it has been tested and produced no
    // verdict, which is a different report entry from an untested candidate.
    const mark =
        f.status === "verified" ? "✓" : f.status === "refuted" ? "✗" : f.status === "inconclusive" ? "?" : "◆";
    const cites = f.observationIds.length + f.artifactIds.length;
    return `  ${mark} ${f.id}  ${f.severity.toUpperCase().padEnd(8)} ${f.title} — ${f.target}  (${cites} citation${cites === 1 ? "" : "s"})`;
}

export function pathLine(path: AttackPath): string {
    return `  ${path.findingIds.join(" → ")}  (peak ${path.peakSeverity}, ${path.verifiedCount}/${path.findingIds.length} verified)`;
}

function countsLine(input: DashboardInput): string {
    const verified = input.findings.filter((f) => f.status === "verified").length;
    const inconclusive = input.findings.filter((f) => f.status === "inconclusive").length;
    const candidates = input.findings.length - verified - inconclusive;
    const tail = inconclusive > 0 ? ` · ${inconclusive} inconclusive` : "";
    return `  ${input.observations} observation(s) · ${verified} verified · ${candidates} candidate(s)${tail} · ${input.artifacts.length} artifact(s) · ${input.paths.length} path(s)`;
}

function findingSection(input: DashboardInput): string[] {
    const lines: string[] = ["", `FINDINGS  (verified first)`];
    if (input.findings.length === 0) {
        lines.push("  none recorded");
        return lines;
    }
    for (const f of orderFindings(input.findings)) lines.push(findingLine(f));
    return lines;
}

function pathSection(input: DashboardInput): string[] {
    const lines: string[] = ["", `ATTACK PATHS`];
    if (input.paths.length === 0) {
        lines.push("  none assembled (link two findings with ardent_link)");
        return lines;
    }
    const bySeverity = [...input.paths].sort(
        (a, b) => severityIndex(b.peakSeverity) - severityIndex(a.peakSeverity),
    );
    for (const p of bySeverity) lines.push(pathLine(p));
    return lines;
}

/** The full engagement posture: scope, evidence counts, findings, paths. */
export function postureLines(input: DashboardInput): string[] {
    const lines: string[] = [
        `ARDENT ${input.version}${input.modelName ? ` · ${input.modelName}` : ""}`,
        `engagement: ${input.label ?? "(unnamed)"}`,
        "",
        `SCOPE  ${input.scope.length} target(s)`,
    ];
    if (input.scope.length === 0) lines.push("  no targets — /scope");
    for (const target of input.scope) lines.push(`  • ${target}`);
    lines.push("", `EVIDENCE`, countsLine(input));
    lines.push(...findingSection(input));
    lines.push(...pathSection(input));
    return lines;
}

/** Just the findings + paths, for the findings browser. */
export function findingsLines(input: DashboardInput): string[] {
    return [
        `engagement: ${input.label ?? "(unnamed)"}`,
        "",
        `EVIDENCE`,
        countsLine(input),
        ...findingSection(input),
        ...pathSection(input),
    ];
}

/** The overlay subtitle: one line of engagement identity. */
export function dashboardSubtitle(input: DashboardInput): string {
    return input.label ? `engagement ${input.label}` : "no engagement";
}

/**
 * The `/scope` overlay body: the allowlist and where it lives.
 *
 * Read-only on purpose. Changing the scope changes what is *authorized*, so it
 * stays a deliberate file edit until a config writer with explicit confirmation
 * exists (see ARDENT.md).
 */
export function scopeLines(input: DashboardInput, configPath: string): string[] {
    const lines: string[] = [
        `engagement: ${input.label ?? "(unnamed)"}`,
        `config: ${configPath}`,
        "",
        `TARGETS  ${input.scope.length}`,
    ];
    if (input.scope.length === 0) lines.push("  none — an engagement with no targets is not engaged");
    for (const target of input.scope) lines.push(`  • ${target}`);
    lines.push(
        "",
        "Scope is authorization, not a task list.",
        "Edit engagement.json to change it (Ardent never rewrites it silently).",
    );
    return lines;
}
