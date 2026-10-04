// Filesystem adapters for Ardent, kept separate from the pure modules so the
// domain logic stays SDK- and I/O-free and testable.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArdentConfig, type ArdentConfig } from "./config";
import type { EvidencePersist, EvidenceRecord } from "./evidence";

/** Read and parse an engagement config file. Missing/malformed → undefined. */
export function loadArdentConfigFromFile(filePath: string): ArdentConfig | undefined {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseArdentConfig(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Append-only JSONL evidence sink. One JSON object per line, each with a
 * `kind` discriminant, so the engagement trace can be replayed or read with
 * `jq`. Creates the parent directory on first write; swallows write errors
 * (the EvidenceStore already treats persistence as best-effort).
 */
export function createJsonlEvidenceSink(filePath: string): EvidencePersist {
  return (record: EvidenceRecord) => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    } catch {
      // best-effort; a lost audit line must not abort the engagement
    }
  };
}

/** Synchronously persist a working-memory snapshot next to the evidence log. */
export function writeWorkingMemorySnapshot(filePath: string, snapshot: unknown): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8" });
  } catch {
    // best-effort
  }
}
