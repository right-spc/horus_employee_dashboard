// ============================================
// HORUS DESK DASHBOARD — LOGIC v2
// Auth via Supabase, all DB ops via dashboard-api
// ============================================

// ── Supabase client (anon key only) ──────────────────────────────────────────
let _supabase;
let currentUser = null;   // Supabase Auth user
let dashUser = null;      // Dashboard user record (includes role)
let isOwner = false;

const DEFAULT_ROUTING_RULES_TEXT = `Classify every response using the submit_response tool:
- DRAFT — Normal inquiry you can answer. Set confidence 0.00–1.00 based on how sure you are.
- IGNORE — Spam, test messages, gibberish, not a real inquiry.
- ESCALATE_FRUSTRATED — Customer is upset, angry, or making threats.
- ESCALATE_KB_GAP — Question is outside your knowledge base.
- ESCALATE_LEAD_HIGH — Customer is ready to buy or book.
- ESCALATE_LEAD_MID — Customer is actively interested.
- ESCALATE_LEAD_LOW — Customer is just browsing.

Always use the submit_response tool to deliver your response — never output raw text without calling it.`;

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

async function doGoogleLogin() {
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");

  btn.disabled = true;
  errEl.innerHTML = "";

  const { error } = await _supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });

  if (error) {
    errEl.innerHTML = `<div class="alert alert-danger">${error.message}</div>`;
    btn.disabled = false;
  }
  // On success, browser redirects to Google, then back here.
  // onAuthStateChange picks up the session from the URL fragment.
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
    updateSidebarUser(du.display_name, du.role);

    document.getElementById("sales-nav-item").style.display = "";
    if (isOwner) {
      document.getElementById("team-nav-item").style.display = "";
      document.getElementById("clients-nav-item").style.display = "";
    }
    document.getElementById("section-manage").style.display = "";

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
  document.getElementById("sales-nav-item").style.display = "none";
  document.getElementById("team-nav-item").style.display = "none";
  document.getElementById("section-manage").style.display = "none";
}

function formatRole(role) {
  return role === "owner" ? "Admin" : role === "teamleader" ? "Team Leader" : "Salesperson";
}

function updateSidebarUser(name, role) {
  document.getElementById("user-name").textContent = name;
  document.getElementById("user-role").textContent = formatRole(role);
  document.getElementById("user-initial").textContent = (name || "?").trim().charAt(0).toUpperCase();
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
const _nameCache = {}; // org/demo id → display name (avoids embedding names in inline handlers)
let currentTab = "overview";
let currentIsDemo = false;

function navigate(view, orgId = null, orgName = "", isDemo = false) {
  document.getElementById("tchat-root")?.remove();
  currentView = view;
  currentOrgId = orgId;
  currentOrgName = orgName || (orgId ? _nameCache[orgId] || "" : "");
  currentIsDemo = isDemo;
  currentTab = "overview";
  document.querySelectorAll(".nav-item[data-view]").forEach(el => {
    el.classList.toggle("active", el.dataset.view === view && !orgId);
  });
  closeMobileSidebar();
  render();
}

async function render() {
  const main = document.getElementById("main");
  if (currentView === "orgs") await renderOrgList(main);
  else if (currentView === "org-detail") await renderOrgDetail(main);
  else if (currentView === "demos") await renderDemoList(main);
  else if (currentView === "demo-detail") await renderDemoDetail(main);
  else if (currentView === "sales") await renderSalesReport(main);
  else if (currentView === "team") await renderTeamPage(main);
  else if (currentView === "clients") await renderClientList(main);
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

      const expiryBadge = org.subscription_end_date
        ? (() => {
            const endDate = new Date(org.subscription_end_date);
            const daysLeft = Math.ceil((endDate - new Date()) / (1000*60*60*24));
            const dateLabel = endDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            if (daysLeft < 0) return `<span class="badge badge-red">Expired ${dateLabel}</span>`;
            if (daysLeft <= 7) return `<span class="badge badge-yellow">${daysLeft}d left · ${dateLabel}</span>`;
            return `<span class="badge badge-green">${dateLabel}</span>`;
          })()
        : `<span class="badge badge-gray">No expiry</span>`;

      const createdBy = org.created_by_name
        ? `<div class="text-xs text-subtle">${escHtml(org.created_by_name)}</div>` : "";

      const searchKey = `${org.name} ${org.slug}`.toLowerCase();
      _nameCache[org.id] = org.name;
      return `
        <tr data-search="${escHtml(searchKey)}">
          <td>
            <a onclick="navigate('org-detail','${org.id}')"
               class="org-link">
              ${escHtml(org.name)}
            </a>
            <div class="text-sm text-muted">${escHtml(org.slug)}</div>
            ${createdBy}
          </td>
          <td>${providerBadge}</td>
          <td>${emailAiBadge}</td>
          <td>${widgetBadge}</td>
          <td>${expiryBadge}</td>
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
      <div class="card-body" style="padding-bottom:0;">
        <input type="text" id="org-search" placeholder="Search by name or slug..."
               oninput="filterTableRows('org-search','org-list-body','org-empty-msg')"
               style="width:100%;max-width:400px;" />
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Organization</th><th>Email</th><th>Email AI</th><th>Widget</th><th>Subscription</th><th>Usage this month</th></tr></thead>
          <tbody id="org-list-body">${rows}</tbody>
        </table>
        <div id="org-empty-msg" class="empty-state" style="display:none;"><p>No organizations match your search.</p></div>
      </div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${escHtml(e.message)}</div></div>`;
  }
}

// ── Client List (owner only) ──────────────────────────────────────────────────

async function renderClientList(main) {
  main.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Clients</div>
        <div class="page-subtitle">All client accounts</div>
      </div>
    </div>
    <div class="card">
      <div class="loading-overlay"><div class="spinner"></div> Loading...</div>
    </div>`;

  try {
    const { clients, members, orgs, owners } = await api("list_clients");

    const ownerMap = {};
    (owners || []).forEach(o => { ownerMap[o.id] = o.email; });
    const memberCount = {};
    (members || []).forEach(m => { memberCount[m.client_id] = (memberCount[m.client_id] || 0) + 1; });
    const orgCount = {};
    (orgs || []).forEach(o => {
      _nameCache[o.id] = o.name;
      if (o.client_id) orgCount[o.client_id] = (orgCount[o.client_id] || 0) + 1;
    });

    if ((clients || []).length === 0) {
      main.querySelector(".card").innerHTML =
        `<div class="empty-state"><p>No clients yet.</p></div>`;
      return;
    }

    const rows = clients.map(client => {
      const ownerEmail = client.owner_id ? ownerMap[client.owner_id] : null;
      const created = new Date(client.created_at)
        .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      const searchKey = `${client.name} ${client.notes || ""} ${ownerEmail || ""}`.toLowerCase();
      return `
        <tr data-search="${escHtml(searchKey)}">
          <td>
            <span style="font-weight:600;">${escHtml(client.name)}</span>
            ${client.notes ? `<div class="text-sm text-muted">${escHtml(client.notes)}</div>` : ""}
          </td>
          <td>${ownerEmail ? escHtml(ownerEmail) : `<span class="text-muted">—</span>`}</td>
          <td>${memberCount[client.id] || 0}</td>
          <td>${orgCount[client.id] || 0}</td>
          <td class="text-sm text-muted">${created}</td>
        </tr>`;
    }).join("");

    main.querySelector(".card").innerHTML = `
      <div class="card-body" style="padding-bottom:0;">
        <input type="text" id="client-search" placeholder="Search by name, notes, or owner..."
               oninput="filterTableRows('client-search','client-list-body','client-empty-msg')"
               style="width:100%;max-width:400px;" />
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Client</th><th>Owner</th><th>Members</th><th>Organizations</th><th>Created</th></tr></thead>
          <tbody id="client-list-body">${rows}</tbody>
        </table>
        <div id="client-empty-msg" class="empty-state" style="display:none;"><p>No clients match your search.</p></div>
      </div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${escHtml(e.message)}</div></div>`;
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
        <div class="form-row">
          <div class="form-group">
            <label>Subscription Plan</label>
            <select id="new-org-plan">
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
        </div>
        ${isOwner ? `
        <div class="form-row">
          <div class="form-group">
            <label>Monthly Message Limit</label>
            <input type="number" id="new-org-limit" value="7500" min="100" />
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
      subscription_plan: document.getElementById("new-org-plan").value,
    };

    if (isOwner) {
      params.message_limit_per_month = parseInt(document.getElementById("new-org-limit").value);
      params.auto_send_min_confidence = parseFloat(document.getElementById("new-org-confidence").value);
    }

    const { org } = await api("create_org", params);
    document.querySelector(".modal-backdrop")?.remove();
    toast(`Organization "${name}" created`, "success");
    navigate("org-detail", org.id, org.name);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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
            <input type="number" id="demo-limit" value="7500" min="100" />
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
    document.querySelector(".modal-backdrop")?.remove();
    navigate("demo-detail", org.id, org.name, true);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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
    const { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes };

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
        ${isOwner ? `<div class="flex-row">
          <button class="btn btn-danger" onclick="deleteOrg()">Delete Organization</button>
        </div>` : ""}
      </div>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('overview')">Overview</button>
        <button class="tab" onclick="switchTab('channels')">Channels</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('integrations')">Integrations</button>
        <button class="tab" onclick="switchTab('payments')">Payments</button>
        <button class="tab" onclick="switchTab('reports')">Reports</button>
        <button class="tab" onclick="switchTab('settings')">Settings</button>
      </div>
      <div id="tab-content"></div>`;

    renderTab();
    maybeMountTestChat(widget, kbDocs);
  } catch (e) {
    main.innerHTML += `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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
      const searchKey = `${demo.name} ${demo.slug}`.toLowerCase();
      _nameCache[demo.id] = demo.name;
      return `
        <tr data-search="${escHtml(searchKey)}">
          <td>
            <a onclick="navigate('demo-detail','${demo.id}','',true)"
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
      <div class="card-body" style="padding-bottom:0;">
        <input type="text" id="demo-search" placeholder="Search by name or slug..."
               oninput="filterTableRows('demo-search','demo-list-body','demo-empty-msg')"
               style="width:100%;max-width:400px;" />
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Demo</th><th>AI Tone</th><th>Widget</th></tr></thead>
          <tbody id="demo-list-body">${rows}</tbody>
        </table>
        <div id="demo-empty-msg" class="empty-state" style="display:none;"><p>No demos match your search.</p></div>
      </div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${escHtml(e.message)}</div></div>`;
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
    const { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes };

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
          ${isOwner ? `<button class="btn btn-danger" onclick="deleteDemo()">Delete Demo</button>` : ""}
        </div>
      </div>
      <div class="tabs">
        <button class="tab active" onclick="switchTab('overview')">Overview</button>
        <button class="tab" onclick="switchTab('channels')">Channels</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('reports')">Reports</button>
        <button class="tab" onclick="switchTab('settings')">Settings</button>
      </div>
      <div id="tab-content"></div>`;

    renderTab();
    maybeMountTestChat(widget, kbDocs);
  } catch (e) {
    main.innerHTML += `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
  }
}

async function resetDemo() {
  if (!confirm("Reset this demo to its default state? All current changes will be lost.")) return;
  try {
    await api("reset_demo", { org_id: currentOrgId });
    toast("Demo reset to defaults", "success");
    const { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes };
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

async function deleteDemo() {
  if (!confirm(`Permanently delete demo "${currentOrgName}"? This cannot be undone.`)) return;
  if (!confirm("Are you sure? All conversations, KB documents, and widget config for this demo will be removed.")) return;
  try {
    await api("delete_demo", { org_id: currentOrgId });
    toast("Demo deleted", "success");
    navigate("demos");
  } catch (e) { toast(e.message, "error"); }
}

async function deleteOrg() {
  const org = window._orgData?.org;
  if (!org) return;
  if (org.is_demo) {
    toast("Use the Delete Demo button for demo organizations", "error");
    return;
  }
  const warning = `Permanently delete organization "${org.name}"?\n\n` +
    `This will remove ALL of the following for this organization:\n` +
    `  • All conversations and messages\n` +
    `  • All contacts\n` +
    `  • All KB documents\n` +
    `  • Connected email provider and tokens\n` +
    `  • Widget config\n` +
    `  • Payment history and analytics\n\n` +
    `This cannot be undone.`;
  if (!confirm(warning)) return;
  const typed = prompt(`To confirm, type the organization slug exactly:\n\n${org.slug}`);
  if (typed === null) return;
  if (typed.trim() !== org.slug) {
    toast("Slug did not match — deletion cancelled", "error");
    return;
  }
  try {
    await api("delete_org", { org_id: currentOrgId, confirm_slug: org.slug });
    toast("Organization deleted", "success");
    navigate("orgs");
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
      `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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

    document.querySelector(".modal-backdrop")?.remove();
    toast(`Template applied (${mode === "kb" ? "KB documents" : "system prompt"}, widget colors, AI tone)`, "success");

    // Refresh org data and re-render current tab
    const { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes };
    renderTab();
  } catch (e) {
    document.getElementById("template-error").innerHTML =
      `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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
  const { org, providers, widget, kbDocs, lastPayment, integrations, conversationStats, client, notes } = window._orgData;

  try {
    if (currentTab === "overview") renderOverviewTab(el, org, providers, widget, lastPayment, conversationStats, client, kbDocs, notes);
    else if (currentTab === "channels") renderChannelsTab(el, org, providers, widget);
    else if (currentTab === "kb") renderKbTab(el, kbDocs, org);
    else if (currentTab === "integrations") renderIntegrationsTab(el, org, integrations, providers);
    else if (currentTab === "payments") renderPaymentsTab(el, org);
    else if (currentTab === "reports") renderReportsTab(el, org);
    else if (currentTab === "settings") renderSettingsTab(el, org);
  } catch (e) {
    console.error("renderTab error:", e);
    el.innerHTML = `<div class="alert alert-danger">Error rendering tab: ${escHtml(e.message)}</div>`;
  }
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function renderOverviewTab(el, org, providers, widget, lastPayment, conversationStats, client, kbDocs, notes) {
  const limit = org.message_limit_per_month || 0;
  const used = org.messages_used_this_month || 0;
  const remaining = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const fillClass = pct >= 100 ? "danger" : pct >= 80 ? "warning" : "";
  const provider = providers[0];
  const resetDay = conversationStats?.reset_day || org.cycle_anchor_day || org.billing_day_of_month || 1;
  const now = new Date();
  const resetDateObj = now.getDate() < resetDay
    ? new Date(now.getFullYear(), now.getMonth(), resetDay)
    : new Date(now.getFullYear(), now.getMonth() + 1, resetDay);
  const resetDate = resetDateObj.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  const reasonLabels = {
    pending_activation: "Pending activation",
    usage_limit: "Paused — credit limit reached",
    manual: "Manually disabled",
    subscription_expired: "Subscription expired",
    emergency: "Suspended by support",
  };
  const widgetStatus = !widget
    ? { text: "Not set up", cls: "badge-yellow" }
    : widget.enabled
      ? { text: "Enabled", cls: "badge-green" }
      : { text: reasonLabels[widget.disable_reason] || "Disabled", cls: "badge-red" };

  const conv = conversationStats || { webchat: 0, email: 0 };
  const convTotal = (conv.webchat || 0) + (conv.email || 0);

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Services</div></div>
      <div class="card-body">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Website Chat</div>
            <div class="toggle-desc"><span class="badge ${widgetStatus.cls}">${widgetStatus.text}</span> · ${conv.webchat.toLocaleString()} conversations this cycle</div>
          </div>
        </div>
        ${!currentIsDemo ? `<div class="toggle-row">
          <div>
            <div class="toggle-label">Email</div>
            <div class="toggle-desc">${provider
              ? `${escHtml(provider.provider_account_email)} · <span class="badge ${provider.status === "active" ? "badge-green" : "badge-red"}">${escHtml(provider.status)}</span>${org.ai_responses_enabled ? "" : " · AI responses off"} · ${conv.email.toLocaleString()} conversations this cycle`
              : "Not connected — set up in the Email tab"}</div>
          </div>
        </div>` : ""}
        <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:2px">
          ${org.limit_exceeded_at ? `<div class="alert alert-danger">Credit limit reached on ${new Date(org.limit_exceeded_at).toLocaleDateString()} — services are paused until the cycle resets.</div>` : ""}
          <div class="progress-wrap" style="margin-bottom:6px">
            <div class="progress-bar" style="height:10px">
              <div class="progress-fill ${fillClass}" style="width:${Math.min(pct, 100)}%"></div>
            </div>
            <span class="progress-label font-semibold">${pct}%</span>
          </div>
          <div class="text-muted" style="font-size:13px">
            ${remaining.toLocaleString()} of ${limit.toLocaleString()} credits remaining · resets ${resetDate}
          </div>
        </div>
      </div>
    </div>
    <div class="stat-grid">
      ${!currentIsDemo ? (() => {
        const st = org.subscription_status || "unknown";
        const stBadge = st === "active" ? "badge-green" : (st === "trialing" || st === "past_due") ? "badge-yellow" : "badge-red";
        const plan = org.subscription_plan ? org.subscription_plan[0].toUpperCase() + org.subscription_plan.slice(1) : "—";
        return `<div class="stat-card">
          <div class="stat-label">Subscription</div>
          <div class="stat-value stat-value-md"><span class="badge ${stBadge}">${escHtml(st)}</span></div>
          <div class="stat-sub">${plan} plan</div>
        </div>`;
      })() : ""}
      ${!currentIsDemo ? `<div class="stat-card">
        <div class="stat-label">Renewal</div>
        <div class="stat-value stat-value-md">${org.subscription_end_date
          ? new Date(org.subscription_end_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
          : "—"}</div>
        <div class="stat-sub">Current period ends</div>
      </div>` : ""}
      <div class="stat-card">
        <div class="stat-label">Conversations This Cycle</div>
        <div class="stat-value">${convTotal.toLocaleString()}</div>
        <div class="stat-sub">${conv.webchat.toLocaleString()} webchat · ${conv.email.toLocaleString()} email</div>
      </div>
      ${!currentIsDemo ? (() => {
        if (!lastPayment) {
          return `<div class="stat-card">
            <div class="stat-label">Last Payment</div>
            <div class="stat-value stat-value-md">—</div>
            <div class="stat-sub">No payments yet</div>
          </div>`;
        }
        const paid = new Date(lastPayment.created_at);
        const paidDateStr = paid.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        const paidDay = paid.getUTCDate();
        const billingDay = org.billing_day_of_month || 1;
        const cmp = paidDay < billingDay ? "before" : paidDay === billingDay ? "on" : "after";
        const badgeClass = cmp === "after" ? "badge-red" : cmp === "on" ? "badge-yellow" : "badge-green";
        return `<div class="stat-card">
          <div class="stat-label">Last Payment</div>
          <div class="stat-value stat-value-md">${paidDateStr}</div>
          <div class="stat-sub"><span class="badge ${badgeClass}">${cmp} billing date</span></div>
        </div>`;
      })() : ""}
      <div class="stat-card">
        <div class="stat-label">Knowledge Base</div>
        <div class="stat-value stat-value-md">${kbDocs?.[0] ? `v${kbDocs[0].version}` : "—"}</div>
        <div class="stat-sub">${kbDocs?.[0]
          ? `Updated ${new Date(kbDocs[0].created_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`
          : "No KB yet"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Member Since</div>
        <div class="stat-value stat-value-md">${org.created_at
          ? new Date(org.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })
          : "—"}</div>
        <div class="stat-sub">${org.created_by_name ? `Created by ${escHtml(org.created_by_name)}` : ""}</div>
      </div>
    </div>
    ${!currentIsDemo ? `<div class="text-muted" style="font-size:13px;margin-top:12px">
      Client: ${client
        ? (isOwner
          ? `<a href="#" onclick="navigate('clients');return false" style="color:inherit;text-decoration:underline">${escHtml(client.name)}</a>`
          : escHtml(client.name))
        : "—"}
    </div>` : ""}
    <div class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">Account Notes</div></div>
      <div class="card-body">
        <div class="form-group" style="margin-bottom:10px">
          <textarea id="org-note-input" rows="2" placeholder="Leave a note on this account…" maxlength="2000"></textarea>
        </div>
        <div class="flex-row" style="justify-content:flex-end;margin-bottom:6px">
          <button class="btn btn-primary btn-sm" onclick="addOrgNote()">Add Note</button>
        </div>
        ${notes?.length ? `<table style="margin-top:8px">
          <thead><tr><th style="width:150px">Date</th><th style="width:140px">By</th><th>Note</th><th style="width:44px"></th></tr></thead>
          <tbody>${notes.map(n => `<tr>
            <td class="text-sm">${new Date(n.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</td>
            <td class="text-sm">${escHtml(n.created_by_name || "—")}</td>
            <td class="text-sm" style="white-space:pre-wrap">${escHtml(n.body)}</td>
            <td>${(isOwner || n.created_by === dashUser?.id)
              ? `<button class="btn btn-ghost btn-sm" title="Delete note" onclick="deleteOrgNote('${n.id}')">&times;</button>`
              : ""}</td>
          </tr>`).join("")}</tbody>
        </table>` : `<div class="text-muted" style="font-size:13px;margin-top:8px">No notes yet.</div>`}
      </div>
    </div>`;
}

async function addOrgNote() {
  const input = document.getElementById("org-note-input");
  const text = (input?.value || "").trim();
  if (!text) { toast("Note cannot be empty", "error"); return; }
  try {
    const { note } = await api("add_org_note", { org_id: currentOrgId, body: text });
    window._orgData.notes = [note, ...(window._orgData.notes || [])];
    toast("Note added", "success");
    renderTab();
  } catch (e) { toast(e.message, "error"); }
}

async function deleteOrgNote(noteId) {
  if (!confirm("Delete this note?")) return;
  try {
    await api("delete_org_note", { org_id: currentOrgId, note_id: noteId });
    window._orgData.notes = (window._orgData.notes || []).filter(n => n.id !== noteId);
    toast("Note deleted", "success");
    renderTab();
  } catch (e) { toast(e.message, "error"); }
}

// ── Channels Tab ─────────────────────────────────────────────────────────────
// One tab per org for all communication channels. Each channel gets its own
// sub-panel with its own config; new channels (voice, SMS, WhatsApp, …)
// slot in as additional pills here.

let currentChannel = "webchat";

function renderChannelsTab(el, org, providers, widget) {
  if (currentIsDemo) currentChannel = "webchat";
  el.innerHTML = `
    <div class="tabs" style="margin-bottom:16px">
      <button class="tab ${currentChannel === "webchat" ? "active" : ""}" onclick="switchChannel('webchat')">Website Chat</button>
      ${!currentIsDemo ? `<button class="tab ${currentChannel === "email" ? "active" : ""}" onclick="switchChannel('email')">Email</button>` : ""}
    </div>
    <div id="channel-panel"></div>`;
  const panel = document.getElementById("channel-panel");
  if (currentChannel === "email" && !currentIsDemo) renderEmailTab(panel, org, providers);
  else renderWidgetTab(panel, widget, org);
}

function switchChannel(channel) {
  currentChannel = channel;
  renderTab();
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
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">AI Responses</div></div>
      <div class="card-body">
        <div class="toggle-row" style="border-bottom:none">
          <div>
            <div class="toggle-label">Email AI Responses</div>
            <div class="toggle-desc">${provider
              ? "Process inbound emails with AI (disable to save messages without AI)"
              : "Connect an email account above to enable AI responses"}</div>
          </div>
          ${isOwner ? `<label class="toggle">
            <input type="checkbox" id="email-ai-toggle" ${org.ai_responses_enabled && provider ? "checked" : ""}
              ${provider ? "" : "disabled"}
              onchange="toggleEmailAi(this.checked)">
            <span class="toggle-slider"></span>
          </label>` : `<span class="badge badge-${org.ai_responses_enabled && provider ? "green" : "gray"}">${org.ai_responses_enabled && provider ? "Enabled" : "Disabled"}</span>`}
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
    </div>`;
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

function copyAuthLink() {
  if (window._authLink) {
    navigator.clipboard.writeText(window._authLink);
    toast("Copied", "success");
  }
}
function openAuthLink() {
  if (window._authLink) {
    window.open(window._authLink, "_blank");
  }
}

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
	<script src="https://ctr.horusdesk.com/widget.js" async><\/script>`;

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header">
        <div class="card-title">Widget Status</div>
        ${isOwner ? `
        <label class="toggle">
          <input type="checkbox" id="widget-enabled-toggle" ${widget.enabled ? "checked" : ""}
            onchange="toggleWidget(this.checked)">
          <span class="toggle-slider"></span>
        </label>` : `
        <span class="badge badge-${widget.enabled ? "green" : "gray"}">${widget.enabled ? "Enabled" : "Disabled"}</span>`}
      </div>
      ${!(currentIsDemo && !isOwner) ? `<div class="card-body">
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
      </div>` : ""}
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
        <div class="form-group" style="margin-top:4px">
          <label style="text-transform:none;letter-spacing:0;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
            <input type="checkbox" id="w-disclaimer-enabled" ${widget.disclaimer_enabled?"checked":""}> Require disclaimer acceptance before chatting
          </label>
          <div class="form-hint">Visitors must tick a box agreeing to this text before the chat starts. Links: [Terms of Use](https://yoursite.com/terms)</div>
        </div>
        <div class="form-group">
          <label>Disclaimer Text</label>
          <textarea id="w-disclaimer-text" rows="3" maxlength="1000" placeholder="By chatting with us you agree to our [Terms of Use](https://…) and [Privacy Policy](https://…).">${escHtml(widget.disclaimer_text || "")}</textarea>
        </div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig()">
          Save Widget Settings
        </button>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Colors</div></div>
      <div class="card-body">
        <div class="wprev-layout">
          <div class="wprev-table-col">
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
            <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig()">
              Save Widget Settings
            </button>
          </div>
          <div class="wprev-preview-col">
            <div class="wprev-mode-toggle">
              <button class="btn btn-sm" id="wprev-mode-light" onclick="setWidgetPreviewMode('light')">Light</button>
              <button class="btn btn-sm" id="wprev-mode-dark" onclick="setWidgetPreviewMode('dark')">Dark</button>
            </div>
            <div id="wprev-root">
              <div class="wprev-window">
                <div class="wprev-header">
                  <span id="wprev-title">Chat with us</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </div>
                <div class="wprev-messages">
                  <div class="wprev-msg ai">
                    <div class="wprev-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
                    <div class="wprev-bubble" id="wprev-welcome">Hi! How can we help you today?</div>
                  </div>
                  <div class="wprev-msg user"><div class="wprev-bubble">Hi! Do you have any availability this Saturday?</div></div>
                  <div class="wprev-msg ai">
                    <div class="wprev-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
                    <div class="wprev-bubble">Yes — we have openings Saturday morning. Would you like me to book one for you?</div>
                  </div>
                </div>
                <div class="wprev-input-area">
                  <div class="wprev-input">Type a message…</div>
                  <div class="wprev-send"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg></div>
                </div>
                <div class="wprev-powered">Powered by <strong>Horus Desk</strong></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    ${!(currentIsDemo && !isOwner) ? `<div class="card mb-4">
      <div class="card-header"><div class="card-title">Domain Whitelist</div></div>
      <div class="card-body">
        <div class="form-group">
          <label>Allowed Domains <span class="hint">(comma-separated, empty = allow all)</span></label>
          <input type="text" id="w-domains" value="${escHtml(domains)}" placeholder="example.com, www.example.com" />
        </div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig()">
          Save Widget Settings
        </button>
      </div>
    </div>` : ""}

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Pre-Chat Gate</div></div>
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
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig()">
          Save Widget Settings
        </button>
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

  // Wire up color input live preview labels + live widget preview
  const colorFieldKeys = colorFields.map(f => f.key);
  colorFieldKeys.forEach(key => {
    ["cl", "cd"].forEach(prefix => {
      const input = document.getElementById(`${prefix}-${key}`);
      const val = document.getElementById(`${prefix}-${key}-val`);
      if (input && val) {
        input.addEventListener("input", () => { val.textContent = input.value; updateWidgetPreview(); });
      }
    });
  });
  ["w-header-title", "w-welcome"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", updateWidgetPreview);
  });
  updateWidgetPreview();
}

// ── Widget live preview (Colors card) ─────────────────────────────────────────

let _widgetPreviewMode = "light";

function setWidgetPreviewMode(mode) {
  _widgetPreviewMode = mode;
  updateWidgetPreview();
}

function updateWidgetPreview() {
  const root = document.getElementById("wprev-root");
  if (!root) return;
  const prefix = _widgetPreviewMode === "dark" ? "cd" : "cl";
  const varNames = {
    headerBg: "--horus-header-bg", headerText: "--horus-header-text",
    userBubble: "--horus-user-bubble", userText: "--horus-user-text",
    aiBubble: "--horus-ai-bubble", aiText: "--horus-ai-text",
    bg: "--horus-bg", inputBg: "--horus-input-bg", inputText: "--horus-input-text",
    sendBtn: "--horus-send-btn", sendBtnText: "--horus-send-btn-text",
  };
  Object.entries(varNames).forEach(([key, varName]) => {
    const input = document.getElementById(`${prefix}-${key}`);
    if (input) root.style.setProperty(varName, input.value);
  });
  root.style.setProperty("--horus-border", _widgetPreviewMode === "dark" ? "#374151" : "#e5e7eb");
  const title = document.getElementById("w-header-title")?.value.trim() || "Chat with us";
  const welcome = document.getElementById("w-welcome")?.value.trim() || "Hi! How can we help you today?";
  const titleEl = document.getElementById("wprev-title");
  const welcomeEl = document.getElementById("wprev-welcome");
  if (titleEl) titleEl.textContent = title;
  if (welcomeEl) welcomeEl.textContent = welcome;
  const lightBtn = document.getElementById("wprev-mode-light");
  const darkBtn = document.getElementById("wprev-mode-dark");
  if (lightBtn && darkBtn) {
    lightBtn.className = `btn btn-sm ${_widgetPreviewMode === "light" ? "btn-primary" : "btn-secondary"}`;
    darkBtn.className = `btn btn-sm ${_widgetPreviewMode === "dark" ? "btn-primary" : "btn-secondary"}`;
  }
}

// ── Test chat (employee AI playground) ───────────────────────────────────────
// Floating widget on org/demo detail views, shown when the org has an active
// KB version. Styled with the org's saved widget colors. Replies come from
// dashboard-api test_chat → widget-chat test mode: the real AI pipeline runs,
// but nothing is persisted and no credits/usage are consumed.

let _testChat = { history: [], sending: false, live: "" };

const TCHAT_ICONS = {
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  avatar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>`,
  clear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

function maybeMountTestChat(widget, kbDocs) {
  document.getElementById("tchat-root")?.remove();
  if (!kbDocs || !kbDocs.length) return;
  _testChat = { history: [], sending: false, live: "" };
  const root = document.createElement("div");
  root.id = "tchat-root";
  const c = widget?.colors?.light || {};
  const varMap = {
    "--horus-header-bg": c.headerBg, "--horus-header-text": c.headerText,
    "--horus-user-bubble": c.userBubble, "--horus-user-text": c.userText,
    "--horus-ai-bubble": c.aiBubble, "--horus-ai-text": c.aiText,
    "--horus-bg": c.bg, "--horus-input-bg": c.inputBg, "--horus-input-text": c.inputText,
    "--horus-send-btn": c.sendBtn, "--horus-send-btn-text": c.sendBtnText,
  };
  Object.entries(varMap).forEach(([k, v]) => { if (v) root.style.setProperty(k, v); });
  root.innerHTML = `
    <button class="tchat-fab" onclick="toggleTestChat()" title="Test the AI">${TCHAT_ICONS.chat}</button>
    <div class="tchat-window" id="tchat-window">
      <div class="tchat-header">
        <span>${escHtml(widget?.header_title || "Chat with us")}</span>
        <span class="tchat-header-btns">
          <span class="tchat-test-pill">TEST</span>
          <button onclick="clearTestChat()" title="Clear conversation">${TCHAT_ICONS.clear}</button>
          <button onclick="toggleTestChat()" title="Close">${TCHAT_ICONS.close}</button>
        </span>
      </div>
      <div class="tchat-messages" id="tchat-messages"></div>
      <div class="tchat-input-area">
        <input class="tchat-input" id="tchat-input" placeholder="Type a test message…" maxlength="2000"
          onkeydown="if(event.key==='Enter'){event.preventDefault();sendTestChat();}">
        <button class="tchat-send" id="tchat-send" onclick="sendTestChat()">${TCHAT_ICONS.send}</button>
      </div>
      <div class="tchat-footer">Test mode — no credits used, nothing saved</div>
    </div>`;
  document.body.appendChild(root);
  renderTestChatMessages();
}

function toggleTestChat() {
  const win = document.getElementById("tchat-window");
  if (!win) return;
  win.classList.toggle("open");
  if (win.classList.contains("open")) {
    document.getElementById("tchat-input")?.focus();
  }
}

function clearTestChat() {
  _testChat.history = [];
  renderTestChatMessages();
}

function renderTestChatMessages() {
  const box = document.getElementById("tchat-messages");
  if (!box) return;
  const welcome = window._orgData?.widget?.welcome_message || "Hi there! How can I help you today?";
  let html = `<div class="tchat-msg ai"><div class="tchat-avatar">${TCHAT_ICONS.avatar}</div><div class="tchat-bubble">${escHtml(welcome)}</div></div>`;
  for (const m of _testChat.history) {
    if (m.role === "user") {
      html += `<div class="tchat-msg user"><div class="tchat-bubble">${escHtml(m.content)}</div></div>`;
    } else {
      html += `<div class="tchat-msg ai"><div class="tchat-avatar">${TCHAT_ICONS.avatar}</div><div class="tchat-bubble">${escHtml(m.content)}${m.escalated ? `<span class="tchat-flag">⚠ AI would escalate${m.escalation_type ? ` (${escHtml(m.escalation_type)})` : ""}</span>` : ""}</div></div>`;
    }
  }
  if (_testChat.sending) {
    if (_testChat.live) {
      html += `<div class="tchat-msg ai"><div class="tchat-avatar">${TCHAT_ICONS.avatar}</div><div class="tchat-bubble" id="tchat-live">${escHtml(_testChat.live)}</div></div>`;
    } else {
      html += `<div class="tchat-msg ai"><div class="tchat-avatar">${TCHAT_ICONS.avatar}</div><div class="tchat-bubble tchat-typing"><span></span><span></span><span></span></div></div>`;
    }
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

async function sendTestChat() {
  const input = document.getElementById("tchat-input");
  const text = (input?.value || "").trim();
  if (!text || _testChat.sending) return;
  _testChat.sending = true;
  _testChat.live = "";
  input.value = "";
  _testChat.history.push({ role: "user", content: text });
  renderTestChatMessages();
  try {
    // Streaming mode: dashboard-api pipes widget-chat's SSE straight through.
    // Events: {type:"delta",text} as the reply generates, then one terminal
    // {type:"done",message,escalated,…} with routing metadata.
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) throw new Error("Not authenticated");
    const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/dashboard-api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        action: "test_chat",
        org_id: currentOrgId,
        message: text,
        history: _testChat.history.slice(0, -1),
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let donePayload = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === "delta" && evt.text) {
          const first = !_testChat.live;
          _testChat.live += evt.text;
          if (first) {
            renderTestChatMessages(); // swap typing dots for the live bubble
          } else {
            const el = document.getElementById("tchat-live");
            if (el) el.textContent = _testChat.live;
          }
          const box = document.getElementById("tchat-messages");
          if (box) box.scrollTop = box.scrollHeight;
        } else if (evt.type === "done") {
          donePayload = evt;
        } else if (evt.type === "error") {
          throw new Error(evt.error || "Stream failed");
        }
      }
    }
    if (!donePayload) throw new Error("Stream ended unexpectedly");
    _testChat.history.push({ role: "assistant", content: donePayload.message || _testChat.live, escalated: donePayload.escalated, escalation_type: donePayload.escalation_type });
  } catch (e) {
    _testChat.history.push({ role: "assistant", content: `⚠ ${e.message}` });
  }
  _testChat.sending = false;
  _testChat.live = "";
  renderTestChatMessages();
}

// ── Org logo upload ─────────────────────────────────────────────────────────
// File is decoded in the browser, center-cropped to a square 256px PNG, then
// sent as a data URL — anything the browser can decode (png/jpg/webp/gif/svg)
// gets normalized; undecodable files (e.g. iPhone HEIC) get a friendly error.

function downscaleToPng(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

async function uploadOrgLogo(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast("Image too large (max 10MB)", "error");
    input.value = "";
    return;
  }
  try {
    const dataUrl = await downscaleToPng(file);
    const { logo_url } = await api("upload_org_logo", { org_id: currentOrgId, image: dataUrl });
    window._orgData.org.logo_url = logo_url;
    renderSettingsTab(document.getElementById("tab-content"), window._orgData.org);
    toast("Logo uploaded", "success");
  } catch (e) {
    toast(e.message?.includes("decode") ? "Couldn't read that image — please use PNG or JPG" : e.message, "error");
  } finally {
    input.value = "";
  }
}

async function removeOrgLogo() {
  try {
    await api("remove_org_logo", { org_id: currentOrgId });
    window._orgData.org.logo_url = null;
    renderSettingsTab(document.getElementById("tab-content"), window._orgData.org);
    toast("Logo removed", "success");
  } catch (e) { toast(e.message, "error"); }
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

async function saveWidgetConfig() {
  const colorFields = ["headerBg","headerText","userBubble","userText","aiBubble","aiText","bg","inputBg","inputText","sendBtn","sendBtnText"];

  const light = {}, dark = {};
  colorFields.forEach(key => {
    const lEl = document.getElementById(`cl-${key}`);
    const dEl = document.getElementById(`cd-${key}`);
    if (lEl) light[key] = lEl.value;
    if (dEl) dark[key] = dEl.value;
  });

  const domainsEl = document.getElementById("w-domains");
  const domains = domainsEl
    ? (domainsEl.value || "").split(",").map(d => d.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean)
    : null;

  const captureFields = ["name","email","phone"].filter(f => document.getElementById(`w-field-${f}`)?.checked);
  const requiredFields = ["name","email","phone"].filter(f => document.getElementById(`w-req-${f}`)?.checked);

  try {
    const updates = {
      header_title: document.getElementById("w-header-title").value.trim(),
      welcome_message: document.getElementById("w-welcome").value.trim(),
      position: document.getElementById("w-position").value,
      form_title: document.getElementById("w-form-title")?.value.trim(),
      form_subtitle: document.getElementById("w-form-subtitle")?.value.trim(),
      capture_fields: captureFields,
      required_fields: requiredFields,
      disclaimer_enabled: !!document.getElementById("w-disclaimer-enabled")?.checked,
      disclaimer_text: document.getElementById("w-disclaimer-text")?.value.trim() || "",
      colors: { light, dark },
    };
    if (domains !== null) updates.allowed_domains = domains;

    await api("update_widget", {
      org_id: currentOrgId,
      updates,
    });
    toast("Widget settings saved", "success");
  } catch (e) { toast(e.message, "error"); }
}

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

// ── Integrations Tab ─────────────────────────────────────────────────────────

function renderIntegrationsTab(el, org, integrations, providers) {
  const allIntegrations = integrations || [];
  const calendly = allIntegrations.find(i => i.integration_type === "calendly" && i.status === "active");
  const googleProvider = (providers || []).find(p => p.provider === "google" && p.status === "active");
  const hasCalendarScope = googleProvider?.granted_scopes?.some(s => s.includes("calendar")) ?? false;

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Calendly</div></div>
      <div class="card-body">
        ${calendly ? `
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
            <div>
              <div style="font-weight:600">Connected</div>
              <div class="text-muted" style="margin-top:2px;font-size:13px">
                <span class="badge badge-green">active</span>
                &middot; Last updated: ${new Date(calendly.updated_at).toLocaleDateString()}
              </div>
              ${calendly.config?.event_types?.length ? `
              <div class="text-muted" style="margin-top:4px;font-size:13px">
                Event types: ${calendly.config.event_types.map(et => escHtml(et.name)).join(", ")}
              </div>` : ""}
              ${calendly.config?.calendly_user_name ? `
              <div class="text-muted" style="margin-top:2px;font-size:13px">
                Account: ${escHtml(calendly.config.calendly_user_name)}
              </div>` : ""}
            </div>
          </div>
          <p class="text-muted" style="margin-bottom:12px;font-size:13px">
            The AI receptionist uses Calendly to check real-time availability.${hasCalendarScope ? " Bookings are made directly on Google Calendar." : ""}
          </p>
          <button class="btn btn-danger" onclick="disconnectCalendly()">Disconnect Calendly</button>
        ` : `
          <p class="text-muted" style="margin-bottom:16px">
            Connect Calendly to let the AI receptionist check real-time availability and create booking links for customers automatically during conversations.
          </p>
          <button class="btn btn-secondary" id="btn-connect-calendly" onclick="connectCalendly()">Connect Calendly</button>
        `}
      </div>
    </div>
    <div class="card" id="calendly-auth-link-card" style="display:none">
      <div class="card-header"><div class="card-title">Calendly Authorization Link</div></div>
      <div class="card-body">
        <p class="text-muted">Open this link to authorize Calendly access:</p>
        <div style="background:var(--bg-tertiary);padding:12px;border-radius:6px;word-break:break-all;font-size:13px;font-family:monospace" id="calendly-auth-link-display"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-secondary" onclick="copyCalendlyAuthLink()">Copy Link</button>
          <button class="btn btn-primary" onclick="openCalendlyAuthLink()">Open Link</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">Google Calendar Booking</div></div>
      <div class="card-body" id="gcal-card-body">
        ${(() => {
          const gcalIntegration = allIntegrations.find(i => i.integration_type === "google_calendar" && i.status === "active");
          if (gcalIntegration) {
            const acctEmail = gcalIntegration.config?.account_email || "connected account";
            return `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <span class="badge badge-green">Active</span>
                <span class="text-muted" style="font-size:13px">${escHtml(acctEmail)} (separate account)</span>
              </div>
              <p class="text-muted" style="font-size:13px;margin-bottom:12px">
                The AI receptionist books appointments on this Google Calendar and sends customers a calendar invite.
              </p>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">Calendar</label>
                <select id="gcal-calendar-select" onchange="saveGoogleCalendarSelection()" style="width:100%;max-width:320px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
                  <option value="">Primary Calendar</option>
                </select>
                <div id="gcal-calendar-loading" class="text-muted" style="font-size:12px;margin-top:4px">Loading calendars...</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn btn-danger" onclick="disconnectGoogleCalendar()">Disconnect</button>
                ${hasCalendarScope ? '<button class="btn btn-secondary" onclick="disconnectGoogleCalendar()" title="Remove separate account and use Gmail calendar instead">Switch to Gmail Calendar</button>' : ''}
              </div>`;
          }
          if (hasCalendarScope) {
            return `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <span class="badge badge-green">Active</span>
                <span class="text-muted" style="font-size:13px">${escHtml(googleProvider.provider_account_email)} (Gmail)</span>
              </div>
              <p class="text-muted" style="font-size:13px;margin-bottom:12px">
                The AI receptionist books appointments on your Google Calendar and sends customers a calendar invite.
              </p>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">Calendar</label>
                <select id="gcal-calendar-select" onchange="saveGoogleCalendarSelection()" style="width:100%;max-width:320px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px">
                  <option value="">Primary Calendar</option>
                </select>
                <div id="gcal-calendar-loading" class="text-muted" style="font-size:12px;margin-top:4px">Loading calendars...</div>
              </div>
              <button class="btn btn-secondary" id="btn-connect-gcal" onclick="connectGoogleCalendar()">Connect Different Google Account for Calendar</button>`;
          }
          if (googleProvider) {
            return `
              <p class="text-muted" style="margin-bottom:12px;font-size:13px">
                Your Google account is connected for email but calendar booking is not authorized. Re-connect Google in the <strong>Email Setup</strong> tab to enable in-chat booking.
              </p>
              <span class="badge badge-yellow">Requires re-authorization</span>
              <div style="margin-top:12px">
                <button class="btn btn-secondary" id="btn-connect-gcal" onclick="connectGoogleCalendar()">Or Connect Different Google Account for Calendar</button>
              </div>`;
          }
          return `
            <p class="text-muted" style="font-size:13px;margin-bottom:12px">
              ${(providers || []).some(p => p.provider === "microsoft") ? "Your email is connected via Microsoft. To enable Google Calendar booking, connect a Google account below." : "Connect a Google account in the <strong>Email Setup</strong> tab to enable direct calendar booking from conversations."}
            </p>
            <button class="btn btn-secondary" id="btn-connect-gcal" onclick="connectGoogleCalendar()">Connect Google Calendar</button>`;
        })()}
      </div>
    </div>
    <div class="card" id="gcal-auth-link-card" style="display:none;margin-top:16px">
      <div class="card-header"><div class="card-title">Google Calendar Authorization Link</div></div>
      <div class="card-body">
        <p class="text-muted">Open this link to authorize Google Calendar access:</p>
        <div style="background:var(--bg-tertiary);padding:12px;border-radius:6px;word-break:break-all;font-size:13px;font-family:monospace" id="gcal-auth-link-display"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-secondary" onclick="copyGcalAuthLink()">Copy Link</button>
          <button class="btn btn-primary" onclick="openGcalAuthLink()">Open Link</button>
        </div>
      </div>
    </div>`;

  // Load calendar dropdown if the card has a select element
  if (document.getElementById("gcal-calendar-select")) {
    loadGoogleCalendars();
  }
}

async function connectCalendly() {
  const btn = document.getElementById("btn-connect-calendly");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;display:inline-block"></div> Generating...';
  }
  try {
    const { url } = await api("get_calendly_auth_link", { org_id: currentOrgId });
    window._calendlyAuthLink = url;
    document.getElementById("calendly-auth-link-display").textContent = url;
    document.getElementById("calendly-auth-link-card").style.display = "";
    toast("Calendly authorization link generated", "success");
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Connect Calendly";
    }
  }
}

function copyCalendlyAuthLink() {
  if (window._calendlyAuthLink) {
    navigator.clipboard.writeText(window._calendlyAuthLink);
    toast("Copied to clipboard", "success");
  }
}

function openCalendlyAuthLink() {
  if (window._calendlyAuthLink) {
    window.open(window._calendlyAuthLink, "_blank");
  }
}

async function loadGoogleCalendars() {
  const select = document.getElementById("gcal-calendar-select");
  const loading = document.getElementById("gcal-calendar-loading");
  if (!select) return;

  try {
    const calResult = await api("list_google_calendars", { org_id: currentOrgId });
    const calendars = calResult.calendars || [];

    // Get current selection from integration or gmail provider
    const { google_calendar: gcalIntegration, gmail_calendar } = await api("get_google_calendar_status", { org_id: currentOrgId });
    let selectedId = "";
    if (gcalIntegration?.config?.selected_calendar_id) {
      selectedId = gcalIntegration.config.selected_calendar_id;
    } else if (gmail_calendar?.selected_calendar_id) {
      selectedId = gmail_calendar.selected_calendar_id;
    }

    select.innerHTML = '<option value="">Primary Calendar</option>';
    if (calResult.scope_missing) {
      if (loading) loading.textContent = "Calendar list unavailable — re-connect Google or connect a separate account to enable selection.";
      return;
    }
    calendars.forEach(cal => {
      const opt = document.createElement("option");
      opt.value = cal.id;
      opt.textContent = cal.summary + (cal.primary ? " (Primary)" : "");
      if (cal.id === selectedId) opt.selected = true;
      select.appendChild(opt);
    });

    if (loading) loading.style.display = "none";
  } catch (e) {
    if (loading) loading.textContent = "Could not load calendars";
    console.error("loadGoogleCalendars error:", e);
  }
}

async function saveGoogleCalendarSelection() {
  const select = document.getElementById("gcal-calendar-select");
  if (!select) return;
  try {
    await api("update_google_calendar_selection", {
      org_id: currentOrgId,
      calendar_id: select.value || null,
    });
    toast("Calendar selection saved", "success");
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  }
}

async function connectGoogleCalendar() {
  const btn = document.getElementById("btn-connect-gcal");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;display:inline-block"></div> Generating...';
  }
  try {
    const { url } = await api("get_google_calendar_auth_link", { org_id: currentOrgId });
    window._gcalAuthLink = url;
    document.getElementById("gcal-auth-link-display").textContent = url;
    document.getElementById("gcal-auth-link-card").style.display = "";
    toast("Google Calendar authorization link generated", "success");
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Connect Google Calendar";
    }
  }
}

async function disconnectGoogleCalendar() {
  if (!confirm("Disconnect Google Calendar integration? Bookings will fall back to the Gmail calendar if available.")) return;
  try {
    await api("disconnect_google_calendar", { org_id: currentOrgId });
    toast("Google Calendar disconnected", "success");
    const data = await api("get_org", { org_id: currentOrgId });
    window._orgData = { ...window._orgData, ...data };
    renderTab();
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  }
}

function copyGcalAuthLink() {
  if (window._gcalAuthLink) {
    navigator.clipboard.writeText(window._gcalAuthLink);
    toast("Copied to clipboard", "success");
  }
}

function openGcalAuthLink() {
  if (window._gcalAuthLink) {
    window.open(window._gcalAuthLink, "_blank");
  }
}

async function disconnectCalendly() {
  if (!confirm("Disconnect Calendly? The AI will fall back to sharing the manual booking link.")) return;
  try {
    await api("disconnect_calendly", { org_id: currentOrgId });
    toast("Calendly disconnected", "success");
    const data = await api("get_org", { org_id: currentOrgId });
    window._orgData = { ...window._orgData, ...data };
    renderTab();
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  }
}

// ── Settings Tab ─────────────────────────────────────────────────────────────

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
      <div class="card-header"><div class="card-title">Organization Logo</div></div>
      <div class="card-body">
        <div class="logo-row">
          <div class="logo-preview">
            ${org.logo_url
              ? `<img src="${escHtml(org.logo_url)}" alt="Logo" />`
              : `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>`}
          </div>
          <div>
            <div class="hint mb-2">Shown in the chat widget header and as the AI's avatar. A square image works best — any common format, automatically resized to 256px.</div>
            <input type="file" id="s-logo-file" accept="image/*" style="display:none" onchange="uploadOrgLogo(this)">
            <button class="btn btn-primary" onclick="document.getElementById('s-logo-file').click()">Upload Logo</button>
            ${org.logo_url ? `<button class="btn btn-secondary" style="margin-left:8px" onclick="removeOrgLogo()">Remove</button>` : ""}
          </div>
        </div>
      </div>
    </div>

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
            <label>Timezone</label>
            <select id="s-timezone">
              ${[
                { tz: "UTC",                  label: "UTC" },
                { tz: "Africa/Cairo",         label: "Africa / Cairo (UTC+2)" },
                { tz: "America/New_York",     label: "US / Eastern Time (UTC-5)" },
                { tz: "America/Chicago",      label: "US / Central Time (UTC-6)" },
                { tz: "America/Denver",       label: "US / Mountain Time (UTC-7)" },
                { tz: "America/Los_Angeles",  label: "US / Pacific Time (UTC-8)" },
                { tz: "Europe/London",        label: "Europe / London (UTC+0)" },
                { tz: "Europe/Paris",         label: "Europe / Paris (UTC+1)" },
                { tz: "Europe/Berlin",        label: "Europe / Berlin (UTC+1)" },
                { tz: "Europe/Madrid",        label: "Europe / Madrid (UTC+1)" },
                { tz: "Europe/Rome",          label: "Europe / Rome (UTC+1)" },
                { tz: "Europe/Amsterdam",     label: "Europe / Amsterdam (UTC+1)" },
                { tz: "Europe/Istanbul",      label: "Europe / Istanbul (UTC+3)" },
                { tz: "Europe/Moscow",        label: "Europe / Moscow (UTC+3)" },
              ].map(o =>
                `<option value="${o.tz}" ${(org.business_hours_timezone || "UTC") === o.tz ? "selected" : ""}>${o.label}</option>`
              ).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>AI Tone</label>
            <select id="s-tone">
              ${["professional","friendly","formal","casual"].map(t =>
                `<option value="${t}" ${org.ai_tone===t?"selected":""}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join("")}
            </select>
          </div>
        </div>
        <div class="form-row">
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
          <div class="form-group">
            <label>Subscription Plan</label>
            <select id="s-plan">
              <option value="monthly" ${org.subscription_plan==="monthly"?"selected":""}>Monthly</option>
              <option value="yearly" ${org.subscription_plan==="yearly"?"selected":""}>Yearly</option>
            </select>
          </div>
          <div class="form-group">
            <!-- spacer to keep the grid even -->
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Subscription Start</label>
            ${isOwner
              ? `<input type="date" id="s-start-date" value="${org.subscription_start_date ? new Date(org.subscription_start_date).toISOString().slice(0,10) : ''}" />`
              : `<input type="text" value="${org.subscription_start_date ? new Date(org.subscription_start_date).toLocaleDateString() : 'Not set'}" readonly />`}
          </div>
          <div class="form-group">
            <label>Subscription End${org.subscription_end_date && new Date(org.subscription_end_date) < new Date() ? ' <span class="badge badge-red" style="margin-left:6px">Expired</span>' : ''}</label>
            ${isOwner
              ? `<input type="date" id="s-end-date" value="${org.subscription_end_date ? new Date(org.subscription_end_date).toISOString().slice(0,10) : ''}" />`
              : `<input type="text" value="${org.subscription_end_date ? new Date(org.subscription_end_date).toLocaleDateString() : 'No expiry'}" readonly />`}
          </div>
        </div>
        ${isOwner ? `
        <div class="form-row">
          <div class="form-group">
            <label>Monthly Message Limit</label>
            <input type="number" id="s-limit" value="${org.message_limit_per_month}" min="100" />
          </div>
          <div class="form-group">
            <label>Payment Due Day</label>
            <select id="s-billing-day">
              ${Array.from({length: 28}, (_, i) => i + 1).map(d =>
                `<option value="${d}" ${(org.billing_day_of_month || 1) === d ? "selected" : ""}>${d}</option>`
              ).join("")}
            </select>
            <div class="form-hint">Day of month when payment is due (1-28). If different from the subscription cycle day, payment covers the next cycle in advance.</div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Auto-Send Min Confidence</label>
            <input type="number" id="s-confidence" value="${org.auto_send_min_confidence}" min="0" max="1" step="0.05" />
          </div>
          <div class="form-group">
            <label>Message Retention</label>
            <select id="s-retention">
              ${[
                { v: 3,   label: "3 days" },
                { v: 7,   label: "7 days" },
                { v: 30,  label: "30 days" },
                { v: 365, label: "1 year (default)" },
              ].map(o =>
                `<option value="${o.v}" ${(org.retention_days ?? 365) === o.v ? "selected" : ""}>${o.label}</option>`
              ).join("")}
            </select>
            <div class="form-hint">Messages older than this are deleted automatically each night. Conversations with no remaining messages are also removed.</div>
          </div>
        </div>` : ""}
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
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Routing Rules</div></div>
      <div class="card-body">
        <p class="text-muted" style="font-size:13px;margin-bottom:12px">
          Customize when the AI uses each routing code. These rules tell the AI
          how to classify responses (draft, ignore, escalate, lead detection).
        </p>
        <div class="form-group">
          <textarea id="s-routing-rules" rows="14">${escHtml(org.routing_rules || DEFAULT_ROUTING_RULES_TEXT)}</textarea>
        </div>
        <div class="flex-row">
          <button class="btn btn-primary" onclick="saveRoutingRules()">Save Routing Rules</button>
          <button class="btn btn-secondary" onclick="resetRoutingRules()">Reset to Defaults</button>
        </div>
      </div>
    </div>

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
    </div>

    <div class="card mb-4" style="border-color:rgba(59,130,246,0.3)">
      <div class="card-header" style="border-color:rgba(59,130,246,0.3)">
        <div class="card-title" style="color:var(--primary)">Renew Subscription</div>
      </div>
      <div class="card-body">
        <p class="text-muted" style="font-size:13px;margin-bottom:12px">
          Extend subscription from ${org.subscription_end_date ? new Date(org.subscription_end_date).toLocaleDateString() : "now"}.
          Current plan: <strong>${org.subscription_plan || "monthly"}</strong>.
        </p>
        <div class="form-row" style="margin-bottom:12px">
          <div class="form-group">
            <label>Renew as</label>
            <select id="renew-plan">
              <option value="monthly" ${org.subscription_plan==="monthly"?"selected":""}>Monthly</option>
              <option value="yearly" ${org.subscription_plan==="yearly"?"selected":""}>Yearly</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary" onclick="renewSubscription()">Renew Subscription</button>
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
    business_hours_timezone: document.getElementById("s-timezone").value,
    ai_tone: document.getElementById("s-tone").value,
    subscription_tier: document.getElementById("s-tier").value,
    subscription_plan: document.getElementById("s-plan").value,
  };
  if (isOwner) {
    updates.auto_send_min_confidence = parseFloat(document.getElementById("s-confidence").value);
    updates.retention_days = parseInt(document.getElementById("s-retention").value, 10);
    updates.message_limit_per_month = parseInt(document.getElementById("s-limit").value);
    updates.billing_day_of_month = parseInt(document.getElementById("s-billing-day").value);
    const startVal = document.getElementById("s-start-date").value;
    const endVal = document.getElementById("s-end-date").value;
    updates.subscription_start_date = startVal ? new Date(startVal + "T00:00:00Z").toISOString() : null;
    updates.subscription_end_date = endVal ? new Date(endVal + "T00:00:00Z").toISOString() : null;
  }
  try {
    await api("update_org", { org_id: currentOrgId, updates });
    toast("Settings saved", "success");
    const { org } = await api("get_org", { org_id: currentOrgId });
    window._orgData.org = org;
    currentOrgName = org.name;
  } catch (e) { toast(e.message, "error"); }
}

async function renewSubscription() {
  if (!confirm("Renew subscription for this organization?")) return;
  try {
    const plan = document.getElementById("renew-plan").value;
    const { new_end_date } = await api("renew_subscription", { org_id: currentOrgId, plan });
    toast(`Subscription renewed until ${new Date(new_end_date).toLocaleDateString()}`, "success");
    const { org } = await api("get_org", { org_id: currentOrgId });
    window._orgData.org = org;
    renderTab(currentTab);
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
    const hint = document.getElementById("s-prompt")?.closest(".form-group")?.querySelector(".form-hint");
    if (hint) hint.textContent = `Version: ${currentVersion + 1}`;
  } catch (e) { toast(e.message, "error"); }
}

async function saveRoutingRules() {
  const rules = document.getElementById("s-routing-rules").value.trim();
  try {
    await api("update_org", {
      org_id: currentOrgId,
      updates: { routing_rules: rules || null },
    });
    window._orgData.org.routing_rules = rules || null;
    toast("Routing rules saved", "success");
  } catch (e) { toast(e.message, "error"); }
}

function resetRoutingRules() {
  if (!confirm("Reset routing rules to defaults?")) return;
  document.getElementById("s-routing-rules").value = DEFAULT_ROUTING_RULES_TEXT;
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

// ── Reports Tab ──────────────────────────────────────────────────────────────
// On-demand and scheduled exports of an org's message history as CSV.

const FREQUENCY_LABELS = {
  daily: "Daily (last 1 day)",
  weekly: "Weekly (last 7 days)",
  monthly: "Monthly (last 30 days)",
  quarterly: "Quarterly (last 90 days)",
};

function renderReportsTab(el, org) {
  // Default range: last 7 days through today.
  const today = new Date();
  const sevenAgo = new Date(today.getTime() - 7 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Export Messages</div></div>
      <div class="card-body">
        <p class="text-muted" style="font-size:13px;margin-bottom:16px">
          Generate a CSV of this organization's messages and email a download link to a recipient. Links expire after 7 days.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Start Date</label>
            <input type="date" id="r-start" value="${fmt(sevenAgo)}" />
          </div>
          <div class="form-group">
            <label>End Date</label>
            <input type="date" id="r-end" value="${fmt(today)}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Send To</label>
            <select id="r-recipient">
              <option value="">Loading recipients…</option>
            </select>
            <div class="form-hint">Defaults to the connected inbox.</div>
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-primary" id="r-send-btn" onclick="runOnDemandExport()">Send Export</button>
        </div>
        <div id="r-status" style="margin-top:16px"></div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <div class="card-title">Scheduled Exports</div>
        <button class="btn btn-secondary btn-sm" onclick="showNewScheduleModal()">+ New Schedule</button>
      </div>
      <div class="card-body">
        <div id="r-schedules">
          <div class="text-muted" style="font-size:13px">Loading schedules…</div>
        </div>
      </div>
    </div>`;

  loadExportRecipients(org.id);
  refreshSchedules(org.id);
}

function recipientOptionsHtml(default_email, notification_recipients) {
  const options = [];
  if (default_email) {
    options.push(
      `<option value="${escHtml(default_email)}">${escHtml(default_email)} (connected inbox)</option>`
    );
  }
  for (const r of notification_recipients) {
    const label = r.name ? `${r.name} <${r.email}>` : r.email;
    options.push(`<option value="${escHtml(r.email)}">${escHtml(label)}</option>`);
  }
  if (options.length === 0) {
    options.push(`<option value="" disabled>No recipients configured</option>`);
  }
  return options.join("");
}

async function populateRecipientOptions(selectId, orgId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  try {
    const { default_email, notification_recipients } = await api(
      "list_export_recipients",
      { org_id: orgId }
    );
    select.innerHTML = recipientOptionsHtml(default_email, notification_recipients);
  } catch (e) {
    select.innerHTML = `<option value="" disabled>Error: ${escHtml(e.message)}</option>`;
  }
}

async function loadExportRecipients(orgId) {
  await populateRecipientOptions("r-recipient", orgId);
}

async function runOnDemandExport() {
  const startVal = document.getElementById("r-start").value;
  const endVal = document.getElementById("r-end").value;
  const recipient = document.getElementById("r-recipient").value;
  const statusEl = document.getElementById("r-status");
  const btn = document.getElementById("r-send-btn");

  if (!startVal || !endVal) {
    statusEl.innerHTML = `<div class="alert alert-danger">Pick a start and end date.</div>`;
    return;
  }
  if (!recipient) {
    statusEl.innerHTML = `<div class="alert alert-danger">Pick a recipient.</div>`;
    return;
  }
  if (startVal > endVal) {
    statusEl.innerHTML = `<div class="alert alert-danger">Start date must be on or before end date.</div>`;
    return;
  }

  // End-of-day boundary so "today through today" returns today's messages.
  const start_date = new Date(startVal + "T00:00:00Z").toISOString();
  const end_date = new Date(endVal + "T23:59:59.999Z").toISOString();

  btn.disabled = true;
  btn.textContent = "Sending…";
  statusEl.innerHTML = `<div class="text-muted" style="font-size:13px">Generating CSV and sending email…</div>`;

  try {
    const res = await api("export_messages", {
      org_id: currentOrgId,
      start_date,
      end_date,
      recipient_email: recipient,
    });
    const linkHtml = `<a href="${escHtml(res.url)}" target="_blank" rel="noopener">Download CSV</a>`;
    const emailNote = res.email_sent
      ? ` Email sent to <strong>${escHtml(recipient)}</strong>.`
      : (res.email_error
          ? ` (Email failed: ${escHtml(res.email_error)})`
          : "");
    statusEl.innerHTML = `
      <div class="alert alert-success">
        Export ready — ${res.message_count.toLocaleString()} message(s).
        ${linkHtml}.${emailNote}
        <div class="text-muted" style="font-size:12px;margin-top:4px">Link expires ${new Date(res.expires_at).toLocaleString()}.</div>
      </div>`;
    toast("Export sent", "success");
  } catch (e) {
    statusEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Export";
  }
}

async function refreshSchedules(orgId) {
  const container = document.getElementById("r-schedules");
  if (!container) return;
  try {
    const { schedules } = await api("list_export_schedules", { org_id: orgId });
    if (!schedules || schedules.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:24px">
          <p class="text-muted" style="font-size:13px">
            No scheduled exports yet. Click "+ New Schedule" to set one up.
          </p>
        </div>`;
      return;
    }

    const rows = schedules.map((s) => {
      const freqLabel = FREQUENCY_LABELS[s.frequency] || s.frequency;
      const nextRun = s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "—";
      const lastRun = s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "Never";
      const statusBadge = !s.last_run_status
        ? `<span class="badge">—</span>`
        : s.last_run_status === "success"
          ? `<span class="badge badge-green">Success</span>`
          : `<span class="badge badge-red" title="${escHtml(s.last_run_error || '')}">Error</span>`;
      const activeBadge = s.is_active
        ? `<span class="badge badge-blue">Active</span>`
        : `<span class="badge">Paused</span>`;
      const toggleLabel = s.is_active ? "Pause" : "Resume";
      return `
        <tr>
          <td>${escHtml(freqLabel)} ${activeBadge}</td>
          <td>${escHtml(s.recipient_email)}</td>
          <td>${escHtml(nextRun)}</td>
          <td>${escHtml(lastRun)}</td>
          <td>${statusBadge}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" onclick="toggleSchedule('${s.id}', ${!s.is_active})">${toggleLabel}</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteSchedule('${s.id}')">Delete</button>
          </td>
        </tr>`;
    }).join("");

    container.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Frequency</th>
              <th>Recipient</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    container.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
  }
}

function showNewScheduleModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">New Scheduled Export</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Frequency</label>
            <select id="new-sch-frequency">
              <option value="daily">Daily (last 1 day)</option>
              <option value="weekly" selected>Weekly (last 7 days)</option>
              <option value="monthly">Monthly (last 30 days)</option>
              <option value="quarterly">Quarterly (last 90 days)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Send To</label>
            <select id="new-sch-recipient">
              <option value="">Loading recipients…</option>
            </select>
            <div class="form-hint">Each scheduled run emails a fresh signed download link to this address.</div>
          </div>
        </div>
        <div id="new-sch-error"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="create-sch-btn" onclick="createSchedule()">Create Schedule</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Populate recipient dropdown by reusing the same lookup
  populateRecipientOptions("new-sch-recipient", currentOrgId);
}

async function createSchedule() {
  const frequency = document.getElementById("new-sch-frequency").value;
  const recipient_email = document.getElementById("new-sch-recipient").value;
  const errEl = document.getElementById("new-sch-error");
  const btn = document.getElementById("create-sch-btn");

  if (!recipient_email) {
    errEl.innerHTML = `<div class="alert alert-danger">Pick a recipient.</div>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    await api("create_export_schedule", {
      org_id: currentOrgId,
      frequency,
      recipient_email,
    });
    document.querySelector(".modal-backdrop")?.remove();
    toast("Schedule created", "success");
    refreshSchedules(currentOrgId);
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = "Create Schedule";
  }
}

async function toggleSchedule(scheduleId, isActive) {
  try {
    await api("update_export_schedule", { schedule_id: scheduleId, is_active: isActive });
    toast(isActive ? "Schedule resumed" : "Schedule paused", "success");
    refreshSchedules(currentOrgId);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteSchedule(scheduleId) {
  if (!confirm("Delete this scheduled export? This cannot be undone.")) return;
  try {
    await api("delete_export_schedule", { schedule_id: scheduleId });
    toast("Schedule deleted", "success");
    refreshSchedules(currentOrgId);
  } catch (e) {
    toast(e.message, "error");
  }
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
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
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

// ── Payments Tab ─────────────────────────────────────────────────────────────

let paypalSDKLoaded = false;

function loadPayPalSDK() {
  return new Promise((resolve, reject) => {
    if (paypalSDKLoaded) { resolve(); return; }
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${CONFIG.paypalClientId}&currency=USD&intent=capture`;
    script.onload = () => { paypalSDKLoaded = true; resolve(); };
    script.onerror = () => reject(new Error("Failed to load PayPal SDK"));
    document.head.appendChild(script);
  });
}

// Preset definitions — all roles see all presets, only owner can pay directly via PayPal.
const PAYMENT_PRESETS = [
  { key: "setup",   title: "Setup Fee", price: 199,  description: "Setup Fee",            category: "setup",   hint: "One-time setup" },
  { key: "monthly", title: "Monthly",   price: 299,  description: "Monthly Plan",         category: "monthly", hint: "Per billing cycle" },
  { key: "yearly",  title: "Yearly",    price: 3588, description: "Yearly Plan",          category: "yearly",  hint: "14 months of service (2 months free)" },
  { key: "addon",   title: "Addon",     price: 59,   description: "Message credit addon", category: "addon",   hint: "+1,000 message credits" },
];

function renderPaymentsTab(el, org) {
  const presets = PAYMENT_PRESETS;

  const presetsHtml = presets.map(p => `
    <div class="payment-option">
      <div class="payment-option-title">${escHtml(p.title)}</div>
      <div class="payment-option-price">$${p.price.toLocaleString()}</div>
      <div class="payment-option-desc">${escHtml(p.hint)}</div>
      <div class="payment-option-actions">
        ${isOwner ? `<button class="btn btn-primary btn-sm" onclick="selectPayment(${p.price}, '${escAttr(p.description)}', '${p.category}')">Pay with PayPal</button>` : ""}
        <button class="btn btn-secondary btn-sm" onclick="sendPaymentLink(${p.price}, '${escAttr(p.description)}', '${p.category}')">Send link</button>
        <button class="btn btn-secondary btn-sm" onclick="sendToDashboard(${p.price}, '${escAttr(p.description)}', '${p.category}')">Send to dashboard</button>
      </div>
    </div>
  `).join("");

  el.innerHTML = `
    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Payment Options</div></div>
      <div class="card-body">
        <div class="payment-options-grid">${presetsHtml}</div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><div class="card-title">Custom Amount</div></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label>Amount (USD)</label>
            <input type="number" id="pay-custom-amount" min="1" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label>Reason</label>
            <input type="text" id="pay-custom-reason" placeholder="e.g. Custom package, add-on..." />
          </div>
        </div>
        <div class="flex-row">
          ${isOwner ? `<button class="btn btn-primary" onclick="selectCustomPayment('pay')">Pay with PayPal</button>` : ""}
          <button class="btn btn-secondary" onclick="selectCustomPayment('link')">Send link instead</button>
          <button class="btn btn-secondary" onclick="selectCustomPayment('dashboard')">Send to dashboard</button>
        </div>
      </div>
    </div>

    <div id="paypal-container" style="display:none">
      <div class="card mb-4">
        <div class="card-header"><div class="card-title">Complete Payment</div></div>
        <div class="card-body">
          <div id="paypal-summary" style="margin-bottom:16px"></div>
          <div id="paypal-buttons"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Payment History</div></div>
      <div class="card-body">
        <div id="payment-history-body"><div class="loading-overlay" style="position:relative"><div class="spinner"></div> Loading...</div></div>
      </div>
    </div>`;

  loadPaymentHistory();
}

function escAttr(s) {
  return String(s).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function selectPayment(amount, description, category) {
  renderPayPalButtons(amount, description, category);
}

function selectCustomPayment(mode) {
  const amount = parseFloat(document.getElementById("pay-custom-amount").value);
  const reason = document.getElementById("pay-custom-reason").value.trim();

  if (!amount || amount <= 0) { toast("Enter a valid amount", "error"); return; }
  if (!reason) { toast("Enter a reason for the payment", "error"); return; }

  if (mode === "link") {
    sendPaymentLink(amount, reason, "custom");
  } else if (mode === "dashboard") {
    sendToDashboard(amount, reason, "custom");
  } else {
    renderPayPalButtons(amount, reason, "custom");
  }
}

async function sendToDashboard(amount, description, category) {
  try {
    await api("create_dashboard_invoice", {
      org_id: currentOrgId,
      amount,
      description,
      category,
    });
    toast("Invoice sent to customer dashboard", "success");
    loadPaymentHistory();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function renderPayPalButtons(amount, description, category) {
  const container = document.getElementById("paypal-container");
  const buttonsEl = document.getElementById("paypal-buttons");
  const summaryEl = document.getElementById("paypal-summary");
  const orgName = currentOrgName;
  const orgId = currentOrgId;

  container.style.display = "";
  buttonsEl.innerHTML = '<div class="loading-overlay" style="position:relative"><div class="spinner"></div> Loading PayPal...</div>';
  summaryEl.innerHTML = `
    <div style="font-size:14px;margin-bottom:8px">
      <strong>${escHtml(orgName)}</strong> — ${escHtml(description)}
    </div>
    <div style="font-size:24px;font-weight:700;color:var(--primary)">
      $${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </div>`;

  container.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    await loadPayPalSDK();
    buttonsEl.innerHTML = "";

    paypal.Buttons({
      style: { layout: "vertical", color: "gold", shape: "rect", label: "pay" },
      createOrder: async function() {
        const r = await api("paypal_create_order", {
          org_id: orgId, amount, description, category,
        });
        return r.id;
      },
      onApprove: async function(data) {
        try {
          const r = await api("paypal_capture_order", {
            org_id: orgId,
            order_id: data.orderID,
            category,
            amount,
            description,
          });
          container.innerHTML = `
            <div class="card mb-4">
              <div class="card-body" style="text-align:center;padding:40px">
                <div style="font-size:48px;margin-bottom:16px;color:var(--success)">&#10003;</div>
                <div style="font-size:20px;font-weight:600;margin-bottom:8px">Payment Successful</div>
                <div class="text-muted" style="margin-bottom:16px">
                  $${amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} received for ${escHtml(orgName)}
                </div>
                <div class="text-sm text-muted" style="margin-bottom:4px">Transaction: ${escHtml(r.capture_id || data.orderID)}</div>
                <div class="text-sm text-muted">Payer: ${escHtml(r.payer_email || "N/A")}</div>
                <button class="btn btn-secondary" style="margin-top:24px" onclick="switchTab('payments')">Collect Another Payment</button>
              </div>
            </div>`;
          toast("Payment completed successfully", "success");
          loadPaymentHistory();
        } catch (e) {
          toast("Capture failed: " + e.message, "error");
        }
      },
      onCancel: function() {
        toast("Payment cancelled", "default");
      },
      onError: function(err) {
        console.error("PayPal error:", err);
        toast("Payment failed — check console for details", "error");
      },
    }).render("#paypal-buttons");
  } catch (e) {
    buttonsEl.innerHTML = `<div class="alert alert-danger">Failed to load PayPal: ${escHtml(e.message)}</div>`;
  }
}

// Holds the pending link state while the modal is open — avoids quoting/escaping
// the URL through DOM attributes.
let _pendingPaymentLink = null;

async function sendPaymentLink(amount, description, category) {
  const orgId = currentOrgId;
  const orgName = currentOrgName;

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Send payment link</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove();_pendingPaymentLink=null;">✕</button>
      </div>
      <div class="modal-body">
        <div style="font-size:14px;margin-bottom:4px">
          <strong>${escHtml(orgName)}</strong> — ${escHtml(description)}
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--primary);margin-bottom:16px">
          $${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div id="link-modal-body">
          <div class="loading-overlay" style="position:relative"><div class="spinner"></div> Generating PayPal link...</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const bodyEl = modal.querySelector("#link-modal-body");

  try {
    const { approve_url } = await api("paypal_create_link", {
      org_id: orgId, amount, description, category,
    });

    _pendingPaymentLink = { approve_url, amount, description };

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.id = "link-modal-url";
    urlInput.readOnly = true;
    urlInput.value = approve_url;

    bodyEl.innerHTML = `
      <div class="form-group">
        <label>Plaintext link (copy and send however you like)</label>
      </div>
      <div class="flex-row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
        <button class="btn btn-secondary" onclick="copyPaymentLink()">Copy link</button>
        <button class="btn btn-primary" id="link-modal-email" onclick="emailPaymentLink()">Email this link</button>
      </div>
      <div id="link-modal-result" style="margin-top:12px"></div>`;

    // Insert the URL input into the form-group so we don't need to escape it in HTML.
    bodyEl.querySelector(".form-group").appendChild(urlInput);

    loadPaymentHistory();
  } catch (e) {
    bodyEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
  }
}

function copyPaymentLink() {
  const input = document.getElementById("link-modal-url");
  if (!input) return;
  input.select();
  navigator.clipboard.writeText(input.value).then(
    () => toast("Link copied to clipboard", "success"),
    () => toast("Copy failed — select and copy manually", "error")
  );
}

async function emailPaymentLink() {
  if (!_pendingPaymentLink) return;
  const { approve_url, amount, description } = _pendingPaymentLink;
  const btn = document.getElementById("link-modal-email");
  const resultEl = document.getElementById("link-modal-result");
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Sending...'; }

  try {
    const { sent_to } = await api("send_payment_link", {
      org_id: currentOrgId,
      approve_url,
      amount,
      description,
    });
    if (sent_to && sent_to.length > 0) {
      resultEl.innerHTML = `<div class="alert alert-success">Sent to: ${sent_to.map(escHtml).join(", ")}</div>`;
      toast("Payment link emailed", "success");
    } else {
      resultEl.innerHTML = `<div class="alert alert-danger">No email account connected for this organization.</div>`;
    }
  } catch (e) {
    resultEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "Email this link"; }
  }
}

async function loadPaymentHistory() {
  const bodyEl = document.getElementById("payment-history-body");
  if (!bodyEl) return;

  try {
    const { payments } = await api("list_payments", { org_id: currentOrgId });
    if (!payments || payments.length === 0) {
      bodyEl.innerHTML = `<div class="text-muted" style="padding:16px;text-align:center">No payments yet.</div>`;
      return;
    }

    window._paymentHistoryCache = payments;

    const rows = payments.map(p => {
      const dt = new Date(p.created_at).toLocaleString();
      const amount = `$${Number(p.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const statusClass = p.status === "completed" ? "green"
        : p.status === "pending_link" ? "yellow"
        : p.status === "failed" ? "red" : "gray";
      const actions = isOwner ? `
        <td class="text-right" style="white-space:nowrap">
          <button class="btn btn-secondary btn-sm" onclick="editPaymentEntry('${p.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deletePaymentEntry('${p.id}')">Delete</button>
        </td>` : "";
      return `
        <tr>
          <td>${escHtml(dt)}</td>
          <td>${escHtml(p.description)}${p.credits_added ? ` <span class="text-muted">(+${p.credits_added.toLocaleString()} credits)</span>` : ""}</td>
          <td>${escHtml(p.category)}</td>
          <td>${amount}</td>
          <td><span class="badge badge-${statusClass}">${escHtml(p.status)}</span></td>
          <td>${escHtml(p.payer_email || "—")}</td>
          <td>${escHtml(p.created_by_name || "—")}</td>
          ${actions}
        </tr>`;
    }).join("");

    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Description</th><th>Category</th>
              <th>Amount</th><th>Status</th><th>Payer</th><th>By</th>
              ${isOwner ? "<th></th>" : ""}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    bodyEl.innerHTML = `<div class="alert alert-danger">Failed to load payments: ${escHtml(e.message)}</div>`;
  }
}

async function deletePaymentEntry(paymentId) {
  if (!isOwner) return;
  const cache = window._paymentHistoryCache || [];
  const p = cache.find(x => x.id === paymentId);
  const label = p ? `${p.description} — $${Number(p.amount).toFixed(2)}` : "this payment";
  if (!confirm(`Delete ${label}?\n\nThis only removes the history row. It does NOT refund PayPal, revert credits, or shorten the subscription.`)) return;
  try {
    await api("delete_payment", { org_id: currentOrgId, payment_id: paymentId });
    toast("Payment entry deleted", "success");
    loadPaymentHistory();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "error");
  }
}

async function editPaymentEntry(paymentId) {
  if (!isOwner) return;
  const cache = window._paymentHistoryCache || [];
  const p = cache.find(x => x.id === paymentId);
  if (!p) return;

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Edit Payment Entry</div>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Amount (USD)</label>
            <input id="ep-amount" type="number" step="0.01" value="${Number(p.amount)}">
          </div>
          <div class="form-group">
            <label>Category</label>
            <select id="ep-category">
              ${["setup","monthly","yearly","addon","custom","link_sent"].map(c =>
                `<option value="${c}" ${c===p.category?"selected":""}>${c}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Description</label>
            <input id="ep-description" type="text" value="${escAttr(p.description || "")}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Status</label>
            <select id="ep-status">
              ${["completed","pending_link","failed","refunded"].map(s =>
                `<option value="${s}" ${s===p.status?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>Payer email</label>
            <input id="ep-payer" type="text" value="${escAttr(p.payer_email || "")}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Credits added</label>
            <input id="ep-credits" type="number" value="${p.credits_added ?? ""}">
            <div class="form-hint text-muted" style="font-size:12px;margin-top:4px">Informational only. Editing this does NOT change the org's credit buckets.</div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button id="ep-save" class="btn btn-primary">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector("#ep-save").onclick = async () => {
    const creditsRaw = modal.querySelector("#ep-credits").value.trim();
    const payload = {
      org_id: currentOrgId,
      payment_id: paymentId,
      amount: Number(modal.querySelector("#ep-amount").value),
      description: modal.querySelector("#ep-description").value.trim(),
      category: modal.querySelector("#ep-category").value,
      status: modal.querySelector("#ep-status").value,
      payer_email: modal.querySelector("#ep-payer").value.trim() || null,
      credits_added: creditsRaw === "" ? null : Number(creditsRaw),
    };
    const btn = modal.querySelector("#ep-save");
    btn.disabled = true; btn.textContent = "Saving...";
    try {
      await api("update_payment", payload);
      toast("Payment entry updated", "success");
      modal.remove();
      loadPaymentHistory();
    } catch (e) {
      toast(`Update failed: ${e.message}`, "error");
      btn.disabled = false; btn.textContent = "Save changes";
    }
  };
}

// ── Sales Report ──────────────────────────────────────────────────────────────

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
            ${repOrgs.map(org => { _nameCache[org.id] = org.name; return `
              <tr>
                <td>
                  <a onclick="navigate('org-detail','${org.id}')"
                    class="org-link">${escHtml(org.name)}</a>
                </td>
                <td><span class="badge badge-gray">${org.subscription_tier}</span></td>
                <td>${new Date(org.created_at).toLocaleDateString()}</td>
                <td>${org.messages_used_this_month.toLocaleString()}</td>
              </tr>`; }).join("")}
          </tbody>
        </table>
      </div>`).join("");

    main.querySelector(".card").innerHTML = sections.length
      ? `<div class="card-body">${sections}</div>`
      : `<div class="empty-state"><p>No organizations with sales attribution yet.</p></div>`;
  } catch (e) {
    main.querySelector(".card").innerHTML =
      `<div class="card-body"><div class="alert alert-danger">${escHtml(e.message)}</div></div>`;
  }
}

// ── Helper, copy snippet button ─────────────────────────────────────────────────────────────────

function copySnippet() {
  navigator.clipboard.writeText(window._currentSnippet);
  toast('Copied', 'success');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Filter <tr> rows in a tbody by matching a query against their data-search attribute.
// Rows whose data-search contains every whitespace-separated term are shown.
function filterTableRows(inputId, tbodyId, emptyMsgId) {
  const input = document.getElementById(inputId);
  const tbody = document.getElementById(tbodyId);
  if (!input || !tbody) return;
  const query = input.value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const row of tbody.querySelectorAll("tr")) {
    const hay = row.dataset.search || "";
    const match = terms.every(t => hay.includes(t));
    row.style.display = match ? "" : "none";
    if (match) visible++;
  }
  if (emptyMsgId) {
    const msg = document.getElementById(emptyMsgId);
    if (msg) msg.style.display = visible === 0 && query.length > 0 ? "" : "none";
  }
}

// ── Team Management (owner only) ─────────────────────────────────────────────

async function renderTeamPage(main) {
  main.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Team</h1>
      <button class="btn btn-primary" onclick="showAddTeamMemberModal()">
        ${ICONS.plus} Add Member
      </button>
    </div>
    <div class="card">
      <div class="card-body" id="team-list-container">
        <div class="loading-overlay"><div class="spinner"></div> Loading...</div>
      </div>
    </div>`;
  await loadTeamList();
}

async function loadTeamList() {
  const container = document.getElementById("team-list-container");
  try {
    const { team } = await api("list_team");
    window._teamCache = {};
    for (const m of team || []) window._teamCache[m.id] = m;
    if (!team || team.length === 0) {
      container.innerHTML = `<p class="text-muted" style="padding:24px;text-align:center">No team members yet.</p>`;
      return;
    }
    container.innerHTML = `
      <table style="width:100%">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${team.map(m => {
            const isSelf = m.id === dashUser.id;
            const statusBadge = m.is_active
              ? `<span class="badge badge-green">Active</span>`
              : `<span class="badge badge-gray">Inactive</span>`;
            const roleBadge = m.role === "owner"
              ? `<span class="badge badge-cyan">Admin</span>`
              : m.role === "teamleader"
              ? `<span class="badge badge-blue">Team Leader</span>`
              : `<span class="badge">Salesperson</span>`;
            return `<tr>
              <td><strong>${escHtml(m.display_name)}</strong>${isSelf ? ' <span style="color:var(--text-muted);font-size:11px">(you)</span>' : ""}</td>
              <td style="color:var(--text-muted)">${escHtml(m.email)}</td>
              <td>${roleBadge}</td>
              <td>${statusBadge}</td>
              <td style="text-align:right">
                <button class="btn btn-ghost btn-sm" onclick="showEditTeamMemberModal('${m.id}')">Edit</button>
                ${!isSelf ? `<button class="btn btn-ghost btn-sm" style="color:${m.is_active ? "var(--danger)" : "var(--success)"}" onclick="toggleTeamMember('${m.id}', ${!m.is_active})">${m.is_active ? "Deactivate" : "Reactivate"}</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteTeamMember('${m.id}')">Delete</button>` : ""}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  } catch (e) {
    container.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
  }
}

function showAddTeamMemberModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Add Team Member</h3>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">&times;</button>
      </div>
      <div class="modal-body">
        <div id="add-member-error"></div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" id="new-member-email" value="@horusdesk.com" />
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="new-member-name" placeholder="First Last" />
        </div>
        <div class="form-group">
          <label>Role</label>
          <select id="new-member-role">
            <option value="salesperson" selected>Salesperson</option>
            <option value="teamleader">Team Leader</option>
            <option value="owner">Admin</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="add-member-submit" onclick="submitAddTeamMember()">Add Member</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const emailInput = document.getElementById("new-member-email");
  emailInput.setSelectionRange(0, 0);
  emailInput.focus();
}

async function submitAddTeamMember() {
  const email = document.getElementById("new-member-email").value.trim();
  const displayName = document.getElementById("new-member-name").value.trim();
  const role = document.getElementById("new-member-role").value;
  const errEl = document.getElementById("add-member-error");
  const btn = document.getElementById("add-member-submit");

  errEl.innerHTML = "";
  if (!email || !displayName) {
    errEl.innerHTML = `<div class="alert alert-danger">Email and display name are required.</div>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = "Adding...";
  try {
    await api("add_team_member", { email, display_name: displayName, role });
    document.querySelector(".modal-backdrop")?.remove();
    toast("Team member added", "success");
    await loadTeamList();
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = "Add Member";
  }
}

function showEditTeamMemberModal(memberId) {
  const member = window._teamCache?.[memberId];
  if (!member) return;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>Edit Team Member</h3>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-backdrop').remove()">&times;</button>
      </div>
      <div class="modal-body">
        <div id="edit-member-error"></div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" id="edit-member-name" value="${escHtml(member.display_name)}" />
        </div>
        <div class="form-group">
          <label>Role</label>
          <select id="edit-member-role">
            <option value="salesperson" ${member.role === "salesperson" ? "selected" : ""}>Salesperson</option>
            <option value="teamleader" ${member.role === "teamleader" ? "selected" : ""}>Team Leader</option>
            <option value="owner" ${member.role === "owner" ? "selected" : ""}>Admin</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
        <button class="btn btn-primary" id="edit-member-submit" onclick="submitEditTeamMember('${member.id}')">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function submitEditTeamMember(userId) {
  const displayName = document.getElementById("edit-member-name").value.trim();
  const role = document.getElementById("edit-member-role").value;
  const errEl = document.getElementById("edit-member-error");
  const btn = document.getElementById("edit-member-submit");

  errEl.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    await api("update_team_member", { user_id: userId, updates: { display_name: displayName, role } });
    document.querySelector(".modal-backdrop")?.remove();
    toast("Team member updated", "success");
    if (userId === dashUser.id) {
      dashUser.display_name = displayName;
      dashUser.role = role;
      isOwner = role === "owner";
      updateSidebarUser(displayName, role);
    }
    await loadTeamList();
  } catch (e) {
    errEl.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function toggleTeamMember(userId, activate) {
  const action = activate ? "reactivate" : "deactivate";
  if (!confirm(`Are you sure you want to ${action} this team member?`)) return;
  try {
    await api("update_team_member", { user_id: userId, updates: { is_active: activate } });
    toast(`Team member ${action}d`, "success");
    await loadTeamList();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteTeamMember(userId) {
  const name = window._teamCache?.[userId]?.display_name || "this member";
  if (!confirm(`Permanently delete ${name}? This removes their account entirely and cannot be undone.`)) return;
  try {
    await api("delete_team_member", { user_id: userId });
    toast("Team member deleted", "success");
    await loadTeamList();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function closeMobileSidebar() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebar-backdrop").classList.remove("show");
}

function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");

  // Collapse to icon rail (desktop), persisted
  if (localStorage.getItem("sidebarCollapsed") === "1") sidebar.classList.add("collapsed");
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    sidebar.classList.add("collapsed");
    localStorage.setItem("sidebarCollapsed", "1");
  });
  document.getElementById("sidebar-expand").addEventListener("click", () => {
    sidebar.classList.remove("collapsed");
    localStorage.setItem("sidebarCollapsed", "0");
  });

  // Collapsible sections, persisted
  document.querySelectorAll(".nav-section-header").forEach(header => {
    const key = header.dataset.section;
    const section = header.parentElement;
    const saved = JSON.parse(localStorage.getItem("sidebarCollapsedSections") || "[]");
    if (saved.includes(key)) section.classList.add("section-collapsed");
    header.addEventListener("click", () => {
      section.classList.toggle("section-collapsed");
      const keys = JSON.parse(localStorage.getItem("sidebarCollapsedSections") || "[]");
      const next = section.classList.contains("section-collapsed")
        ? [...new Set([...keys, key])]
        : keys.filter(k => k !== key);
      localStorage.setItem("sidebarCollapsedSections", JSON.stringify(next));
    });
  });

  // Tooltips on the collapsed icon rail
  let tooltip = null;
  document.querySelectorAll(".nav-item[data-label]").forEach(item => {
    item.addEventListener("mouseenter", () => {
      if (!sidebar.classList.contains("collapsed")) return;
      const rect = item.getBoundingClientRect();
      tooltip = document.createElement("div");
      tooltip.className = "sidebar-tooltip";
      tooltip.textContent = item.dataset.label;
      tooltip.style.left = `${rect.right + 10}px`;
      tooltip.style.top = `${rect.top + rect.height / 2}px`;
      document.body.appendChild(tooltip);
    });
    item.addEventListener("mouseleave", () => { tooltip?.remove(); tooltip = null; });
  });

  // User menu popover
  const userMenu = document.getElementById("user-menu");
  document.getElementById("user-card").addEventListener("click", (e) => {
    e.stopPropagation();
    userMenu.style.display = userMenu.style.display === "none" ? "" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".sidebar-user")) userMenu.style.display = "none";
  });

  // Mobile drawer
  document.getElementById("sidebar-fab").addEventListener("click", () => {
    sidebar.classList.add("mobile-open");
    backdrop.classList.add("show");
  });
  backdrop.addEventListener("click", closeMobileSidebar);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const vf = document.querySelector(".version-footer");
  if (vf && CONFIG.appVersion) vf.textContent = "V" + CONFIG.appVersion;
  _supabase = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.anonKey);
  initSidebar();

  _supabase.auth.onAuthStateChange((event, session) => {
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && !currentUser) {
      onLogin(session.user);
    } else if (event === "SIGNED_OUT" || (event === "INITIAL_SESSION" && !session)) {
      onLogout();
      document.getElementById("login-screen").style.display = "";
    }
  });
});
