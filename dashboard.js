// ============================================
// HORUS DESK DASHBOARD — LOGIC v2
// Auth via Supabase, all DB ops via dashboard-api
// ============================================

// ── Supabase client (anon key only) ──────────────────────────────────────────
let _supabase;
let currentUser = null;   // Supabase Auth user
let dashUser = null;      // Dashboard user record (includes role)
let isOwner = false;

// ── API helper ────────────────────────────────────────────────────────────────

async function api(action, params = {}) {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/dashboard-api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...params }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");

  if (!email || !password) {
    errEl.innerHTML = '<div class="alert alert-danger">Email and password are required.</div>';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Signing in...';
  errEl.innerHTML = "";

  const { error } = await _supabase.auth.signInWithPassword({ email, password });

  if (error) {
    errEl.innerHTML = `<div class="alert alert-danger">${error.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = "Sign In";
  }
  // On success, onAuthStateChange fires and handles the rest
}

async function doLogout() {
  await _supabase?.auth.signOut().catch(() => {});
  onLogout();
}

async function onLogin(user) {
  currentUser = user;

  try {
    const { user: du } = await api("me");
    dashUser = du;
    isOwner = du.role === "owner";

    // Show app, hide login
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "";

    // Update UI for role
    document.getElementById("user-display").innerHTML =
      `<strong>${escHtml(du.display_name)}</strong><br>${du.role}`;

    if (isOwner) {
      document.getElementById("sales-nav-item").style.display = "";
    }

    // Set up nav
    document.querySelectorAll(".nav-item[data-view]").forEach(el => {
    	if (!el.dataset.listenerAttached) {
      	el.dataset.listenerAttached = "true";
      	el.addEventListener("click", () => navigate(el.dataset.view));
    	}
  	});

    navigate("orgs");
  } catch (e) {
    await _supabase.auth.signOut().catch(() => {});
    document.getElementById("login-screen").style.display = "";
    document.getElementById("app-screen").style.display = "none";
    // Show error on login screen after it's visible
    setTimeout(() => {
      const errEl = document.getElementById("login-error");
      if (errEl) errEl.innerHTML = `<div class="alert alert-danger">${e?.message || "Sign in failed. Check your credentials."}</div>`;
    }, 50);
  }
}

function onLogout() {
  currentUser = null;
  dashUser = null;
  isOwner = false;
  document.getElementById("login-screen").style.display = "";
  document.getElementById("app-screen").style.display = "none";
  document.getElementById("login-email").value = "";
  document.getElementById("login-password").value = "";
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = "default") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Router ────────────────────────────────────────────────────────────────────

let currentView = "orgs";
let currentOrgId = null;
let currentOrgName = "";
let currentTab = "overview";
let currentIsDemo = false;

function navigate(view, orgId = null, orgName = "", isDemo = false) {
  currentView = view;
  currentOrgId = orgId;
  currentOrgName = orgName;
  currentIsDemo = isDemo;
  currentTab = "overview";
  document.querySelectorAll(".nav-item[data-view]").forEach(el => {
    el.classList.toggle("active", el.dataset.view === view && !orgId);
  });
  render();
}

async function render() {
  const main = document.getElementById("main");
  if (currentView === "orgs") await renderOrgList(main);
  else if (currentView === "org-detail") await renderOrgDetail(main);
  else if (currentView === "demos") await renderDemoList(main);
  else if (currentView === "demo-detail") await renderDemoDetail(main);
  else if (currentView === "sales") await renderSalesReport(main);
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS = {
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  google: `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972a6.033 6.033 0 110-12.064c1.498 0 2.866.549 3.921 1.453l2.814-2.814A9.969 9.969 0 0012.545 2C7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748l-9.426-.013z" fill="#4285F4"/></svg>`,
  microsoft: `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M11.4 2H2v9.4h9.4V2zM22 2h-9.4v9.4H22V2zM11.4 12.6H2V22h9.4v-9.4zM22 12.6h-9.4V22H22v-9.4z" fill="#00a4ef"/></svg>`,
};

// ── Org List ──────────────────────────────────────────────────────────────────

async function renderOrgList(main) {
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Organizations</div>
        <div class="page-subtitle">${isOwner ? "All organizations" : "Organizations you created today"}</div>
      </div>
      <div class="flex-row">
        <button class="btn btn-primary" onclick="showNewOrgModal()">
          ${ICONS.plus} New Organization
        </button>
        ${isOwner ? `
          <button class="btn btn-danger" onclick="showEmergencyModal()">Disable All</button>
          <button class="btn btn-secondary" onclick="executeEmergencyRestore()">Restore All</button>
        ` : ""}
      </div>
    </div>
    <div class="card">
      <div class="loading-overlay"><div class="spinner"></div> Loading...</div>
    </div>`;

  try {
    const { orgs, providers, widgets } = await api("list_orgs");

    const providerMap = {};
    providers.forEach(p => { providerMap[p.organization_id] = p; });
    const widgetMap = {};
    widgets.forEach(w => { widgetMap[w.organization_id] = w; });

    if (orgs.length === 0) {
      main.querySelector(".card").innerHTML = `
        <div class="empty-state"><p>${isOwner ? "No organizations yet." : "No organizations created today."}</p></div>`;
      return;
    }

    const rows = orgs.map(org => {
      const provider = providerMap[org.id];
      const widget = widgetMap[org.id];
      const pct = org.message_limit_per_month > 0
        ? Math.round((org.messages_used_this_month / org.message_limit_per_month) * 100) : 0;
      const fillClass = pct >= 100 ? "danger" : pct >= 80 ? "warning" : "";

      const providerBadge = provider
        ? `<span class="badge ${provider.status === "active" ? "badge-green" : "badge-red"}">${provider.provider}</span>`
        : `<span class="badge badge-gray">None</span>`;

      const widgetBadge = widget
        ? `<span class="badge ${widget.enabled ? "badge-green" : "badge-red"}">${widget.enabled ? "On" : "Off"}</span>`
        : `<span class="badge badge-gray">—</span>`;

      const emailAiBadge = `<span class="badge ${org.ai_responses_enabled ? "badge-green" : "badge-red"}">${org.ai_responses_enabled ? "On" : "Off"}</span>`;

      const createdBy = org.created_by_name
        ? `<div class="text-xs text-subtle">${escHtml(org.created_by_name)}</div>` : "";

      return `
        <tr>
          <td>
            <a onclick="navigate('org-detail','${org.id}','${escHtml(org.name)}')"
               class="org-link">
              ${escHtml(org.name)}
            </a>
            <div class="text-sm text-muted">${escHtml(org.slug)}</div>
            ${createdBy}
          </td>
          <td>${providerBadge}</td>
          <td>${emailAiBadge}</td>
          <td>${widgetBadge}</td>
          <td>
            <div class="progress-wrap">
              <div class="progress-bar">
                <div class="progress-fill ${fillClass}" style="width:${Math.min(pct, 100)}%"></div>
              </div>
              <span class="progress-label">${org.messages_used_this_month} / ${org.message_limit_per_month}</span>
            </div>
          </td>
        </tr>`;
    }).join("");

    main.querySelector(".card").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Organization</th><th>Email</th><th>Email AI</th><th>Widget</th><th>Usage this month</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

// ── New Org Modal ─────────────────────────────────────────────────────────────

function showNewOrgModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">New Organization</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Business Name</label>
            <input type="text" id="new-org-name" placeholder="Acme Hair Studio" />
          </div>
          <div class="form-group">
            <label>Slug</label>
            <input type="text" id="new-org-slug" placeholder="acme-hair-studio" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>AI Tone</label>
            <select id="new-org-tone">
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
            </select>
          </div>
          <div class="form-group">
            <label>Subscription Tier</label>
            <select id="new-org-tier">
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
        </div>
        ${isOwner ? `
        <div class="form-row">
          <div class="form-group">
            <label>Monthly Message Limit</label>
            <input type="number" id="new-org-limit" value="7000" min="100" />
          </div>
          <div class="form-group">
            <label>Auto-Send Min Confidence</label>
            <input type="number" id="new-org-confidence" value="0.75" min="0" max="1" step="0.05" />
          </div>
        </div>` : ""}
        <div id="new-org-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="create-org-btn" onclick="createOrg()">Create Organization</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById("new-org-name").addEventListener("input", e => {
    document.getElementById("new-org-slug").value = e.target.value
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  });
}

async function createOrg() {
  const name = document.getElementById("new-org-name").value.trim();
  const slug = document.getElementById("new-org-slug").value.trim();
  const errEl = document.getElementById("new-org-error");

  if (!name || !slug) {
    errEl.innerHTML = '<div class="alert alert-danger">Name and slug are required.</div>';
    return;
  }

  const btn = document.getElementById("create-org-btn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Creating...';

  try {
    const params = {
      name, slug,
      ai_tone: document.getElementById("new-org-tone").value,
      subscription_tier: document.getElementById("new-org-tier").value,
    };

    if (isOwner) {
      params.message_limit_per_month = parseInt(document.getElementById("new-org-limit").value);
      params.auto_send_min_confidence = parseFloat(document.getElementById("new-org-confidence").value);
    }

    const { org } = await api("create_org", params);
    document.querySelector(".modal-backdrop").remove();
    toast(`Organization "${name}" created`, "success");
    navigate("org-detail", org.id, org.name);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = "Create Organization";
  }
}

// ── New Demo Modal ───────────────────────────────────────────────────────────

function showNewDemoModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">New Demo</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Field of Work</label>
            <input type="text" id="demo-name" placeholder="Dental Clinic" oninput="
              document.getElementById('demo-slug').value = this.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
            " />
          </div>
          <div class="form-group">
            <label>Slug</label>
            <input type="text" id="demo-slug" placeholder="dental-clinic" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>AI Tone</label>
            <select id="demo-tone">
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
            </select>
          </div>
          <div class="form-group">
            <label>Subscription Tier</label>
            <select id="demo-tier">
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Monthly Message Limit</label>
            <input type="number" id="demo-limit" value="7000" min="100" />
          </div>
          <div class="form-group">
            <label>Auto-Send Min Confidence</label>
            <input type="number" id="demo-confidence" value="0.75" min="0" max="1" step="0.05" />
          </div>
        </div>
        <div id="demo-create-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="demo-create-btn" onclick="createDemo()">Create Demo</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function createDemo() {
  const name = document.getElementById("demo-name").value.trim();
  const slug = document.getElementById("demo-slug").value.trim();
  if (!name || !slug) {
    document.getElementById("demo-create-error").innerHTML = '<div class="alert alert-danger">Name and slug are required.</div>';
    return;
  }

  const btn = document.getElementById("demo-create-btn");
  const errEl = document.getElementById("demo-create-error");
  btn.disabled = true;
  btn.textContent = "Creating...";

  try {
    const { org } = await api("create_demo", {
      name, slug,
      ai_tone: document.getElementById("demo-tone").value,
      subscription_tier: document.getElementById("demo-tier").value,
      message_limit_per_month: parseInt(document.getElementById("demo-limit").value),
      auto_send_min_confidence: parseFloat(document.getElementById("demo-confidence").value),
    });
    document.querySelector(".modal-backdrop").remove();
    navigate("demo-detail", org.id, org.name, true);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.textContent = "Create Demo";
  }
}

// ── Org Detail ────────────────────────────────────────────────────────────────

async function renderOrgDetail(main) {
  main.innerHTML = `
    <div class="breadcrumb">
      <a onclick="navigate('orgs')">Organizations</a>
      <span class="breadcrumb-sep">›</span>
      <span>${escHtml(currentOrgName)}</span>
    </div>
    <div class="loading-overlay"><div class="spinner"></div> Loading...</div>`;

  try {
    const { org, providers, widget, kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs };

    main.innerHTML = `
      <div class="breadcrumb">
        <a onclick="navigate('orgs')">Organizations</a>
        <span class="breadcrumb-sep">›</span>
        <span>${escHtml(org.name)}</span>
      </div>
      <div class="page-header">
        <div>
          <div class="page-title">${escHtml(org.name)}</div>
          <div class="page-subtitle">${escHtml(org.slug)}${org.created_by_name ? ` · Created by ${escHtml(org.created_by_name)}` : ""}</div>
        </div>
      </div>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('overview')">Overview</button>
        <button class="tab" onclick="switchTab('email')">Email Setup</button>
        <button class="tab" onclick="switchTab('widget')">Widget</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('settings')">Settings</button>
      </div>
      <div id="tab-content"></div>`;

    renderTab();
  } catch (e) {
    main.innerHTML += `<div class="alert alert-danger">${e.message}</div>`;
  }
}

// ── Demo List ────────────────────────────────────────────────────────────────

async function renderDemoList(main) {
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Demos</div>
        <div class="page-subtitle">Demo organizations by field of work</div>
      </div>
      ${isOwner ? `<button class="btn btn-primary" onclick="showNewDemoModal()">
        ${ICONS.plus} New Demo
      </button>` : ""}
    </div>
    <div class="card">
      <div class="loading-overlay"><div class="spinner"></div> Loading...</div>
    </div>`;

  try {
    const { demos, widgets } = await api("list_demos");
    const widgetMap = {};
    widgets.forEach(w => { widgetMap[w.organization_id] = w; });

    if (demos.length === 0) {
      main.querySelector(".card").innerHTML = `
        <div class="empty-state"><p>No demo organizations yet.</p></div>`;
      return;
    }

    const rows = demos.map(demo => {
      const widget = widgetMap[demo.id];
      return `
        <tr>
          <td>
            <a onclick="navigate('demo-detail','${demo.id}','${escHtml(demo.name)}',true)"
               class="org-link">
              ${escHtml(demo.name)}
            </a>
            <div class="text-sm text-muted">horusdesk.com/${escHtml(demo.slug)}</div>
          </td>
          <td><span class="badge badge-blue">${escHtml(demo.ai_tone)}</span></td>
          <td><span class="badge ${widget?.enabled ? "badge-green" : "badge-red"}">${widget?.enabled ? "On" : "Off"}</span></td>
        </tr>`;
    }).join("");

    main.querySelector(".card").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Demo</th><th>AI Tone</th><th>Widget</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

// ── Demo Detail ──────────────────────────────────────────────────────────────

async function renderDemoDetail(main) {
  main.innerHTML = `
    <div class="breadcrumb">
      <a onclick="navigate('demos')">Demos</a>
      <span class="breadcrumb-sep">›</span>
      <span>${escHtml(currentOrgName)}</span>
    </div>
    <div class="loading-overlay"><div class="spinner"></div> Loading...</div>`;

  try {
    const { org, providers, widget, kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs };

    main.innerHTML = `
      <div class="breadcrumb">
        <a onclick="navigate('demos')">Demos</a>
        <span class="breadcrumb-sep">›</span>
        <span>${escHtml(org.name)}</span>
      </div>
      <div class="page-header">
        <div>
          <div class="page-title">${escHtml(org.name)}</div>
          <div class="page-subtitle">horusdesk.com/${escHtml(org.slug)}</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-secondary" onclick="resetDemo()">Reset to Default</button>
          ${isOwner ? `<button class="btn btn-secondary" onclick="saveDemoDefaults()">Save as Default</button>` : ""}
        </div>
      </div>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('overview')">Overview</button>
        <button class="tab" onclick="switchTab('widget')">Widget</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('settings')">Settings</button>
      </div>
      <div id="tab-content"></div>`;

    renderTab();
  } catch (e) {
    main.innerHTML += `<div class="alert alert-danger">${e.message}</div>`;
  }
}

async function resetDemo() {
  if (!confirm("Reset this demo to its default state? All current changes will be lost.")) return;
  try {
    await api("reset_demo", { org_id: currentOrgId });
    toast("Demo reset to defaults", "success");
    const { org, providers, widget, kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs };
    currentOrgName = org.name;
    await renderDemoDetail(document.getElementById("main"));
  } catch (e) { toast(e.message, "error"); }
}

async function saveDemoDefaults() {
  if (!confirm("Snapshot the current state of this demo as its new defaults?")) return;
  try {
    await api("save_demo_defaults", { org_id: currentOrgId });
    toast("Defaults saved", "success");
  } catch (e) { toast(e.message, "error"); }
}

// ── Use Template Modal ───────────────────────────────────────────────────────

async function showUseTemplateModal(mode) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Use Demo Template</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="loading-overlay"><div class="spinner"></div> Loading demos...</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  try {
    const { demos } = await api("list_demos");
    const body = modal.querySelector(".modal-body");

    if (demos.length === 0) {
      body.innerHTML = `<div class="alert alert-info">No demo templates available.</div>`;
      return;
    }

    const modeLabel = mode === "kb" ? "Knowledge Base" : "System Prompt";
    const options = demos.map(d =>
      `<label style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-bottom:8px">
        <input type="radio" name="demo-template" value="${d.id}" />
        <div>
          <div class="font-semibold">${escHtml(d.name)}</div>
          <div class="text-sm text-muted">horusdesk.com/${escHtml(d.slug)}</div>
        </div>
      </label>`
    ).join("");

    body.innerHTML = `
      <p class="text-muted" style="font-size:13px;margin-bottom:16px">
        Select a demo template to copy its ${modeLabel} into this organization.
        ${mode === "kb" ? "Existing KB documents will NOT be removed." : "This will overwrite the current system prompt."}
        Widget colors and AI tone will also be applied.
      </p>
      ${options}
      <div id="template-error"></div>`;

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
      <button class="btn btn-primary" id="apply-template-btn" onclick="applyTemplate('${mode}')">Apply Template</button>`;
    modal.querySelector(".modal").appendChild(footer);
  } catch (e) {
    modal.querySelector(".modal-body").innerHTML =
      `<div class="alert alert-danger">${e.message}</div>`;
  }
}

async function applyTemplate(mode) {
  const selected = document.querySelector('input[name="demo-template"]:checked');
  if (!selected) {
    document.getElementById("template-error").innerHTML =
      '<div class="alert alert-danger">Select a template first.</div>';
    return;
  }

  const btn = document.getElementById("apply-template-btn");
  btn.disabled = true;
  btn.textContent = "Applying...";

  try {
    await api("use_demo_template", {
      demo_org_id: selected.value,
      target_org_id: currentOrgId,
      copy_kb: mode === "kb",
      copy_prompt: mode === "prompt",
      copy_widget: true,
      copy_tone: true,
    });

    document.querySelector(".modal-backdrop").remove();
    toast(`Template applied (${mode === "kb" ? "KB documents" : "system prompt"}, widget colors, AI tone)`, "success");

    // Refresh org data and re-render current tab
    const { org, providers, widget, kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs };
    renderTab();
  } catch (e) {
    document.getElementById("template-error").innerHTML =
      `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.textContent = "Apply Template";
  }
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tabs .tab").forEach(t => {
    t.classList.toggle("active", t.getAttribute("onclick").includes(`'${tab}'`));
  });
  renderTab();
}

async function renderTab() {
  const el = document.getElementById("tab-content");
  if (!el) return;
  const { org, providers, widget, kbDocs } = window._orgData;

  try {
    if (currentTab === "overview") renderOverviewTab(el, org, providers, widget);
    else if (currentTab === "email") renderEmailTab(el, org, providers);
    else if (currentTab === "widget") renderWidgetTab(el, widget, org);
    else if (currentTab === "kb") renderKbTab(el, kbDocs, org);
    else if (currentTab === "settings") renderSettingsTab(el, org);
  } catch (e) {
    console.error("renderTab error:", e);
    el.innerHTML = `<div class="alert alert-danger">Error rendering tab: ${e.message}</div>`;
  }
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function renderOverviewTab(el, org, providers, widget) {
  const pct = org.message_limit_per_month > 0
    ? Math.round((org.messages_used_this_month / org.message_limit_per_month) * 100) : 0;
  const fillClass = pct >= 100 ? "danger" : pct >= 80 ? "warning" : "";
  const provider = providers[0];
  const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    .toLocaleDateString("en-US", { month: "long", day: "numeric" });

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Messages Used</div>
        <div class="stat-value">${org.messages_used_this_month.toLocaleString()}</div>
        <div class="stat-sub">of ${org.message_limit_per_month.toLocaleString()} / month</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Resets</div>
        <div class="stat-value stat-value-md">${resetDate}</div>
        <div class="stat-sub">Next billing cycle</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Email</div>
        <div class="stat-value stat-value-sm" style="word-break:break-all;line-height:1.4">${provider ? (() => { const at = provider.provider_account_email.indexOf("@"); return at === -1 ? escHtml(provider.provider_account_email) : `${escHtml(provider.provider_account_email.slice(0, at))}<br><span style="font-size:12px;opacity:0.8">${escHtml(provider.provider_account_email.slice(at))}</span>`; })() : "—"}</div>
        <div class="stat-sub">${provider ? `<span class="badge ${provider.status === "active" ? "badge-green" : "badge-red"}">${provider.status}</span>` : "Not connected"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Widget</div>
        <div class="stat-value stat-value-lg">${widget ? (widget.enabled ? "Enabled" : "Disabled") : "Not set up"}</div>
      </div>
    </div>
    ${isOwner ? `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Activation Controls</div></div>
      <div class="card-body">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Widget Chat</div>
            <div class="toggle-desc">Show chat widget on the business website</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="ov-widget-toggle" ${widget?.enabled ? "checked" : ""}
              onchange="toggleWidget(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Email AI Responses</div>
            <div class="toggle-desc">Process inbound emails with AI (disable to save messages without AI)</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="ov-email-ai-toggle" ${org.ai_responses_enabled ? "checked" : ""}
              onchange="toggleEmailAi(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="toggle-row" style="border-bottom:none">
          <div>
            <div class="toggle-label">Auto-Send</div>
            <div class="toggle-desc">Automatically send high-confidence AI responses</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="ov-autosend-toggle" ${org.auto_send_enabled ? "checked" : ""}
              onchange="toggleAutoSend(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>` : ""}
    <div class="card">
      <div class="card-header"><div class="card-title">Monthly Usage</div></div>
      <div class="card-body">
        ${org.limit_exceeded_at ? `<div class="alert alert-danger">Limit exceeded on ${new Date(org.limit_exceeded_at).toLocaleDateString()}.</div>` : ""}
        <div class="progress-wrap" style="margin-bottom:8px">
          <div class="progress-bar" style="height:12px">
            <div class="progress-fill ${fillClass}" style="width:${Math.min(pct, 100)}%"></div>
          </div>
          <span class="progress-label font-semibold" style="font-size:14px">${pct}%</span>
        </div>
        <div class="text-muted" style="font-size:13px">
          ${org.messages_used_this_month.toLocaleString()} of ${org.message_limit_per_month.toLocaleString()} messages used this month
        </div>
      </div>
    </div>`;
}

// ── Email Tab ─────────────────────────────────────────────────────────────────

function renderEmailTab(el, org, providers) {
  const provider = providers[0];
  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Connected Email Account</div></div>
      <div class="card-body">
        ${provider ? `
          <div class="flex-row" style="gap:16px;margin-bottom:16px">
            <div>${provider.provider === "google" ? ICONS.google : ICONS.microsoft}</div>
            <div>
              <div class="font-semibold">${escHtml(provider.provider_account_email)}</div>
              <div class="text-sm text-muted" style="margin-top:2px">
                ${provider.provider} · <span class="badge ${provider.status === "active" ? "badge-green" : "badge-red"}">${provider.status}</span>
              </div>
            </div>
          </div>
          <div class="text-muted" style="font-size:13px;margin-bottom:16px">
            ${provider.emails_sent_today} / ${provider.daily_send_limit} sent today ·
            Watch expires: ${provider.watch_expiry ? new Date(provider.watch_expiry).toLocaleDateString() : "N/A"}
          </div>` : `
          <div class="alert alert-info" style="margin-bottom:16px">No email account connected yet.</div>`}
        <div class="flex-row" style="gap:12px;flex-wrap:wrap">
          <button class="btn btn-secondary" onclick="connectEmail('google')">
            ${ICONS.google} Connect Google / Gmail
          </button>
          <button class="btn btn-secondary" onclick="connectEmail('microsoft')">
            ${ICONS.microsoft} Connect Microsoft / Outlook
          </button>
        </div>
      </div>
    </div>
    <div class="card" id="auth-link-card" style="display:none">
      <div class="card-header"><div class="card-title">Authorization Link</div></div>
      <div class="card-body">
        <div class="alert alert-info" style="margin-bottom:16px">
          Copy this link and open it in a browser signed into the business's email account.
        </div>
        <div class="code-block" id="auth-link-display" style="white-space:normal;word-break:break-all;font-size:13px"></div>
        <div class="flex-row" style="gap:10px;margin-top:12px">
          <button class="btn btn-primary" onclick="copyAuthLink()">${ICONS.copy} Copy Link</button>
          <button class="btn btn-secondary" onclick="openAuthLink()">${ICONS.external} Open in This Browser</button>
        </div>
      </div>
    </div>
    <div class="card mb-4" style="margin-top:20px">
      <div class="card-header">
        <div class="card-title">Notification Recipients</div>
        <button class="btn btn-primary btn-sm" onclick="showAddRecipientModal()">
          ${ICONS.plus} Add Recipient
        </button>
      </div>
      <div class="card-body card-body-flush">
        <div id="recipients-list">
          <div class="loading-overlay"><div class="spinner"></div></div>
        </div>
      </div>
      <div class="card-body text-sm text-muted" style="padding:10px 16px;border-top:1px solid var(--border)">
        If no recipients are added, escalations and alerts go to the connected inbox.
      </div>
    </div>`;

  // Load recipients
  loadRecipients();
}

async function connectEmail(provider) {
  const btn = event.target.closest("button");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Generating...';
  try {
    const { url } = await api("get_auth_link", { org_id: currentOrgId, provider });
    window._authLink = url;
    document.getElementById("auth-link-display").textContent = url;
    document.getElementById("auth-link-card").style.display = "";
    toast("Authorization link generated", "success");
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = provider === "google"
      ? `${ICONS.google} Connect Google / Gmail`
      : `${ICONS.microsoft} Connect Microsoft / Outlook`;
  }
}

function copyAuthLink() { navigator.clipboard.writeText(window._authLink); toast("Copied", "success"); }
function openAuthLink() { window.open(window._authLink, "_blank"); }

// ── Widget Tab ────────────────────────────────────────────────────────────────

function renderWidgetTab(el, widget, org) {
  if (!widget) {
    el.innerHTML = `<div class="card"><div class="card-body"><div class="alert alert-info">No widget config found.</div></div></div>`;
    return;
  }

  const domains = (widget.allowed_domains || []).join(", ");
  const colors = widget.colors || {};
  const light = colors.light || {};
  const dark = colors.dark || {};

  const colorFields = [
    { key: "headerBg",   label: "Header Background" },
    { key: "headerText", label: "Header Text" },
    { key: "userBubble", label: "User Message Bubble" },
    { key: "userText",   label: "User Message Text" },
    { key: "aiBubble",   label: "AI Message Bubble" },
    { key: "aiText",     label: "AI Message Text" },
    { key: "bg",         label: "Widget Background" },
    { key: "inputBg",    label: "Input Background" },
    { key: "inputText",  label: "Input Text" },
    { key: "sendBtn",    label: "Send Button" },
    { key: "sendBtnText",label: "Send Button Text" },
  ];

  const colorRows = colorFields.map(f => `
    <tr>
      <td style="padding:8px 12px">${f.label}</td>
      <td style="padding:6px 12px">
        <div class="flex-row">
          <input type="color" id="cl-${f.key}" value="${escHtml(light[f.key] || "#ffffff")}" />
          <span class="font-mono text-sm" id="cl-${f.key}-val">${escHtml(light[f.key] || "#ffffff")}</span>
        </div>
      </td>
      <td style="padding:6px 12px">
        <div class="flex-row">
          <input type="color" id="cd-${f.key}" value="${escHtml(dark[f.key] || "#111827")}" />
          <span class="font-mono text-sm" id="cd-${f.key}-val">${escHtml(dark[f.key] || "#111827")}</span>
        </div>
      </td>
    </tr>`).join("");

	window._currentSnippet = `<script>
  	window.horusDesk = {
    	apiKey: '${widget.api_key}'
  	};
	<\/script>
	<script src="horusdesk.com/widget.js" async><\/script>`;

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header">
        <div class="card-title">Widget Status</div>
        <label class="toggle">
          <input type="checkbox" id="widget-enabled-toggle" ${widget.enabled ? "checked" : ""}
            onchange="toggleWidget(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label>API Key</label>
          <div class="flex-row" style="gap:10px">
            <input type="text" value="${escHtml(widget.api_key)}" readonly class="font-mono text-sm" />
            <button class="btn btn-secondary btn-sm"
              onclick="navigator.clipboard.writeText('${widget.api_key}');toast('Copied','success')">
              ${ICONS.copy}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Appearance</div></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label>Header Title</label>
            <input type="text" id="w-header-title" value="${escHtml(widget.header_title || "")}" placeholder="Chat with us" />
          </div>
          <div class="form-group">
            <label>Position</label>
            <select id="w-position">
              <option value="right" ${widget.position === "right" ? "selected" : ""}>Right</option>
              <option value="left" ${widget.position === "left" ? "selected" : ""}>Left</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Welcome Message</label>
          <textarea id="w-welcome" rows="2">${escHtml(widget.welcome_message || "")}</textarea>
        </div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Colors</div></div>
      <div class="card-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Element</th>
                <th>Light Mode</th>
                <th>Dark Mode</th>
              </tr>
            </thead>
            <tbody>${colorRows}</tbody>
          </table>
        </div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig('${widget.id}')">
          Save Widget Settings
        </button>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Domain Whitelist</div></div>
      <div class="card-body">
        <div class="form-group">
          <label>Allowed Domains <span class="hint">(comma-separated, empty = allow all)</span></label>
          <input type="text" id="w-domains" value="${escHtml(domains)}" placeholder="example.com, www.example.com" />
        </div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Pre-Chat Form</div></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label>Form Title</label>
            <input type="text" id="w-form-title" value="${escHtml(widget.form_title || "")}" />
          </div>
          <div class="form-group">
            <label>Form Subtitle</label>
            <input type="text" id="w-form-subtitle" value="${escHtml(widget.form_subtitle || "")}" />
          </div>
        </div>
        <div class="form-group">
          <label>Capture Fields</label>
          <div class="flex-row" style="gap:16px">
            ${["name","email","phone"].map(f => `
              <label style="text-transform:none;letter-spacing:0;font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400">
                <input type="checkbox" id="w-field-${f}" ${(widget.capture_fields||[]).includes(f)?"checked":""}> ${f.charAt(0).toUpperCase()+f.slice(1)}
              </label>`).join("")}
          </div>
        </div>
        <div class="form-group">
          <label>Required Fields</label>
          <div class="flex-row" style="gap:16px">
            ${["name","email","phone"].map(f => `
              <label style="text-transform:none;letter-spacing:0;font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400">
                <input type="checkbox" id="w-req-${f}" ${(widget.required_fields||[]).includes(f)?"checked":""}> ${f.charAt(0).toUpperCase()+f.slice(1)}
              </label>`).join("")}
          </div>
        </div>
      </div>
    </div>

    ${(currentIsDemo && !isOwner) ? "" : `<div class="card">
      <div class="card-header"><div class="card-title">Embed Snippet</div></div>
      <div class="card-body">
        <div class="alert alert-info" style="margin-bottom:16px">
          Give this to the business — paste before &lt;/body&gt;.
        </div>
        <div class="code-block">${escHtml(window._currentSnippet)}</div>
        <button class="btn btn-primary" style="margin-top:12px" onclick="copySnippet()">
          ${ICONS.copy} Copy Snippet
        </button>
      </div>
    </div>`}`;

  // Wire up color input live preview labels
  const colorFieldKeys = colorFields.map(f => f.key);
  colorFieldKeys.forEach(key => {
    ["cl", "cd"].forEach(prefix => {
      const input = document.getElementById(`${prefix}-${key}`);
      const val = document.getElementById(`${prefix}-${key}-val`);
      if (input && val) {
        input.addEventListener("input", () => { val.textContent = input.value; });
      }
    });
  });
}

async function toggleWidget(enabled) {
  try {
    await api("update_widget", {
      org_id: currentOrgId,
      updates: { enabled, disable_reason: enabled ? null : "manual" },
    });
    if (window._orgData?.widget) window._orgData.widget.enabled = enabled;
    toast(`Widget ${enabled ? "enabled" : "disabled"}`, "success");
  } catch (e) { toast(e.message, "error"); }
}

async function toggleEmailAi(enabled) {
  try {
    await api("update_org", {
      org_id: currentOrgId,
      updates: { ai_responses_enabled: enabled },
    });
    if (window._orgData?.org) window._orgData.org.ai_responses_enabled = enabled;
    toast(`Email AI ${enabled ? "enabled" : "disabled"}`, "success");
  } catch (e) { toast(e.message, "error"); }
}

async function toggleAutoSend(enabled) {
  try {
    await api("update_org", {
      org_id: currentOrgId,
      updates: { auto_send_enabled: enabled },
    });
    if (window._orgData?.org) window._orgData.org.auto_send_enabled = enabled;
    toast(`Auto-send ${enabled ? "enabled" : "disabled"}`, "success");
  } catch (e) { toast(e.message, "error"); }
}

async function saveWidgetConfig(widgetId) {
  const colorFields = ["headerBg","headerText","userBubble","userText","aiBubble","aiText","bg","inputBg","inputText","sendBtn","sendBtnText"];

  const light = {}, dark = {};
  colorFields.forEach(key => {
    const lEl = document.getElementById(`cl-${key}`);
    const dEl = document.getElementById(`cd-${key}`);
    if (lEl) light[key] = lEl.value;
    if (dEl) dark[key] = dEl.value;
  });

  const domains = (document.getElementById("w-domains").value || "")
    .split(",").map(d => d.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean);

  const captureFields = ["name","email","phone"].filter(f => document.getElementById(`w-field-${f}`)?.checked);
  const requiredFields = ["name","email","phone"].filter(f => document.getElementById(`w-req-${f}`)?.checked);

  try {
    await api("update_widget", {
      org_id: currentOrgId,
      updates: {
        header_title: document.getElementById("w-header-title").value.trim(),
        welcome_message: document.getElementById("w-welcome").value.trim(),
        position: document.getElementById("w-position").value,
        form_title: document.getElementById("w-form-title")?.value.trim(),
        form_subtitle: document.getElementById("w-form-subtitle")?.value.trim(),
        allowed_domains: domains,
        capture_fields: captureFields,
        required_fields: requiredFields,
        colors: { light, dark },
      },
    });
    toast("Widget settings saved", "success");
  } catch (e) { toast(e.message, "error"); }
}

// ── KB Tab ────────────────────────────────────────────────────────────────────

function renderKbTab(el, kbDocs, org) {
  const rows = kbDocs.length === 0
    ? `<tr><td colspan="4"><div class="empty-state" style="padding:24px"><p>No documents yet.</p></div></td></tr>`
    : kbDocs.map(doc => `
        <tr>
          <td><div class="font-semibold">${escHtml(doc.title)}</div></td>
          <td><span class="badge badge-blue">${doc.file_type}</span></td>
          <td><span class="badge ${doc.status==="ready"?"badge-green":doc.status==="error"?"badge-red":"badge-yellow"}">${doc.status}</span></td>
          <td>${new Date(doc.created_at).toLocaleDateString()}</td>
          <td class="table-actions">
            <button class="btn btn-ghost btn-sm" onclick="showEditKbModal('${doc.id}','${escHtml(doc.title)}','${doc.file_type}')">Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteKbDoc('${doc.id}','${escHtml(doc.title)}')">Delete</button>
          </td>
        </tr>`).join("");

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Documents (${kbDocs.length})</div>
        <div class="flex-row">
          ${!currentIsDemo ? `<button class="btn btn-secondary btn-sm" onclick="showUseTemplateModal('kb')">Use Template</button>` : ""}
          <button class="btn btn-primary btn-sm" onclick="showAddKbModal()">${ICONS.plus} Add Document</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Title</th><th>Format</th><th>Status</th><th>Added</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function showAddKbModal(existingId = null, existingTitle = "", existingFormat = "markdown") {
  const isEdit = !!existingId;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${isEdit ? "Update Document" : "Add Document"}</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Title</label>
            <input type="text" id="kb-title" value="${escHtml(existingTitle)}" placeholder="Pricing FAQ" />
          </div>
          <div class="form-group">
            <label>Format</label>
            <select id="kb-format" onchange="toggleKbFormat(this.value)">
              <option value="markdown" ${existingFormat==="markdown"?"selected":""}>Markdown / Plain Text</option>
              <option value="faq" ${existingFormat==="json"?"selected":""}>FAQ (Q&A pairs)</option>
            </select>
          </div>
        </div>
        <div id="kb-markdown-section">
          <div class="form-group">
            <label>Content <span class="hint">(## headings create separate chunks)</span></label>
            <textarea id="kb-content" rows="14" placeholder="## Section Title&#10;&#10;Content here..."></textarea>
          </div>
        </div>
        <div id="kb-faq-section" style="display:none">
          <div class="form-group">
            <label>FAQ Pairs <span class="hint">(JSON array)</span></label>
            <textarea id="kb-faq-content" rows="14" placeholder='[&#10;  { "question": "...", "answer": "..." }&#10;]'></textarea>
          </div>
        </div>
        <div id="kb-modal-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="kb-submit-btn" onclick="submitKbDoc(${isEdit ? `'${existingId}'` : "null"})">
          ${isEdit ? "Update" : "Add Document"}
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function showEditKbModal(id, title, format) {
  showAddKbModal(id, title, format);
  try {
    const { chunks } = await api("get_kb_chunks", { org_id: currentOrgId, doc_id: id });
    if (format === "json") {
      const pairs = chunks.map(c => {
        const lines = c.content.split("\n");
        const q = lines.find(l => l.startsWith("Q: "))?.slice(3) ?? "";
        const a = lines.find(l => l.startsWith("A: "))?.slice(3) ?? "";
        return { question: q, answer: a };
      });
      const ta = document.getElementById("kb-faq-content");
      if (ta) ta.value = JSON.stringify(pairs, null, 2);
      toggleKbFormat("faq");
      document.getElementById("kb-format").value = "faq";
    } else {
      const content = chunks.map(c => c.content).join("\n\n");
      const ta = document.getElementById("kb-content");
      if (ta) ta.value = content;
    }
  } catch (e) { toast(`Failed to load content: ${e.message}`, "error"); }
}

function toggleKbFormat(format) {
  document.getElementById("kb-markdown-section").style.display = format === "markdown" ? "" : "none";
  document.getElementById("kb-faq-section").style.display = format === "faq" ? "" : "none";
}

async function submitKbDoc(existingId) {
  const title = document.getElementById("kb-title").value.trim();
  const format = document.getElementById("kb-format").value;
  const errEl = document.getElementById("kb-modal-error");

  if (!title) { errEl.innerHTML = '<div class="alert alert-danger">Title is required.</div>'; return; }

  let content;
  if (format === "markdown") {
    content = document.getElementById("kb-content").value.trim();
    if (!content) { errEl.innerHTML = '<div class="alert alert-danger">Content is required.</div>'; return; }
  } else {
    try {
      content = JSON.parse(document.getElementById("kb-faq-content").value.trim());
      if (!Array.isArray(content)) throw new Error("Must be an array");
    } catch (e) {
      errEl.innerHTML = `<div class="alert alert-danger">Invalid JSON: ${e.message}</div>`;
      return;
    }
  }

  const btn = document.getElementById("kb-submit-btn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Saving...';

  try {
    const payload = { org_id: currentOrgId, title, format, content };
    if (existingId) payload.id = existingId;

    const result = await api("kb_ingest", payload);
    document.querySelector(".modal-backdrop").remove();
    toast(`${result.chunks_created} chunks ${existingId ? "updated" : "added"}`, "success");

    const { org, providers, widget, kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs };
    renderKbTab(document.getElementById("tab-content"), kbDocs, org);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = existingId ? "Update" : "Add Document";
  }
}

async function deleteKbDoc(docId, title) {
  if (!confirm(`Delete "${title}"? This removes all chunks and cannot be undone.`)) return;
  try {
    await api("delete_kb_doc", { org_id: currentOrgId, doc_id: docId });
    toast("Document deleted", "success");
    const { kbDocs } = await api("get_org", { org_id: currentOrgId });
    window._orgData.kbDocs = kbDocs;
    renderKbTab(document.getElementById("tab-content"), kbDocs, window._orgData.org);
  } catch (e) { toast(e.message, "error"); }
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

function renderSettingsTab(el, org) {
  // Demo orgs: salespeople can only edit AI Tone
  if (currentIsDemo && !isOwner) {
    el.innerHTML = `
      <div class="card mb-4">
        <div class="card-header"><div class="card-title">Demo Settings</div></div>
        <div class="card-body">
          <div class="form-group">
            <label>AI Tone</label>
            <select id="s-tone">
              ${["professional","friendly","formal","casual"].map(t =>
                `<option value="${t}" ${org.ai_tone===t?"selected":""}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join("")}
            </select>
          </div>
          <div style="margin-top:16px">
            <button class="btn btn-primary" onclick="saveDemoTone()">Save Tone</button>
          </div>
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-header"><div class="card-title">System Prompt</div></div>
        <div class="card-body">
          <div class="form-group">
            <label>Custom AI System Prompt <span class="hint">(leave empty to use default template)</span></label>
            <textarea id="s-prompt" rows="16">${escHtml(org.ai_system_prompt || "")}</textarea>
            <div class="form-hint">Version: ${org.ai_system_prompt_version || 1}</div>
          </div>
          <button class="btn btn-primary" onclick="saveSystemPrompt()">Save Prompt</button>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Organization Settings</div></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label>Business Name</label>
            <input type="text" id="s-name" value="${escHtml(org.name)}" />
          </div>
          <div class="form-group">
            <label>Slug</label>
            <input type="text" id="s-slug" value="${escHtml(org.slug)}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>AI Tone</label>
            <select id="s-tone">
              ${["professional","friendly","formal","casual"].map(t =>
                `<option value="${t}" ${org.ai_tone===t?"selected":""}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>Subscription Tier</label>
            <select id="s-tier">
              ${["basic","pro","enterprise"].map(t =>
                `<option value="${t}" ${org.subscription_tier===t?"selected":""}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join("")}
            </select>
          </div>
        </div>
        <div class="form-row">
          ${isOwner ? `
          <div class="form-group">
            <label>Monthly Message Limit</label>
            <input type="number" id="s-limit" value="${org.message_limit_per_month}" min="100" />
          </div>` : ""}
          <div class="form-group">
            <label>Auto-Send Min Confidence</label>
            <input type="number" id="s-confidence" value="${org.auto_send_min_confidence}" min="0" max="1" step="0.05" />
          </div>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Auto-Send Enabled</div>
            <div class="toggle-desc">Automatically send AI responses above the confidence threshold</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="s-autosend" ${org.auto_send_enabled?"checked":""}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-primary" onclick="saveOrgSettings()">Save Settings</button>
        </div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">System Prompt</div></div>
      <div class="card-body">
        <div class="form-group">
          <label>Custom AI System Prompt <span class="hint">(leave empty to use default template)</span></label>
          <textarea id="s-prompt" rows="16">${escHtml(org.ai_system_prompt || "")}</textarea>
          <div class="form-hint">Version: ${org.ai_system_prompt_version || 1}</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-primary" onclick="saveSystemPrompt()">Save Prompt</button>
          ${!currentIsDemo ? `<button class="btn btn-secondary" onclick="showUseTemplateModal('prompt')">Use Template</button>` : ""}
        </div>
      </div>
    </div>

    ${isOwner ? `
    <div class="card" style="border-color:rgba(239,68,68,0.3)">
      <div class="card-header" style="border-color:rgba(239,68,68,0.3)">
        <div class="card-title" style="color:var(--danger)">Reset Usage</div>
      </div>
      <div class="card-body">
        <p class="text-muted" style="font-size:13px;margin-bottom:12px">
          Manually reset this month's message counter. Use if you've upgraded a plan mid-month.
        </p>
        <button class="btn btn-danger" onclick="resetUsage()">Reset Monthly Usage Counter</button>
      </div>
    </div>` : ""}`;
}

async function saveDemoTone() {
  try {
    await api("update_org", {
      org_id: currentOrgId,
      updates: { ai_tone: document.getElementById("s-tone").value },
    });
    toast("AI tone updated", "success");
    const { org } = await api("get_org", { org_id: currentOrgId });
    window._orgData.org = org;
  } catch (e) { toast(e.message, "error"); }
}

async function saveOrgSettings() {
  const updates = {
    name: document.getElementById("s-name").value.trim(),
    slug: document.getElementById("s-slug").value.trim(),
    ai_tone: document.getElementById("s-tone").value,
    subscription_tier: document.getElementById("s-tier").value,
    auto_send_min_confidence: parseFloat(document.getElementById("s-confidence").value),
    auto_send_enabled: document.getElementById("s-autosend").checked,
  };
  if (isOwner) {
    updates.message_limit_per_month = parseInt(document.getElementById("s-limit").value);
  }
  try {
    await api("update_org", { org_id: currentOrgId, updates });
    toast("Settings saved", "success");
    const { org } = await api("get_org", { org_id: currentOrgId });
    window._orgData.org = org;
    currentOrgName = org.name;
  } catch (e) { toast(e.message, "error"); }
}

async function saveSystemPrompt() {
  const prompt = document.getElementById("s-prompt").value.trim();
  const currentVersion = window._orgData.org.ai_system_prompt_version || 1;
  try {
    await api("update_org", {
      org_id: currentOrgId,
      updates: {
        ai_system_prompt: prompt || null,
        ai_system_prompt_version: currentVersion + 1,
      },
    });
    toast("System prompt saved", "success");
    window._orgData.org.ai_system_prompt_version = currentVersion + 1;
    document.querySelector(".form-hint") && (document.querySelector(".form-hint").textContent = `Version: ${currentVersion + 1}`);
  } catch (e) { toast(e.message, "error"); }
}

async function resetUsage() {
  if (!confirm("Reset the monthly message counter to 0?")) return;
  try {
    await api("reset_usage", { org_id: currentOrgId });
    toast("Usage counter reset", "success");
    const { org } = await api("get_org", { org_id: currentOrgId });
    window._orgData.org = org;
  } catch (e) { toast(e.message, "error"); }
}

// ── Emergency Kill Switch ─────────────────────────────────────────────────────

function showEmergencyModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header" style="border-color:rgba(239,68,68,0.3)">
        <div class="modal-title" style="color:var(--danger)">Emergency Kill Switch</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">&#10005;</button>
      </div>
      <div class="modal-body">
        <div class="alert alert-danger" style="margin-bottom:16px">
          <strong>This will immediately:</strong>
          <ul style="margin:8px 0 0 16px;font-size:13px">
            <li>Hide the chat widget on ALL client websites</li>
            <li>Stop AI from processing ANY inbound emails</li>
            <li>Disable auto-send on ALL organizations</li>
          </ul>
        </div>
        <p class="text-muted" style="font-size:13px">
          You can restore service afterwards with the Restore All button.
        </p>
        <div class="form-group" style="margin-top:16px">
          <label>Type DISABLE to confirm</label>
          <input type="text" id="emergency-confirm" placeholder="DISABLE" />
        </div>
        <div id="emergency-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-danger" id="emergency-btn" onclick="executeEmergencyDisable()">
          Disable Everything
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function executeEmergencyDisable() {
  const confirmVal = document.getElementById("emergency-confirm").value.trim();
  const errEl = document.getElementById("emergency-error");
  if (confirmVal !== "DISABLE") {
    errEl.innerHTML = '<div class="alert alert-danger">Type DISABLE to confirm.</div>';
    return;
  }
  const btn = document.getElementById("emergency-btn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Disabling...';
  try {
    await api("emergency_disable_all");
    document.querySelector(".modal-backdrop")?.remove();
    toast("All services disabled", "error");
    navigate("orgs");
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = "Disable Everything";
  }
}

async function executeEmergencyRestore() {
  if (!confirm("Restore all services that were disabled by the emergency kill switch?")) return;
  try {
    await api("emergency_restore");
    toast("Services restored", "success");
    navigate("orgs");
  } catch (e) { toast(e.message, "error"); }
}

// ── Sales Report (owners only) ────────────────────────────────────────────────

async function renderSalesReport(main) {
  main.innerHTML = `
    <div class="page-header">
      <div class="page-title">Sales Report</div>
    </div>
    <div class="card">
      <div class="loading-overlay"><div class="spinner"></div> Loading...</div>
    </div>`;

  try {
    const { orgs } = await api("sales_report");

    // Group by salesperson
    const byRep = {};
    orgs.forEach(org => {
      const rep = org.created_by_name || "Unknown";
      if (!byRep[rep]) byRep[rep] = [];
      byRep[rep].push(org);
    });

    const sections = Object.entries(byRep).map(([rep, repOrgs]) => `
      <div style="margin-bottom:24px">
        <div class="font-semibold" style="font-size:14px;margin-bottom:8px">
          ${escHtml(rep)} <span class="badge badge-blue">${repOrgs.length} org${repOrgs.length!==1?"s":""}</span>
        </div>
        <table>
          <thead><tr><th>Organization</th><th>Tier</th><th>Created</th><th>Messages Used</th></tr></thead>
          <tbody>
            ${repOrgs.map(org => `
              <tr>
                <td>
                  <a onclick="navigate('org-detail','${org.id}','${escHtml(org.name)}')"
                    class="org-link">${escHtml(org.name)}</a>
                </td>
                <td><span class="badge badge-gray">${org.subscription_tier}</span></td>
                <td>${new Date(org.created_at).toLocaleDateString()}</td>
                <td>${org.messages_used_this_month.toLocaleString()}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`).join("");

    main.querySelector(".card").innerHTML = sections.length
      ? `<div class="card-body">${sections}</div>`
      : `<div class="empty-state"><p>No organizations with sales attribution yet.</p></div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

// ── Helper, copy snippet button ─────────────────────────────────────────────────────────────────

function copySnippet() {
  navigator.clipboard.writeText(window._currentSnippet);
  toast('Copied', 'success');
}

// ── Notification Recipients ───────────────────────────────────────────────────

const EVENT_TYPE_LABELS = {
  escalation: "Escalations",
  usage_limit: "Usage Limit Alerts",
  system: "System Alerts",
};

async function loadRecipients() {
  const el = document.getElementById("recipients-list");
  if (!el) return;

  try {
    const { recipients } = await api("list_recipients", { org_id: currentOrgId });

    if (recipients.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:24px"><p>No recipients added. Notifications go to the connected inbox.</p></div>`;
      return;
    }

    const rows = recipients.map(r => {
      const tags = (r.notify_on || []).map(t =>
        `<span class="badge badge-blue" style="margin-right:4px">${EVENT_TYPE_LABELS[t] || t}</span>`
      ).join("");

      return `
        <div class="flex-row-spread" style="padding:12px 16px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:500;font-size:13px">${escHtml(r.name || r.email)}</div>
            ${r.name ? `<div class="text-sm text-muted">${escHtml(r.email)}</div>` : ""}
            <div style="margin-top:6px">${tags || '<span class="text-sm text-muted">No notifications</span>'}</div>
          </div>
          <div class="flex-row">
            <label class="toggle" title="${r.is_active ? "Active" : "Disabled"}">
              <input type="checkbox" ${r.is_active ? "checked" : ""}
                onchange="toggleRecipient('${r.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn btn-ghost btn-sm" onclick="showEditRecipientModal('${r.id}','${escHtml(r.email)}','${escHtml(r.name || "")}',${JSON.stringify(r.notify_on)})">Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteRecipient('${r.id}')">Remove</button>
          </div>
        </div>`;
    }).join("");

    el.innerHTML = rows;
  } catch (e) {
    el.innerHTML = `<div class="card-body"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

function recipientModalHtml(title, id, email, name, notifyOn) {
  const allTypes = ["escalation", "usage_limit", "system"];
  const checkboxes = allTypes.map(t => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;margin-bottom:8px;color:var(--text)">
      <input type="checkbox" id="rn-${t}" ${(notifyOn || allTypes).includes(t) ? "checked" : ""}>
      ${EVENT_TYPE_LABELS[t]}
    </label>`).join("");

  return `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" id="r-email" value="${escHtml(email)}" placeholder="manager@example.com" />
        </div>
        <div class="form-group">
          <label>Name <span class="hint">(optional label)</span></label>
          <input type="text" id="r-name" value="${escHtml(name)}" placeholder="Sarah (Manager)" />
        </div>
        <div class="form-group">
          <label>Notify On</label>
          ${checkboxes}
        </div>
        <div id="recipient-modal-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="recipient-submit-btn"
          onclick="${id ? `saveRecipient('${id}')` : "addRecipient()"}">
          ${id ? "Save Changes" : "Add Recipient"}
        </button>
      </div>
    </div>`;
}

function showAddRecipientModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = recipientModalHtml("Add Notification Recipient", null, "", "", null);
  document.body.appendChild(modal);
}

function showEditRecipientModal(id, email, name, notifyOn) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = recipientModalHtml("Edit Recipient", id, email, name, notifyOn);
  document.body.appendChild(modal);
}

function getRecipientFormValues() {
  const email = document.getElementById("r-email").value.trim();
  const name = document.getElementById("r-name").value.trim();
  const notifyOn = ["escalation", "usage_limit", "system"]
    .filter(t => document.getElementById(`rn-${t}`)?.checked);
  return { email, name, notifyOn };
}

async function addRecipient() {
  const { email, name, notifyOn } = getRecipientFormValues();
  const errEl = document.getElementById("recipient-modal-error");
  if (!email) { errEl.innerHTML = '<div class="alert alert-danger">Email is required.</div>'; return; }

  const btn = document.getElementById("recipient-submit-btn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Adding...';

  try {
    await api("add_recipient", { org_id: currentOrgId, email, name, notify_on: notifyOn });
    document.querySelector(".modal-backdrop").remove();
    toast("Recipient added", "success");
    loadRecipients();
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = "Add Recipient";
  }
}

async function saveRecipient(id) {
  const { email, name, notifyOn } = getRecipientFormValues();
  const errEl = document.getElementById("recipient-modal-error");
  if (!email) { errEl.innerHTML = '<div class="alert alert-danger">Email is required.</div>'; return; }

  const btn = document.getElementById("recipient-submit-btn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Saving...';

  try {
    await api("update_recipient", {
      org_id: currentOrgId,
      recipient_id: id,
      updates: { email, name: name || null, notify_on: notifyOn },
    });
    document.querySelector(".modal-backdrop").remove();
    toast("Recipient updated", "success");
    loadRecipients();
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    btn.disabled = false;
    btn.innerHTML = "Save Changes";
  }
}

async function toggleRecipient(id, isActive) {
  try {
    await api("update_recipient", {
      org_id: currentOrgId,
      recipient_id: id,
      updates: { is_active: isActive },
    });
    toast(isActive ? "Recipient enabled" : "Recipient disabled", "success");
  } catch (e) {
    toast(e.message, "error");
    loadRecipients(); // Reset toggle state on error
  }
}

async function deleteRecipient(id) {
  if (!confirm("Remove this recipient?")) return;
  try {
    await api("delete_recipient", { org_id: currentOrgId, recipient_id: id });
    toast("Recipient removed", "success");
    loadRecipients();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  _supabase = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.anonKey);

  _supabase.auth.onAuthStateChange((event, session) => {
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && !currentUser) {
      onLogin(session.user);
    } else if (event === "SIGNED_OUT" || (event === "INITIAL_SESSION" && !session)) {
      onLogout();
      document.getElementById("login-screen").style.display = "";
    }
  });
});
