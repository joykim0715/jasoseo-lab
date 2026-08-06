/**
 * Sync portfolio content into data/profile.snapshot.json
 *
 * Usage (from jasoseo/):
 *   node scripts/sync-profile.mjs
 *
 * Reads ../portfolio/src/data/content.ts via a lightweight regex extract
 * of key arrays when possible; otherwise refreshes metadata timestamps.
 * Prefer hand-editing profile.snapshot.json for curated STAR episodes.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const snapshotPath = path.join(root, "data", "profile.snapshot.json");
const portfolioContent = path.join(
  root,
  "..",
  "portfolio",
  "src",
  "data",
  "content.ts",
);

if (!existsSync(snapshotPath)) {
  console.error("Missing data/profile.snapshot.json");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

if (existsSync(portfolioContent)) {
  const src = readFileSync(portfolioContent, "utf8");
  const name = src.match(/name:\s*"([^"]+)"/);
  const tagline = src.match(/tagline:\s*"([^"]+)"/);
  const bio = src.match(/bio:\s*"([^"]+)"/);
  if (name) snapshot.name = name[1];
  if (tagline) snapshot.tagline = tagline[1];
  if (bio) snapshot.bio = bio[1];
  snapshot.syncedAt = new Date().toISOString();
  snapshot.portfolioSource = "portfolio/src/data/content.ts";
  console.log("Updated name/tagline/bio from portfolio content.ts");
} else {
  snapshot.syncedAt = new Date().toISOString();
  snapshot.portfolioSource = "snapshot-only (portfolio path not found)";
  console.log("Portfolio content.ts not found — timestamp only.");
}

writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log("Wrote", snapshotPath);
