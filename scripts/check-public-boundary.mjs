import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = [
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE.md",
  "PRIVACY.md",
  "PUBLIC_BOUNDARY.md",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "TRADEMARKS.md",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "styles.css",
  "versions.json",
];

const excludedDirectories = new Set([".git", "backups", "node_modules"]);
const excludedFiles = new Set([
  "main.js",
  "tests/cloudE2E.test.ts",
  "tests/relayE2E.test.ts",
  "tests/realArticleCopyPlan.test.ts",
  "tests/themeCatalogScript.test.ts",
  "tests/themePacks.test.ts",
]);

const deniedText = [
  ["absolute macOS user path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style secret", /sk-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["Tencent or Alibaba access key", /(?:AKID|LTAI)[A-Za-z0-9]{12,}/],
  ["bearer credential", /Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ["production host path", /\/opt\/(?:write-cloud|write-relay)\//],
  ["known production IP", /8\.135\.53\.227/],
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`Public candidate contains a symlink: ${name}`);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...await walk(path));
    } else if (!excludedFiles.has(name) && !entry.name.startsWith(".env")) {
      files.push(name);
    }
  }
  return files;
}

const files = (await walk(root)).sort();
for (const name of required) {
  if (!files.includes(name)) throw new Error(`Missing required public file: ${name}`);
}

const violations = [];
for (const name of files) {
  if (name === "scripts/check-public-boundary.mjs") continue;
  const bytes = await readFile(resolve(root, name));
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [label, pattern] of deniedText) {
    if (pattern.test(text)) violations.push(`${name}: ${label}`);
  }
}

if (violations.length) {
  throw new Error(`Public-boundary check failed:\n${violations.join("\n")}`);
}

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const versions = JSON.parse(await readFile(resolve(root, "versions.json"), "utf8"));
if (manifest.version !== packageJson.version) throw new Error("package.json and manifest.json versions differ.");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json does not match manifest minAppVersion.");
if (packageJson.license !== "AGPL-3.0-only") throw new Error("Unexpected package license.");

// ponytail: This is an allow/exclude and high-risk-pattern gate, not a full secret scanner; add gitleaks at remote CI when the repository exists.
console.log(JSON.stringify({ ok: true, files: files.length, version: manifest.version, license: packageJson.license }));
