import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles every client component without importing server-only modules", async () => {
  const root = path.resolve("src");
  const entries = fs
    .readdirSync(root, { recursive: true })
    .map((name) => path.join(root, String(name)))
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        /^\s*["']use client["']/.test(fs.readFileSync(file, "utf8")),
    );
  expect(entries.length).toBeGreaterThan(0);
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  const result = await build({
    entryPoints: entries,
    bundle: true,
    platform: "browser",
    packages: "external",
    outdir: "unused-browser-check",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "reject-server-imports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: name, importer }) => {
            if (
              name.startsWith("node:") ||
              builtins.has(name) ||
              ["server-only", "next/headers"].includes(name)
            )
              return {
                errors: [{ text: `Server-only import ${name} in ${importer}` }],
              };
          });
        },
      },
    ],
  });
  expect(result.errors).toEqual([]);
});
