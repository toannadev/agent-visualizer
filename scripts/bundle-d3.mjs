// Bundle d3-force + runtime deps → public/*.min.js (prepublishOnly).
// Browser loads UMD dependency files in order, then shim maps d3_force → d3.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packages = ["d3-quadtree", "d3-dispatch", "d3-timer", "d3-force"];

for (const name of packages) {
  const main = require.resolve(name);
  const pkgDir = path.dirname(path.dirname(main));
  const src = path.join(pkgDir, "dist", `${name}.min.js`);
  const dest = path.join(ROOT, "public", `${name}.min.js`);
  if (!fs.existsSync(src)) {
    console.error(`Source file not found: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  if (name === "d3-force") {
    fs.copyFileSync(src, path.join(ROOT, "public", "d3.min.js"));
  }
  console.log(`✓ Bundled ${name} (${fs.statSync(dest).size} bytes)`);
}
