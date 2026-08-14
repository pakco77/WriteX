import { createHash } from "node:crypto";
import { GENERATED_THEME_CATALOG } from "../src/themeCatalog.generated.ts";
import { validateThemePackage } from "../src/themeSchema.ts";

for (const entry of GENERATED_THEME_CATALOG.filter(item => item.delivery === "download")) {
  if (!entry.downloadUrl || !entry.sha256 || entry.byteLength === undefined) {
    throw new Error(`${entry.id}: release metadata is incomplete`);
  }
  const response = await fetch(entry.downloadUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${entry.id}: HTTP ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== entry.byteLength) {
    throw new Error(`${entry.id}: expected ${entry.byteLength} bytes, received ${bytes.byteLength}`);
  }
  if (sha256 !== entry.sha256) throw new Error(`${entry.id}: SHA-256 mismatch`);
  const validation = validateThemePackage(JSON.parse(new TextDecoder().decode(bytes)));
  if (!validation.ok || !validation.theme) {
    throw new Error(`${entry.id}: package validation failed: ${validation.errors.join("; ")}`);
  }
  if (validation.theme.manifest.id !== entry.id || validation.theme.manifest.version !== entry.version) {
    throw new Error(`${entry.id}: catalog identity or version mismatch`);
  }
  console.log(`${entry.id}: OK (${bytes.byteLength} bytes, ${sha256})`);
}
