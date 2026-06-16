// Splits the canonical data/files.json into:
//   public/files.json   — the FULL dataset, served statically and fetched at runtime
//   app/bootstrap.json  — a small curated subset bundled for instant/offline first paint
// Run automatically via the predev/prebuild npm hooks.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "data", "files.json");
const full = JSON.parse(fs.readFileSync(src, "utf8"));
const records = full.records || full;

// signal score: gov files, witnesses, distinctive shape, described detail all rank up
const distinctive = new Set(["disc", "triangle", "cigar", "chevron", "boomerang", "diamond"]);
const signal = (r) => {
  let s = 0;
  if (r.source && r.source.agency !== "NUFORC" && r.source.agency !== "Other") s += 1000;
  if (r.designator) s += 200;
  if (distinctive.has(r.shape)) s += 60;
  s += Math.min(50, Math.log10((r.witnesses || 1) + 1) * 20);
  s += Math.min(40, (r.description || "").length / 12);
  return s;
};

const gov = records.filter((r) => !r.source || r.source.agency !== "NUFORC");
const nuforc = records.filter((r) => r.source && r.source.agency === "NUFORC").sort((a, b) => signal(b) - signal(a));

// bootstrap: every gov/canon record + the strongest ~450 NUFORC reports
const bootRecords = gov.concat(nuforc.slice(0, 450)).sort((a, b) => a.date.localeCompare(b.date));
const bootstrap = { generated_at: full.generated_at, count: bootRecords.length, total: records.length, records: bootRecords };

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "files.json"), JSON.stringify(full));
fs.writeFileSync(path.join(root, "app", "bootstrap.json"), JSON.stringify(bootstrap));

console.log(`sync-data: full=${records.length} -> public/files.json, bootstrap=${bootRecords.length} -> app/bootstrap.json`);
