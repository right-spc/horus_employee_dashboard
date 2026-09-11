// One-off runner: applies a SQL migration file via the Supabase Management API.
// Usage: node scripts/run-migration.mjs <migration-file>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/run-migration.mjs <file>"); process.exit(1); }

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const token = env.match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) { console.error("SUPABASE_ACCESS_TOKEN not found in .env"); process.exit(1); }

const query = readFileSync(file, "utf8");

const res = await fetch(
  "https://api.supabase.com/v1/projects/oknqxlmyhmxbzqtnlraq/database/query",
  {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }
);

const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}:`, text); process.exit(1); }
try {
  const data = JSON.parse(text);
  console.log(JSON.stringify(data, null, 2).slice(0, 4000));
} catch {
  console.log(text.slice(0, 4000));
}
console.log("OK");
