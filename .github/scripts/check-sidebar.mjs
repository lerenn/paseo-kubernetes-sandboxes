// Checks that every "On this page" sidebar link has a matching id, and every h2/h3 id is listed.
import { readFileSync } from "node:fs";
let bad = 0;
for (const f of ["website/reference.html", "website/how-it-works.html"]) {
  const html = readFileSync(f, "utf8");
  const nav = html.match(/<nav aria-label="On this page">([\s\S]*?)<\/nav>/);
  if (!nav) { console.error(`${f}: no On this page nav`); bad++; continue; }
  const links = [...nav[1].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
  const all = [...html.matchAll(/<h[23]\b[^>]*>/g)].filter((m) => !/\bid="/.test(m[0]));
  if (all.length) { console.error(`${f}: ${all.length} heading(s) without id`); bad++; }
  for (const l of links) if (!ids.includes(l)) { console.error(`${f}: sidebar link #${l} has no heading id`); bad++; }
  for (const i of ids) if (!links.includes(i)) { console.error(`${f}: heading #${i} missing from sidebar`); bad++; }
  console.log(`${f}: ${links.length} links, ${ids.length} headings`);
}
process.exit(bad ? 1 : 0);
