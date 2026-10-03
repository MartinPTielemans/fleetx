/**
 * The registered areas. Order is the order they appear in reports.
 * Adding an area: implement Area (see Area.ts) in areas/ and list it here.
 */
import type { AnyArea } from "./Area.ts";
import { DotfilesArea } from "./areas/Dotfiles.ts";
import { RuntimeArea } from "./areas/Runtime.ts";

export const AREAS: ReadonlyArray<AnyArea> = [RuntimeArea, DotfilesArea];
