/**
 * The registered areas. Order is the order they appear in reports.
 * Adding an area: implement Area (see Area.ts) in areas/ and list it here.
 */
import type { AnyArea } from "./Area.ts";
import { DotfilesArea, InstructionsArea } from "./areas/Dotfiles.ts";
import { EngineArea } from "./areas/Engine.ts";
import { RuntimeArea } from "./areas/Runtime.ts";
import { McpArea } from "./areas/Mcp.ts";
import { RelayArea } from "./areas/RelayArea.ts";
import { SecretsArea } from "./areas/SecretsArea.ts";
import { SkillsArea } from "./areas/Skills.ts";

export const AREAS: ReadonlyArray<AnyArea> = [RuntimeArea, EngineArea, SecretsArea, RelayArea, DotfilesArea, InstructionsArea, SkillsArea, McpArea];
