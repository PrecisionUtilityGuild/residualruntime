const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const disallowedPrefixes = [
  "dist/__tests__/",
  "dist/examples/",
  "dist/research/",
];

const cacheDir = mkdtempSync(join(tmpdir(), "residual-runtime-pack-cache-"));

let output;

try {
  output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--cache", cacheDir],
    {
      encoding: "utf8",
    }
  );
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

const parsed = JSON.parse(output);
const packResult = Array.isArray(parsed) ? parsed[0] : parsed;
const files = Array.isArray(packResult?.files) ? packResult.files : [];

if (files.length === 0) {
  throw new Error("npm pack --dry-run returned no files to validate.");
}

const unexpected = files
  .map((entry) => entry.path)
  .filter((file) => disallowedPrefixes.some((prefix) => file.startsWith(prefix)));

if (unexpected.length > 0) {
  throw new Error(
    [
      "Package tarball includes files that should stay out of the published npm artifact:",
      ...unexpected.map((file) => `- ${file}`),
    ].join("\n")
  );
}

console.log(`Package check passed (${files.length} files).`);
