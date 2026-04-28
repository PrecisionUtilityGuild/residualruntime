const { build } = require("esbuild");

async function main() {
  await build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    bundle: true,
    minify: true,
    format: "cjs",
    platform: "node",
    target: ["node22.13"],
    packages: "external",
    legalComments: "none",
  });

  await build({
    entryPoints: ["src/mcp/server.ts", "src/mcp/migrate.ts"],
    outdir: "dist/mcp",
    outbase: "src/mcp",
    bundle: true,
    minify: true,
    format: "cjs",
    platform: "node",
    target: ["node22.13"],
    packages: "external",
    legalComments: "none",
  });
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Release build failed: ${message}\n`);
  process.exit(1);
});
