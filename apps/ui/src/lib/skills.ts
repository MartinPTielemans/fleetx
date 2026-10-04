/** What the skills views say, as text. */

/** The note for skills a whole-fleet update left out, or null when it left none out. */
export const skippedNote = (skipped: ReadonlyArray<string>) =>
  skipped.length === 0
    ? null
    : `Skipped ${skipped.join(", ")}: sync holds back an edit there that looks like a secret. \`t3-fleet secrets scan\` on this machine shows where.`;
