// ── KB Tab (versioned sections editor) ────────────────────────────────────────
// One knowledge base per org: an append-only chain of versions, each a list of
// structured sections ({title, body}). Edits are local until "Save as New
// Version" — nothing is edited in place; rollback creates a NEW version copying
// the old one. See docs/client-rbac-plan.md §5.

let _kb = null; // { orgId, sections: [{title, body, _editing?, _collapsed?}], dirty, activeVersionNum }

async function renderKbTab(el, kbDocs, org) {
  el.innerHTML = `<div class="card"><div class="loading-overlay"><div class="spinner"></div> Loading...</div></div>`;
  try {
    const [{ versions }, { requests }] = await Promise.all([
      api("list_kb_versions", { org_id: org.id }),
      api("list_kb_amend_requests", { org_id: org.id }),
    ]);

    let sections = [];
    if (org.active_kb_version_id) {
      const { version } = await api("get_kb_version", { org_id: org.id, version_id: org.active_kb_version_id });
      sections = (version.sections || []).map(s => ({ title: s.title || "", body: s.body || "" }));
    }

    _kb = {
      orgId: org.id,
      sections,
      dirty: false,
      activeVersionNum: (versions.find(v => v.id === org.active_kb_version_id) || {}).version || null,
    };

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Knowledge Base ${_kb.activeVersionNum ? `<span class="badge badge-blue" style="margin-left:6px">v${_kb.activeVersionNum}</span>` : ""}</div>
          <div class="flex-row">
            ${!currentIsDemo ? `<button class="btn btn-secondary btn-sm" onclick="showUseTemplateModal('kb')">Use Template</button>` : ""}
            <button class="btn btn-primary btn-sm" onclick="kbAddSection()">${ICONS.plus} Add Section</button>
          </div>
        </div>
        <div id="kb-sections"></div>
        <div class="card-body" id="kb-save-bar" style="display:none;border-top:1px solid var(--border)">
          <div class="form-group" style="margin-bottom:8px">
            <label>Change summary <span class="hint">(required — becomes the version's history entry)</span></label>
            <input type="text" id="kb-change-summary" placeholder="e.g. Updated refund policy" />
          </div>
          <div class="flex-row">
            <button class="btn btn-primary" id="kb-save-btn" onclick="kbSaveVersion()">Save as New Version</button>
            <button class="btn btn-secondary" onclick="renderKbTab(document.getElementById('tab-content'), null, window._orgData.org)">Discard Changes</button>
          </div>
        </div>
      </div>
      ${kbAmendRequestsHtml(requests || [])}
      ${kbVersionHistoryHtml(versions || [])}`;
    kbRenderSections();
  } catch (e) {
    el.innerHTML = `<div class="card"><div class="card-body"><div class="alert alert-danger">${escHtml(e.message)}</div></div></div>`;
  }
}

function kbRenderSections() {
  const wrap = document.getElementById("kb-sections");
  if (!wrap || !_kb) return;

  if (_kb.sections.length === 0) {
    wrap.innerHTML = `<div class="card-body"><div class="empty-state"><p>No knowledge yet. Add a section to get started.</p></div></div>`;
    return;
  }

  wrap.innerHTML = _kb.sections.map((s, i) => {
    if (s._editing) return kbSectionEditorHtml(s, i);
    const body = s._collapsed
      ? ""
      : `<div style="padding:10px 16px 14px;border-top:1px solid var(--border)">${kbFormatBody(s.body)}</div>`;
    return `
      <div style="border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:4px;padding:8px 16px;">
          <button class="btn btn-ghost btn-sm" title="Move up" onclick="kbMoveSection(${i},-1)" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn btn-ghost btn-sm" title="Move down" onclick="kbMoveSection(${i},1)" ${i === _kb.sections.length - 1 ? "disabled" : ""}>↓</button>
          <div style="flex:1;font-weight:600;cursor:pointer" onclick="kbToggleSection(${i})">${escHtml(s.title || "Untitled section")}</div>
          <button class="btn btn-ghost btn-sm" onclick="kbEditSection(${i})">Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="kbDeleteSection(${i})">Delete</button>
        </div>
        ${body}
      </div>`;
  }).join("");
}

function kbSectionEditorHtml(s, i) {
  return `
    <div style="border-top:1px solid var(--border);padding:12px 16px;">
      <div class="form-group" style="margin-bottom:8px">
        <input type="text" id="kb-edit-title-${i}" value="${escHtml(s.title)}" placeholder="Section title (e.g. Refund Policy)" />
      </div>
      <div class="flex-row" style="margin-bottom:6px;gap:4px">
        <button class="btn btn-ghost btn-sm" onclick="kbFormat(${i},'bold')" title="Bold"><strong>B</strong></button>
        <button class="btn btn-ghost btn-sm" onclick="kbFormat(${i},'list')" title="Bullet list">• List</button>
        <button class="btn btn-ghost btn-sm" onclick="kbFormat(${i},'link')" title="Link">🔗 Link</button>
      </div>
      <textarea id="kb-edit-body-${i}" rows="8" style="width:100%">${escHtml(s.body)}</textarea>
      <div class="flex-row" style="margin-top:8px">
        <button class="btn btn-primary btn-sm" onclick="kbSaveSectionEdit(${i})">Done</button>
        <button class="btn btn-ghost btn-sm" onclick="kbCancelSectionEdit(${i})">Cancel</button>
      </div>
    </div>`;
}

function kbMarkDirty() {
  _kb.dirty = true;
  const bar = document.getElementById("kb-save-bar");
  if (bar) bar.style.display = "";
}

function kbAddSection() {
  _kb.sections.push({ title: "", body: "", _editing: true });
  kbMarkDirty();
  kbRenderSections();
  const t = document.getElementById(`kb-edit-title-${_kb.sections.length - 1}`);
  if (t) t.focus();
}

function kbToggleSection(i) {
  _kb.sections[i]._collapsed = !_kb.sections[i]._collapsed;
  kbRenderSections();
}

function kbEditSection(i) {
  _kb.sections[i]._editing = true;
  kbRenderSections();
}

function kbSaveSectionEdit(i) {
  const title = document.getElementById(`kb-edit-title-${i}`).value.trim();
  const body = document.getElementById(`kb-edit-body-${i}`).value.trim();
  if (!title && !body) { toast("Section is empty — add content or delete it.", "error"); return; }
  _kb.sections[i] = { title, body };
  kbMarkDirty();
  kbRenderSections();
}

function kbCancelSectionEdit(i) {
  const s = _kb.sections[i];
  if (!s.title && !s.body) _kb.sections.splice(i, 1); // cancel on a brand-new empty section removes it
  else s._editing = false;
  kbRenderSections();
}

function kbDeleteSection(i) {
  const s = _kb.sections[i];
  if (!confirm(`Delete section "${s.title || "Untitled"}"? (Applied when you save the new version — previous versions keep it.)`)) return;
  _kb.sections.splice(i, 1);
  kbMarkDirty();
  kbRenderSections();
}

function kbMoveSection(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= _kb.sections.length) return;
  const tmp = _kb.sections[i];
  _kb.sections[i] = _kb.sections[j];
  _kb.sections[j] = tmp;
  kbMarkDirty();
  kbRenderSections();
}

// Toolbar formatting — wraps the textarea selection with lightweight markup
// (bold / bullet list / link). Stored as plain text; rendered formatted.
function kbFormat(i, kind) {
  const ta = document.getElementById(`kb-edit-body-${i}`);
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  if (kind === "bold") {
    ta.setRangeText(`**${sel || "bold text"}**`, start, end, "end");
  } else if (kind === "list") {
    ta.setRangeText((sel || "item").split("\n").map(l => `- ${l}`).join("\n"), start, end, "end");
  } else if (kind === "link") {
    const url = prompt("Link URL:", "https://");
    if (!url) return;
    ta.setRangeText(`[${sel || "link text"}](${url})`, start, end, "end");
  }
  ta.focus();
}

async function kbSaveVersion() {
  const summary = document.getElementById("kb-change-summary").value.trim();
  if (!summary) { toast("Please add a change summary — it becomes the version's history entry.", "error"); return; }
  const btn = document.getElementById("kb-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    const sections = _kb.sections.map(s => ({ title: s.title, body: s.body }));
    const res = await api("save_kb_sections", { org_id: _kb.orgId, sections, change_summary: summary });
    toast(`Knowledge base saved as v${res.version}`, "success");
    await kbRefresh();
  } catch (e) {
    toast(e.message, "error");
    btn.disabled = false;
    btn.textContent = "Save as New Version";
  }
}

async function kbRefresh() {
  const data = await api("get_org", { org_id: currentOrgId });
  window._orgData = data;
  renderKbTab(document.getElementById("tab-content"), null, data.org);
}

// ── Version history ───────────────────────────────────────────────────────────

function kbVersionHistoryHtml(versions) {
  if (versions.length === 0) return "";
  const rows = versions.map(v => `
    <tr>
      <td><span class="badge badge-blue">v${v.version}</span></td>
      <td>${escHtml(v.change_summary || "—")}</td>
      <td class="text-sm text-muted">${escHtml(v.created_by_name || v.source)}</td>
      <td class="text-sm text-muted">${new Date(v.created_at).toLocaleString()}</td>
      <td class="table-actions">
        <button class="btn btn-ghost btn-sm" onclick="kbViewVersion('${v.id}', ${v.version})">View</button>
        <button class="btn btn-ghost btn-sm" onclick="kbRollback('${v.id}', ${v.version})">Rollback</button>
      </td>
    </tr>`).join("");
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">Version History</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Version</th><th>Change</th><th>By</th><th>When</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function kbViewVersion(versionId, versionNum) {
  try {
    const { version } = await api("get_kb_version", { org_id: currentOrgId, version_id: versionId });
    const sections = (version.sections || []).map(s => `
      <div style="margin-bottom:16px">
        <div style="font-weight:600;margin-bottom:4px">${escHtml(s.title || "Untitled section")}</div>
        <div class="text-sm">${kbFormatBody(s.body || "")}</div>
      </div>`).join("");
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.innerHTML = `
      <div class="modal" style="max-width:720px">
        <div class="modal-header">
          <div class="modal-title">Knowledge Base — v${versionNum}</div>
          <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
        </div>
        <div class="modal-body">${sections || '<p class="text-muted">Empty version.</p>'}</div>
      </div>`;
    document.body.appendChild(modal);
  } catch (e) { toast(e.message, "error"); }
}

async function kbRollback(versionId, versionNum) {
  if (!confirm(`Roll back to v${versionNum}?\n\nThis does NOT delete history — it creates a new version copying v${versionNum}'s content and makes it live.`)) return;
  try {
    const res = await api("rollback_kb_version", { org_id: currentOrgId, version_id: versionId });
    toast(`Rolled back to v${versionNum} — now live as v${res.version}`, "success");
    await kbRefresh();
  } catch (e) { toast(e.message, "error"); }
}

// ── Amend requests (customer-submitted KB changes, employee review) ───────────

function kbAmendRequestsHtml(requests) {
  const pending = requests.filter(r => r.status === "pending");
  if (pending.length === 0) return "";
  const rows = pending.map(r => `
    <tr>
      <td>
        <div class="font-semibold">${escHtml(r.title)}</div>
        <div class="text-sm text-muted" style="white-space:pre-wrap">${escHtml(r.content)}</div>
      </td>
      <td class="text-sm text-muted">${new Date(r.created_at).toLocaleDateString()}</td>
      <td class="table-actions">
        <button class="btn btn-primary btn-sm" onclick="kbReviewAmend('${r.id}','apply')">Apply</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="kbReviewAmend('${r.id}','dismiss')">Dismiss</button>
      </td>
    </tr>`).join("");
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">Amend Requests (${pending.length} pending)</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Request</th><th>Submitted</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function kbReviewAmend(requestId, action) {
  let reviewer_notes = null;
  if (action === "apply") {
    if (!confirm("Apply this request? It will be appended to the knowledge base as a new section, in a new version.")) return;
  } else {
    reviewer_notes = prompt("Reason for dismissing (optional — cancel to abort):");
    if (reviewer_notes === null) return;
    if (!reviewer_notes.trim()) reviewer_notes = null;
  }
  try {
    const res = await api("review_kb_amend", { org_id: currentOrgId, request_id: requestId, action, reviewer_notes });
    toast(action === "apply" ? `Applied — now live as v${res.version}` : "Request dismissed", "success");
    await kbRefresh();
  } catch (e) { toast(e.message, "error"); }
}

// ── Lightweight body renderer ─────────────────────────────────────────────────
// Plain-text sections may contain **bold**, *italic*, `code`, [links](url) and
// "- " bullet lines (inserted via the editor toolbar). Rendered formatted here;
// the raw markup is never shown to the user as editable syntax.
function kbFormatBody(text) {
  const esc = escHtml(text || "");
  const inline = esc
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = inline.split("\n");
  let out = "", inList = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("- ")) {
      if (!inList) { out += "<ul style='margin:4px 0;padding-left:20px'>"; inList = true; }
      out += `<li>${line.trimStart().slice(2)}</li>`;
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      out += line ? line + "<br>" : "<br>";
    }
  }
  if (inList) out += "</ul>";
  return out;
}
