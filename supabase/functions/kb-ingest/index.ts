// ============================================
// EDGE FUNCTION: kb-ingest
// Accepts a knowledge base document in plain
// text/markdown or FAQ JSON format, chunks it,
// and upserts it into kb_documents + kb_chunks.
// Requires a valid JWT (dashboard use only —
// not a public endpoint).
//
// POST /kb-ingest
// Body (markdown):
// {
//   "organization_id": "uuid",
//   "title": "Cancellation Policy",
//   "description": "Optional summary",
//   "format": "markdown",
//   "content": "## Section\n\nContent here..."
// }
//
// Body (FAQ JSON):
// {
//   "organization_id": "uuid",
//   "title": "Pricing FAQ",
//   "description": "Optional summary",
//   "format": "faq",
//   "content": [
//     { "question": "How much does X cost?", "answer": "X costs $50." },
//     ...
//   ]
// }
//
// To update an existing document, include its id:
// {
//   "id": "existing-doc-uuid",
//   ...
// }
// All existing chunks for that document will be
// replaced with the newly ingested ones.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ── Types ─────────────────────────────────────
interface MarkdownRequest {
  organization_id: string;
  title: string;
  description?: string;
  format: "markdown";
  content: string;         // Raw markdown / plain text
  id?: string;             // If provided, update existing document
}

interface FaqRequest {
  organization_id: string;
  title: string;
  description?: string;
  format: "faq";
  content: Array<{
    question: string;
    answer: string;
  }>;
  id?: string;
}

type IngestRequest = MarkdownRequest | FaqRequest;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
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

  // ── Verify org exists ─────────────────────
  const { data: org, error: orgError } = await supabase
    .schema("core").from("organizations")
    .select("id")
    .eq("id", body.organization_id)
    .single();

  if (orgError || !org) {
    return errorResponse(`Organization not found: ${body.organization_id}`, 404);
  }

  // ── Chunk the content ─────────────────────
  let chunks: string[];
  try {
    if (body.format === "markdown") {
      chunks = chunkMarkdown(body.content);
    } else {
      chunks = chunkFaq(body.content as FaqRequest["content"]);
    }
  } catch (e) {
    return errorResponse(`Failed to parse content: ${e.message}`, 400);
  }

  if (chunks.length === 0) {
    return errorResponse("No content could be extracted from the document", 400);
  }

  // ── Upsert kb_document ────────────────────
  const contentSize = typeof body.content === "string"
    ? new TextEncoder().encode(body.content).length
    : new TextEncoder().encode(JSON.stringify(body.content)).length;

  let documentId: string;

  if (body.id) {
    // Update existing document
    const { data: existing, error: fetchError } = await supabase
      .schema("kb").from("kb_documents")
      .select("id")
      .eq("id", body.id)
      .eq("organization_id", body.organization_id)
      .single();

    if (fetchError || !existing) {
      return errorResponse(`Document not found: ${body.id}`, 404);
    }

    const { error: updateError } = await supabase
      .schema("kb").from("kb_documents")
      .update({
        title: body.title.trim(),
        description: body.description?.trim() ?? null,
        file_type: body.format === "markdown" ? "markdown" : "json",
        file_size_bytes: contentSize,
        status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.id);

    if (updateError) {
      return errorResponse(`Failed to update document: ${updateError.message}`, 500);
    }

    documentId = body.id;

    // Delete all existing chunks — they will be replaced below
    const { error: deleteError } = await supabase
      .schema("kb").from("kb_chunks")
      .delete()
      .eq("document_id", documentId);

    if (deleteError) {
      return errorResponse(`Failed to clear existing chunks: ${deleteError.message}`, 500);
    }
  } else {
    // Insert new document
    const { data: newDoc, error: insertError } = await supabase
      .schema("kb").from("kb_documents")
      .insert({
        organization_id: body.organization_id,
        title: body.title.trim(),
        description: body.description?.trim() ?? null,
        file_type: body.format === "markdown" ? "markdown" : "json",
        file_size_bytes: contentSize,
        status: "processing",
      })
      .select("id")
      .single();

    if (insertError || !newDoc) {
      return errorResponse(`Failed to create document: ${insertError?.message}`, 500);
    }

    documentId = newDoc.id;
  }

  // ── Insert chunks ─────────────────────────
  const chunkRows = chunks.map((content, index) => ({
    document_id: documentId,
    organization_id: body.organization_id,
    chunk_index: index,
    content: content.trim(),
    chunk_code: generateChunkCode(),
    metadata: {
      format: body.format,
      document_title: body.title.trim(),
      chunk_count: chunks.length,
    },
  }));

  const { error: chunksError } = await supabase
    .schema("kb").from("kb_chunks")
    .insert(chunkRows);

  if (chunksError) {
    // Mark document as errored
    await supabase
      .schema("kb").from("kb_documents")
      .update({ status: "error", error_message: chunksError.message })
      .eq("id", documentId);
    return errorResponse(`Failed to insert chunks: ${chunksError.message}`, 500);
  }

  // ── Mark document as ready ────────────────
  await supabase
    .schema("kb").from("kb_documents")
    .update({ status: "ready" })
    .eq("id", documentId);

  return new Response(
    JSON.stringify({
      success: true,
      document_id: documentId,
      chunks_created: chunks.length,
      action: body.id ? "updated" : "created",
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
});

// ── Markdown chunker ──────────────────────────────────────────────────────────
// Splits markdown on ## headings. Each heading + its following content = 1 chunk.
// Content before the first heading is treated as an introduction chunk.
// Single # headings (document title) are stripped rather than used as chunk boundaries.
function chunkMarkdown(content: string): string[] {
  const chunks: string[] = [];

  // Normalise line endings
  const normalised = content.replace(/\r\n/g, "\n").trim();

  // Strip lone H1 title at the top if present — it's document metadata, not a chunk
  const withoutTitle = normalised.replace(/^#\s+[^\n]+\n?/, "").trim();

  // Split on ## headings
  const sections = withoutTitle.split(/\n(?=##\s)/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Skip sections that are only a heading with no content
    const lines = trimmed.split("\n");
    const hasContent = lines.some((line, i) => i > 0 && line.trim().length > 0);
    if (lines.length === 1 && !hasContent) continue;
    if (!hasContent && lines[0].startsWith("##")) continue;

    chunks.push(trimmed);
  }

  // If no ## headings found, fall back to paragraph-based chunking
  if (chunks.length === 0) {
    return chunkByParagraph(withoutTitle);
  }

  return chunks;
}

// Fallback: split on blank lines when no headings are present
function chunkByParagraph(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20); // Skip very short fragments
}

// ── FAQ chunker ───────────────────────────────────────────────────────────────
// Each Q&A pair becomes one chunk formatted as:
//   Q: <question>
//   A: <answer>
function chunkFaq(
  pairs: Array<{ question: string; answer: string }>
): string[] {
  if (!Array.isArray(pairs)) {
    throw new Error("FAQ content must be an array of { question, answer } objects");
  }

  return pairs
    .filter((pair) => pair.question?.trim() && pair.answer?.trim())
    .map((pair) => `Q: ${pair.question.trim()}\nA: ${pair.answer.trim()}`);
}

// ── Chunk code generator ─────────────────────────────────────────────────────
// Produces a random 6-char alphanumeric code for each KB chunk.
// Used by Haiku at query time to identify which chunks to return.
function generateChunkCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── Helper ────────────────────────────────────────────────────────────────────
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
