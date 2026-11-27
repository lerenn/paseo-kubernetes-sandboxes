import { readFileSync, writeFileSync } from "node:fs";

const launcher = readFileSync(new URL("./sandbox-exec.mjs", import.meta.url), "utf8");
const source = launcher.replace(/^#![^\n]*\n/, "");
writeFileSync(new URL("../server/launcher-source.generated.ts", import.meta.url),
  `// Generated from launcher/sandbox-exec.mjs.\nexport default ${JSON.stringify(source)};\n`);
