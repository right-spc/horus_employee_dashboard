// ============================================
// EDGE FUNCTION: kb-ingest
// Accepts knowledge base content in plain
// text/markdown or FAQ JSON format, parses it
// into structured sections, and appends a new
// IMMUTABLE KB version (kb.kb_versions), moving
// the org's active_kb_version_id pointer.
// Called by dashboard-api only (internal secret).
//
// POST /kb-ingest
// Body (markdown):
// {
//   "organization_id": "uuid",
//   "title": "Cancellation Policy",
//   "format": "markdown",
//   "content": "## Section\n\nContent here..."
// }
//
// Body (FAQ JSON):
// {
//   "organization_id": "uuid",
//   "title": "Pricing FAQ",
//   "format": "faq",
//   "content": [{ "question": "...", "answer": "..." }]
// }
//
// Semantics:
//   - no "id"  -> parsed sections are APPENDED to the current KB
//   - "id" set -> parsed sections REPLACE the whole KB (edit flow)
// Both create a new version; nothing is edited in place.
//
// Optional: "change_summary", "source", "created_by",
// "created_by_name".
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ── Types ─────────────────────────────────────
interface Section {
  title: string;
  body: string;
}

interface IngestRequest {
  organization_id: string;
  title: string;
  format: "markdown" | "faq";
  content: string | Array<{ question: string; answer: string }>;
  id?: string;             // set = replace whole KB (edit flow); unset = append
  change_summary?: string;
  source?: string;         // dashboard | customer_amend | template
  created_by?: string;
  created_by_name?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-internal-secret",
};

// ── Main Handler ─────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Verify internal secret — this function is called by dashboard-api only
  const secret = req.headers.get("x-internal-secret");
  if (secret !== Deno.env.get("INTERNAL_API_SECRET")) {
    return errorResponse("Unauthorized", 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  // ── Validate request ──────────────────────
  if (!body.organization_id) return errorResponse("Missing organization_id", 400);
  if (!body.title?.trim()) return errorResponse("Missing title", 400);
  if (!body.format) return errorResponse("Missing format — must be 'markdown' or 'faq'", 400);
  if (!["markdown", "faq"].includes(body.format)) {
    return errorResponse("Invalid format — must be 'markdown' or 'faq'", 400);
  }
  if (!body.content) return errorResponse("Missing content", 400);

  // ── Verify org exists, get active version pointer ──
  const { data: org, error: orgError } = await supabase
    .schema("core").from("organizations")
    .select("id, active_kb_version_id")
    .eq("id", body.organization_id)
    .single();

  if (orgError || !org) {
    return errorResponse(`Organization not found: ${body.organization_id}`, 404);
  }

  // ── Parse content into sections ───────────
  let parsed: Section[];
  try {
    parsed = body.format === "markdown"
      ? markdownToSections(body.content as string)
      : faqToSections(body.content as Array<{ question: string; answer: string }>);
  } catch (e) {
    return errorResponse(`Failed to parse content: ${e.message}`, 400);
  }

  if (parsed.length === 0) {
    return errorResponse("No content could be extracted from the document", 400);
  }

  // ── Load current active sections (if any) ──
  let currentSections: Section[] = [];
  let currentMaxVersion = 0;
  if (org.active_kb_version_id) {
    const { data: activeVersion } = await supabase
      .schema("kb").from("kb_versions")
      .select("sections")
      .eq("id", org.active_kb_version_id)
      .single();
    currentSections = (activeVersion?.sections as Section[]) || [];
  }

  const { data: maxRow } = await supabase
    .schema("kb").from("kb_versions")
    .select("version")
    .eq("organization_id", body.organization_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  currentMaxVersion = maxRow?.version ?? 0;

  // ── Compose the new version's sections ────
  const replacing = !!body.id;
  const newSections = replacing ? parsed : [...currentSections, ...parsed];
  const changeSummary = body.change_summary?.trim()
    || (replacing ? `Updated knowledge base` : `Added "${body.title.trim()}"`);

  // ── Insert new immutable version ──────────
  const { data: newVersion, error: insertError } = await supabase
    .schema("kb").from("kb_versions")
    .insert({
      organization_id: body.organization_id,
      version: currentMaxVersion + 1,
      sections: newSections,
      change_summary: changeSummary,
      source: body.source || "dashboard",
      created_by: body.created_by || null,
      created_by_name: body.created_by_name || null,
    })
    .select("id, version")
    .single();

  if (insertError || !newVersion) {
    return errorResponse(`Failed to create KB version: ${insertError?.message}`, 500);
  }

  // ── Move the pointer ──────────────────────
  const { error: pointerError } = await supabase
    .schema("core").from("organizations")
    .update({ active_kb_version_id: newVersion.id })
    .eq("id", body.organization_id);

  if (pointerError) {
    return errorResponse(`Version created but failed to activate: ${pointerError.message}`, 500);
  }

  return new Response(
    JSON.stringify({
      success: true,
      version_id: newVersion.id,
      version: newVersion.version,
      sections_count: newSections.length,
      // legacy alias for the current dashboard toast
      chunks_created: parsed.length,
      action: replacing ? "updated" : "created",
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
});

// ── Markdown → sections ───────────────────────────────────────────────────────
// Splits on ## headings: each heading + its content = one titled section.
// Content before the first heading = one untitled intro section.
// Lone # titles (document title) are stripped as metadata.
function markdownToSections(content: string): Section[] {
  const normalised = content.replace(/\r\n/g, "\n").trim();
  const withoutTitle = normalised.replace(/^#\s+[^\n]+\n?/, "").trim();

  const rawSections = withoutTitle.split(/\n(?=##\s)/);
  const sections: Section[] = [];

  for (const raw of rawSections) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^##\s/.test(trimmed)) {
      const nl = trimmed.indexOf("\n");
      const title = (nl === -1 ? trimmed : trimmed.slice(0, nl)).replace(/^##\s+/, "").trim();
      const bodyText = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
      if (!title && !bodyText) continue;
      if (!bodyText) continue; // heading-only sections carry no knowledge
      sections.push({ title, body: bodyText });
    } else {
      sections.push({ title: "", body: trimmed });
    }
  }

  // Fallback: no ## headings at all → paragraph-based untitled sections
  if (sections.length === 0) {
    return withoutTitle
      .split(/\n{2,}/)
      .map((p) => ({ title: "", body: p.trim() }))
      .filter((s) => s.body.length > 20);
  }

  return sections;
}

// ── FAQ JSON → sections ───────────────────────────────────────────────────────
// Each Q&A pair becomes one section: title = question, body = answer.
function faqToSections(
  pairs: Array<{ question: string; answer: string }>
): Section[] {
  if (!Array.isArray(pairs)) {
    throw new Error("FAQ content must be an array of { question, answer } objects");
  }

  return pairs
    .filter((pair) => pair.question?.trim() && pair.answer?.trim())
    .map((pair) => ({ title: pair.question.trim(), body: pair.answer.trim() }));
}

// ── Helper ────────────────────────────────────────────────────────────────────
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
