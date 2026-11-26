// Runs Paseo's REAL plugin compiler (the one the daemon runs on `paseo plugin install`) against a plugin
// directory, so boundary errors (Node builtins in shared/, server-only code in the client, ...) fail in CI.
// Usage: node build-plugin.mjs <dir containing node_modules/@getpaseo/server> <plugin dir> [paseo version]
import path from "node:path";
import { pathToFileURL } from "node:url";

const [nodeModules, pluginDir, version = "0.17.5"] = process.argv.slice(2);
const compiler = path.resolve(nodeModules, "@getpaseo/server/dist/server/server/plugins/compiler-build.js");
const { compileDirectoryPlugin } = await import(pathToFileURL(compiler).href);
try {
  const r = await compileDirectoryPlugin(path.resolve(pluginDir), version);
  console.log(`Build OK: ${r.manifest.id} (client ${r.clientBundle.length} B, server ${r.serverBundle.length} B)`);
} catch (e) {
  console.error(`Build failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
