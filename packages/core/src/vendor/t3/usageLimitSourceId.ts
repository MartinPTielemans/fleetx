// Vendored from T3 Code (https://github.com/pingdotgg/t3code, MIT) at a21702d0:packages/contracts/src/usageLimitSourceId.ts.
// Do not edit; refresh with scripts/vendor-t3.sh.
import * as Schema from "effect/Schema";

/**
 * Key of one `settings.usageLimitSources` entry. Lives in its own module so
 * both the settings and the usage-limit contracts can import it without
 * importing each other.
 */
export const UsageLimitSourceId = Schema.String.pipe(Schema.brand("UsageLimitSourceId"));
export type UsageLimitSourceId = typeof UsageLimitSourceId.Type;
