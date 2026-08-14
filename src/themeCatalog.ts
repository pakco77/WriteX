import { BUILTIN_THEMES } from "./themeBuiltins.ts";
import { GENERATED_THEME_CATALOG } from "./themeCatalog.generated.ts";

export interface ThemeCatalogEntry {
  id: string;
  name: string;
  version: string;
  delivery: "builtin" | "download";
  defaultInstalled: boolean;
  downloadUrl?: string;
  byteLength?: number;
  sha256?: string;
  author: string;
  license: string;
  sourceUrl: string;
  minWriteXVersion: string;
}

const builtinEntries: ThemeCatalogEntry[] = Object.values(BUILTIN_THEMES).map(theme => ({
  id: theme.manifest.id,
  name: theme.manifest.name,
  version: theme.manifest.version,
  delivery: "builtin",
  defaultInstalled: true,
  author: theme.manifest.author,
  license: theme.manifest.license,
  sourceUrl: theme.manifest.sourceUrl,
  minWriteXVersion: theme.manifest.minWriteXVersion,
}));

export const THEME_CATALOG: readonly ThemeCatalogEntry[] = Object.freeze([
  ...builtinEntries,
  ...GENERATED_THEME_CATALOG,
]);
