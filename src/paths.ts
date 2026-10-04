import { homedir } from "node:os";
import { join } from "node:path";

// Fully separate from pi's own `~/.pi/agent` so an existing pi install (and
// its credentials/settings/sessions) is never touched by free-pi-cli.
const FREE_PI_DIR_NAME = ".free-pi";

export function getFreePiAgentDir(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "agent");
}

export function getCredentialsPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "credentials.json");
}

/** 0.2.6: the last CLI version whose "what's new" the user has already seen. */
export function getLastSeenVersionPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "last-seen-version");
}

/** #37 U1: the self-update opt-out config file, `~/.free-pi/config.json`. Read-only — never created. */
export function getConfigPath(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "config.json");
}

// ---- Ardent engagement layer ----------------------------------------------
// Ardent's per-engagement state lives under the free-pi agent dir so it stays
// namespaced with the rest of the CLI and separate from any `~/.pi` install.

/** Ardent's state directory: `<agentDir>/ardent`. */
export function getArdentDir(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "ardent");
}

/** The engagement config: `<agentDir>/ardent/engagement.json`. */
export function getArdentConfigPath(agentDir: string = getFreePiAgentDir()): string {
  return join(getArdentDir(agentDir), "engagement.json");
}

/** The append-only evidence log: `<agentDir>/ardent/evidence.jsonl`. */
export function getArdentEvidencePath(agentDir: string = getFreePiAgentDir()): string {
  return join(getArdentDir(agentDir), "evidence.jsonl");
}
