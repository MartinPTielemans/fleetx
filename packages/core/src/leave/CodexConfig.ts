/**
 * Writing Codex's config.toml without losing a write Codex makes meanwhile.
 * (Claude's config goes through ClaudeConfig.ts, under Claude's own lock.)
 *
 * Codex takes no lock: it reads config.toml, edits it, and writes it whole
 * with a temporary file renamed over it. `updateCodexConfig` does the same
 * and checks, right before its rename, that the file is still what it read,
 * so a write of Codex's is lost only if it lands in the instant between that
 * check and the rename. A config that is a link to nothing is refused rather
 * than replaced with a file.
 */
import type * as Effect from "effect/Effect";

import { editFile } from "./Files.ts";

/** Change Codex's config.toml: `edit` gets its text (null: none) and returns the new text, or null for no change. */
export const updateCodexConfig = <E, R>(
  home: string,
  edit: (text: string | null) => Effect.Effect<string | null, E, R>,
) => editFile(`${home}/.codex/config.toml`, edit, { mode: 0o600 });
