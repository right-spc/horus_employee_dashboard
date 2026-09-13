// Regenerate the voice-picker preview clips for the curated shortlist.
// Owner-curated via real test calls (Phase 0): Cindy + Kendra rejected (pronunciation).
// Line avoids the word "live" (heteronym trap) but keeps "recorded" so clients
// hear something meaningful. Uses the working key from the Softphone project
// (this project's .env TELNYX_TEMP_KEY is stale).
// Output: public/voice-previews/<slug>.mp3
import fs from "node:fs";
import path from "node:path";

const env = fs.readFileSync("D:/Asus Tuf Drive/Right Spc/Horus Desk/Softphone/.env", "utf8");
const KEY = (env.match(/TELNYX_TEMP_KEY=(.+)/) || [])[1]?.trim();

const LINE = "Thank you for calling! I'm Horus, your AI assistant. " +
  "Every call is recorded for quality, and I can answer questions, take a message, " +
  "or help you book an appointment. What can I do for you today?";

const VOICES = [
  { slug: "rachel", id: "Telnyx.Ultra.10bd4af4-825b-49b8-b8bd-0ca11865536e" },
  { slug: "reed",   id: "Telnyx.Ultra.533b2990-5b82-45a4-b9f2-367776972ca6" },
  { slug: "carson", id: "Telnyx.Ultra.4df027cb-2920-4a1f-8c34-f21529d5c3fe" },
  { slug: "chase",  id: "Telnyx.Ultra.59cb0f89-5d66-49f8-b965-f72b252789e0" },
];

fs.mkdirSync("public/voice-previews", { recursive: true });

// remove stale clips not in the shortlist
for (const f of fs.readdirSync("public/voice-previews")) {
  if (!VOICES.some(v => f === v.slug + ".mp3")) {
    fs.unlinkSync(path.join("public/voice-previews", f));
    console.log("removed stale:", f);
  }
}

for (const v of VOICES) {
  const res = await fetch("https://api.telnyx.com/v2/text-to-speech/speech", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ voice: v.id, text: LINE }),
  });
  if (!res.ok) { console.log(v.slug, "FAIL", res.status, (await res.text()).slice(0, 200)); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join("public/voice-previews", v.slug + ".mp3"), buf);
  console.log(v.slug, "OK", buf.length, "bytes");
}
