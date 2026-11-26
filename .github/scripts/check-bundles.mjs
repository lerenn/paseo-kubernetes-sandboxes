// Static guard for Paseo's bundle boundaries (no install, no network). Paseo bundles shared/ into BOTH the
// client (app) and server (daemon) bundles and client/ into the app, so those trees must not import Node
// builtins, server-only code, or (for shared/) React. The authoritative check is build-plugin.mjs (the real
// Paseo compiler, in CI); this one is fast and runs in `make test`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "plugin");
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const isBuiltin = (s) => s.startsWith("node:") || builtins.has(s.split("/")[0]) || s === "@types/node";

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isSource = (f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f);
const clientEntries = ["index.client.ts", "index.client.tsx"].map((f) => path.join(root, f));
const files = [
  ...["shared", "client"].flatMap((d) => walk(path.join(root, d))),
  ...clientEntries.filter((f) => { try { return statSync(f).isFile(); } catch { return false; } }),
].filter(isSource);

const importRe = /(?:\bimport\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?|\bexport\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
const errors = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const inShared = rel.startsWith("shared" + path.sep);
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const m of src.matchAll(importRe)) {
    const spec = m[1];
    if (isBuiltin(spec)) errors.push(`${rel}: Node builtin "${spec}" is forbidden in shared/ and client/ code`);
    else if (spec.startsWith(".")) {
      const target = path.relative(root, path.resolve(path.dirname(file), spec));
      if (/^(server[\\/]|index\.server)/.test(target)) errors.push(`${rel}: imports server-only code "${spec}"`);
    } else if (inShared && /^(react|react-native|react-dom)(\/|$)/.test(spec)) errors.push(`${rel}: shared/ must not import client-only "${spec}"`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`check-bundles: ${files.length} shared/client source files, no Node builtins or server-only imports`);
