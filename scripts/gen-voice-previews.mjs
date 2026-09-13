// TEMP scratch — generate real Telnyx TTS preview clips for the voice picker.
// Uses the working key from the Softphone project (.env one is stale).
// Output: public/voice-previews/<slug>.mp3
import fs from "node:fs";
import path from "node:path";

const env = fs.readFileSync("D:/Asus Tuf Drive/Right Spc/Horus Desk/Softphone/.env", "utf8");
const KEY = (env.match(/TELNYX_TEMP_KEY=(.+)/) || [])[1]?.trim();

const VOICES = [
  { slug: "cindy",  id: "Telnyx.Ultra.1242fb95-7ddd-44ac-8a05-9e8a22a6137d", line: "Thank you for calling, this is Cindy. How can I help you today?" },
  { slug: "rachel", id: "Telnyx.Ultra.10bd4af4-825b-49b8-b8bd-0ca11865536e", line: "Thank you for calling, this is Rachel. How can I help you today?" },
  { slug: "kendra", id: "Telnyx.Ultra.358e650d-ac0b-4a74-b14f-aca3daa40d79", line: "Thank you for calling, this is Kendra. How can I help you today?" },
  { slug: "reed",   id: "Telnyx.Ultra.533b2990-5b82-45a4-b9f2-367776972ca6", line: "Thank you for calling, this is Reed. How can I help you today?" },
  { slug: "carson", id: "Telnyx.Ultra.4df027cb-2920-4a1f-8c34-f21529d5c3fe", line: "Thank you for calling, this is Carson. How can I help you today?" },
  { slug: "chase",  id: "Telnyx.Ultra.59cb0f89-5d66-49f8-b965-f72b252789e0", line: "Thank you for calling, this is Chase. How can I help you today?" },
];

fs.mkdirSync("public/voice-previews", { recursive: true });

for (const v of VOICES) {
  const res = await fetch("https://api.telnyx.com/v2/text-to-speech/speech", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ voice: v.id, text: v.line }),
  });
  if (!res.ok) {
    console.log(v.slug, "FAIL", res.status, (await res.text()).slice(0, 200));
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join("public/voice-previews", v.slug + ".mp3"), buf);
  console.log(v.slug, "OK", buf.length, "bytes");
}
