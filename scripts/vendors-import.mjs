// node scripts/vendors-import.mjs <city>-printers.json... : prints upsert SQL to stdout, counts per status to stderr.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { CITIES, toVendorRows, upsertSql } from "./vendors-import-lib.mjs";

{
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node scripts/vendors-import.mjs <city>-printers.json...");
    process.exit(2);
  }
  const counts = {};
  const out = [];
  for (const file of files) {
    const m = basename(file).match(/^([a-z]+)-printers\.json$/);
    if (!m || !CITIES[m[1]]) {
      console.error(`can't tell the city from "${file}" (expected <city>-printers.json)`);
      process.exit(2);
    }
    const rows = toVendorRows(m[1], JSON.parse(readFileSync(file, "utf8")), (m) => console.error(`warning: ${m}`));
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    out.push(upsertSql(rows));
  }
  console.log(out.join("\n"));
  console.error(Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(", "));
}
