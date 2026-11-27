import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";

export function readTLS(directory, load = readFileSync) {
  // A projected Secret swaps its ..data symlink atomically. Read both keys from one revision.
  const root = load === readFileSync ? realpathSync(join(directory, "..data")) : directory;
  return { key: load(join(root, "tls.key")), cert: load(join(root, "tls.crt")) };
}

export function reloadTLS(server, options) {
  setInterval(() => {
    try {
      server.setSecureContext({ ...options(), minVersion: "TLSv1.2" });
    } catch (error) {
      console.error("Could not reload TLS files:", error.code ?? error.name);
    }
  }, 30_000).unref();
}

export function validateTLS(options) {
  createSecureContext(options);
  return options;
}
