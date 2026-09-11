// Live verification: send one widget-chat message and print the AI reply.
const API = "https://oknqxlmyhmxbzqtnlraq.supabase.co/functions/v1/widget-chat";
const apiKey = "hd_live_383b9b5679837196fa7a125c";
const sessionId = `kb-verify-${Date.now()}`;

async function send(message) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ apiKey, sessionId, visitorData: {}, message }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const start = await send("[CONVERSATION_STARTED]");
console.log("START:", start.status, JSON.stringify(start.data).slice(0, 300));

const q = await send("What are your business hours?");
console.log("QUESTION:", q.status);
console.log(JSON.stringify(q.data, null, 2).slice(0, 1500));
