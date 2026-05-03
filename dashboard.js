// ============================================
// HORUS DESK DASHBOARD — LOGIC v2
// Auth via Supabase, all DB ops via dashboard-api
// ============================================

// ── Supabase client (anon key only) ──────────────────────────────────────────
let _supabase;
let currentUser = null;   // Supabase Auth user
let dashUser = null;      // Dashboard user record (includes role)
let isOwner = false;
let isTeamleader = false;

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
    isTeamleader = du.role === "teamleader";

    // Show app, hide login
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app-screen").style.display = "";

    // Update UI for role
    document.getElementById("user-display").innerHTML =
      `<strong>${escHtml(du.display_name)}</strong><br>${du.role === "teamleader" ? "team leader" : du.role}`;

    document.getElementById("sales-nav-item").style.display = "";
    if (isOwner) {
      document.getElementById("team-nav-item").style.display = "";
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
  isTeamleader = false;
  document.getElementById("login-screen").style.display = "";
  document.getElementById("app-screen").style.display = "none";
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
  else if (currentView === "team") await renderTeamPage(main);
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
      return `
        <tr data-search="${escHtml(searchKey)}">
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
    const { org, providers, widget, kbDocs, lastPayment, integrations } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations };

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
        <button class="tab" onclick="switchTab('email')">Email Setup</button>
        <button class="tab" onclick="switchTab('widget')">Widget</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('integrations')">Integrations</button>
        <button class="tab" onclick="switchTab('payments')">Payments</button>
        <button class="tab" onclick="switchTab('reports')">Reports</button>
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
      const searchKey = `${demo.name} ${demo.slug}`.toLowerCase();
      return `
        <tr data-search="${escHtml(searchKey)}">
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
    const { org, providers, widget, kbDocs, lastPayment, integrations } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations };

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
        <button class="tab" onclick="switchTab('widget')">Widget</button>
        <button class="tab" onclick="switchTab('kb')">Knowledge Base</button>
        <button class="tab" onclick="switchTab('notifications')">Notifications</button>
        <button class="tab" onclick="switchTab('reports')">Reports</button>
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
    const { org, providers, widget, kbDocs, lastPayment, integrations } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations };
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
  if (!confirm("Are you sure? All conversations, KB documents, widget config, and notification recipients for this demo will be removed.")) return;
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
    `  • All KB documents and chunks\n` +
    `  • Connected email provider and tokens\n` +
    `  • Widget config and notification recipients\n` +
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
    const { org, providers, widget, kbDocs, lastPayment, integrations } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations };
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
  const { org, providers, widget, kbDocs, lastPayment, integrations } = window._orgData;

  try {
    if (currentTab === "overview") renderOverviewTab(el, org, providers, widget, lastPayment);
    else if (currentTab === "email") renderEmailTab(el, org, providers);
    else if (currentTab === "widget") renderWidgetTab(el, widget, org);
    else if (currentTab === "kb") renderKbTab(el, kbDocs, org);
    else if (currentTab === "integrations") renderIntegrationsTab(el, org, integrations);
    else if (currentTab === "notifications") renderNotificationsTab(el, org);
    else if (currentTab === "payments") renderPaymentsTab(el, org);
    else if (currentTab === "reports") renderReportsTab(el, org);
    else if (currentTab === "settings") renderSettingsTab(el, org);
  } catch (e) {
    console.error("renderTab error:", e);
    el.innerHTML = `<div class="alert alert-danger">Error rendering tab: ${e.message}</div>`;
  }
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function renderOverviewTab(el, org, providers, widget, lastPayment) {
  const pct = org.message_limit_per_month > 0
    ? Math.round((org.messages_used_this_month / org.message_limit_per_month) * 100) : 0;
  const fillClass = pct >= 100 ? "danger" : pct >= 80 ? "warning" : "";
  const provider = providers[0];
  const cycleDay = org.subscription_end_date
    ? new Date(org.subscription_end_date).getUTCDate()
    : (org.billing_day_of_month || 1);
  const now = new Date();
  const resetDateObj = now.getDate() < cycleDay
    ? new Date(now.getFullYear(), now.getMonth(), cycleDay)
    : new Date(now.getFullYear(), now.getMonth() + 1, cycleDay);
  const resetDate = resetDateObj.toLocaleDateString("en-US", { month: "long", day: "numeric" });

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
      ${!currentIsDemo ? `<div class="stat-card">
        <div class="stat-label">Email</div>
        <div class="stat-value stat-value-sm" style="word-break:break-all;line-height:1.4">${provider ? (() => { const at = provider.provider_account_email.indexOf("@"); return at === -1 ? escHtml(provider.provider_account_email) : `${escHtml(provider.provider_account_email.slice(0, at))}<br><span style="font-size:12px;opacity:0.8">${escHtml(provider.provider_account_email.slice(at))}</span>`; })() : "—"}</div>
        <div class="stat-sub">${provider ? `<span class="badge ${provider.status === "active" ? "badge-green" : "badge-red"}">${provider.status}</span>` : "Not connected"}</div>
      </div>` : ""}
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
        ${!currentIsDemo ? `<div class="toggle-row">
          <div>
            <div class="toggle-label">Email AI Responses</div>
            <div class="toggle-desc">Process inbound emails with AI (disable to save messages without AI)</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="ov-email-ai-toggle" ${org.ai_responses_enabled ? "checked" : ""}
              onchange="toggleEmailAi(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>` : ""}
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

// ── Notifications Tab (demos only) ───────────────────────────────────────────

function renderNotificationsTab(el, org) {
  el.innerHTML = `
    <div class="card mb-4">
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
        ${isOwner
          ? "Manage the people who should receive escalations and alerts for this demo."
          : "Add the people who should receive escalations and alerts for this demo."}
      </div>
    </div>`;

  loadRecipients();
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
	<script src="https://horusdesk.com/widget.js" async><\/script>`;

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
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig('${widget.id}')">
          Save Widget Settings
        </button>
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

    ${!(currentIsDemo && !isOwner) ? `<div class="card mb-4">
      <div class="card-header"><div class="card-title">Domain Whitelist</div></div>
      <div class="card-body">
        <div class="form-group">
          <label>Allowed Domains <span class="hint">(comma-separated, empty = allow all)</span></label>
          <input type="text" id="w-domains" value="${escHtml(domains)}" placeholder="example.com, www.example.com" />
        </div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig('${widget.id}')">
          Save Widget Settings
        </button>
      </div>
    </div>` : ""}

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
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveWidgetConfig('${widget.id}')">
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

    const { org, providers, widget, kbDocs, lastPayment, integrations } = await api("get_org", { org_id: currentOrgId });
    window._orgData = { org, providers, widget, kbDocs, lastPayment, integrations };
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

// ── Integrations Tab ─────────────────────────────────────────────────────────

function renderIntegrationsTab(el, org, integrations) {
  const allIntegrations = integrations || [];
  const calendly = allIntegrations.find(i => i.integration_type === "calendly" && i.status === "active");

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
            The AI receptionist can check real-time availability and create one-time booking links for customers.
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
      <div class="card-header"><div class="card-title">Coming Soon</div></div>
      <div class="card-body text-muted">
        More integrations (Google Calendar, Acuity Scheduling) will appear here in future updates.
      </div>
    </div>`;
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

// ── Settings Tab ──────────────────────────────────────────────────────────────

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
    auto_send_enabled: document.getElementById("s-autosend").checked,
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
            <div class="form-hint">Defaults to the connected inbox. Add notification recipients in the Settings tab.</div>
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

async function loadExportRecipients(orgId) {
  try {
    const { default_email, notification_recipients } = await api(
      "list_export_recipients",
      { org_id: orgId }
    );
    const select = document.getElementById("r-recipient");
    if (!select) return;

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
    select.innerHTML = options.join("");
  } catch (e) {
    const select = document.getElementById("r-recipient");
    if (select) {
      select.innerHTML = `<option value="" disabled>Error: ${escHtml(e.message)}</option>`;
    }
  }
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
  api("list_export_recipients", { org_id: currentOrgId })
    .then(({ default_email, notification_recipients }) => {
      const select = document.getElementById("new-sch-recipient");
      if (!select) return;
      const options = [];
      if (default_email) {
        options.push(`<option value="${escHtml(default_email)}">${escHtml(default_email)} (connected inbox)</option>`);
      }
      for (const r of notification_recipients) {
        const label = r.name ? `${r.name} <${r.email}>` : r.email;
        options.push(`<option value="${escHtml(r.email)}">${escHtml(label)}</option>`);
      }
      if (options.length === 0) {
        options.push(`<option value="" disabled>No recipients configured</option>`);
      }
      select.innerHTML = options.join("");
    })
    .catch((e) => {
      const select = document.getElementById("new-sch-recipient");
      if (select) select.innerHTML = `<option value="" disabled>Error: ${escHtml(e.message)}</option>`;
    });
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
    buttonsEl.innerHTML = `<div class="alert alert-danger">Failed to load PayPal: ${e.message}</div>`;
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
      resultEl.innerHTML = `<div class="alert alert-danger">No system-alert recipients configured and no email provider connected.</div>`;
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
  "escalation:frustrated": "Frustrated",
  "escalation:lead": "Leads",
  "escalation:kb_gap": "KB Gap",
  usage_limit: "Usage Limit Alerts",
  system: "System Alerts",
};

const ESCALATION_SUBTYPES = [
  { key: "escalation:frustrated", label: "Frustrated / Angry Customers" },
  { key: "escalation:lead",      label: "Sales Leads" },
  { key: "escalation:kb_gap",    label: "Knowledge Gaps" },
];

async function loadRecipients() {
  const el = document.getElementById("recipients-list");
  if (!el) return;

  try {
    const { recipients } = await api("list_recipients", { org_id: currentOrgId });

    if (recipients.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:24px"><p>No recipients added. Notifications go to the connected inbox.</p></div>`;
      return;
    }

    const showActions = isOwner;

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
          ${showActions ? `<div class="flex-row">
            <label class="toggle" title="${r.is_active ? "Active" : "Disabled"}">
              <input type="checkbox" ${r.is_active ? "checked" : ""}
                onchange="toggleRecipient('${r.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn btn-ghost btn-sm" onclick="showEditRecipientModal('${r.id}','${escHtml(r.email)}','${escHtml(r.name || "")}','${escHtml(JSON.stringify(r.notify_on))}')">Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteRecipient('${r.id}')">Remove</button>
          </div>` : `<div class="flex-row">
            <span class="badge ${r.is_active ? "badge-green" : "badge-gray"}">${r.is_active ? "Active" : "Disabled"}</span>
          </div>`}
        </div>`;
    }).join("");

    el.innerHTML = rows;
  } catch (e) {
    el.innerHTML = `<div class="card-body"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

function recipientModalHtml(title, id, email, name, notifyOn) {
  const effectiveNotify = notifyOn || ["escalation", "usage_limit", "system"];

  // Determine escalation parent/sub-type checked state
  const hasLegacyEscalation = effectiveNotify.includes("escalation");
  const hasAnySubType = ESCALATION_SUBTYPES.some(s => effectiveNotify.includes(s.key));
  const escalationChecked = hasLegacyEscalation || hasAnySubType;

  const subCheckboxes = ESCALATION_SUBTYPES.map(s => {
    const checked = hasLegacyEscalation || effectiveNotify.includes(s.key);
    return `
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;margin-bottom:6px;margin-left:28px;color:var(--text)">
        <input type="checkbox" id="rn-${s.key}" ${checked ? "checked" : ""}
          onchange="updateEscalationParent()">
        ${s.label}
      </label>`;
  }).join("");

  const checkboxes = `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;margin-bottom:8px;color:var(--text)">
      <input type="checkbox" id="rn-escalation" ${escalationChecked ? "checked" : ""}
        onchange="toggleEscalationSubTypes(this.checked)">
      ${EVENT_TYPE_LABELS["escalation"]}
    </label>
    <div id="escalation-subtypes" style="display:${escalationChecked ? "block" : "none"};margin-bottom:8px">
      ${subCheckboxes}
    </div>
  ` + ["usage_limit", "system"].map(t => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;cursor:pointer;margin-bottom:8px;color:var(--text)">
      <input type="checkbox" id="rn-${t}" ${effectiveNotify.includes(t) ? "checked" : ""}>
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

function toggleEscalationSubTypes(checked) {
  const container = document.getElementById("escalation-subtypes");
  if (container) container.style.display = checked ? "block" : "none";
  ["escalation:frustrated", "escalation:lead", "escalation:kb_gap"].forEach(key => {
    const el = document.getElementById(`rn-${key}`);
    if (el) el.checked = checked;
  });
}

function updateEscalationParent() {
  const anyChecked = ["escalation:frustrated", "escalation:lead", "escalation:kb_gap"]
    .some(key => document.getElementById(`rn-${key}`)?.checked);
  const parent = document.getElementById("rn-escalation");
  if (parent) parent.checked = anyChecked;
  const container = document.getElementById("escalation-subtypes");
  if (container) container.style.display = anyChecked ? "block" : "none";
}

function showAddRecipientModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = recipientModalHtml("Add Notification Recipient", null, "", "", null);
  document.body.appendChild(modal);
}

function showEditRecipientModal(id, email, name, notifyOn) {
  notifyOn = typeof notifyOn === "string" ? JSON.parse(notifyOn) : notifyOn;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = recipientModalHtml("Edit Recipient", id, email, name, notifyOn);
  document.body.appendChild(modal);
}

function getRecipientFormValues() {
  const email = document.getElementById("r-email").value.trim();
  const name = document.getElementById("r-name").value.trim();

  const notifyOn = [];

  // Collect escalation sub-types if parent is checked
  if (document.getElementById("rn-escalation")?.checked) {
    const subTypes = ["escalation:frustrated", "escalation:lead", "escalation:kb_gap"]
      .filter(key => document.getElementById(`rn-${key}`)?.checked);
    // All 3 checked → store "escalation" (compact, auto-includes future sub-types)
    if (subTypes.length === 3) {
      notifyOn.push("escalation");
    } else {
      notifyOn.push(...subTypes);
    }
  }

  ["usage_limit", "system"].forEach(t => {
    if (document.getElementById(`rn-${t}`)?.checked) notifyOn.push(t);
  });

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
              ? `<span style="color:var(--success);font-weight:600">Active</span>`
              : `<span style="color:var(--danger);font-weight:600">Inactive</span>`;
            const roleBadge = m.role === "owner"
              ? `<span style="background:var(--gold);color:var(--bg);padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">Owner</span>`
              : m.role === "teamleader"
              ? `<span style="background:var(--primary);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">Team Leader</span>`
              : `<span style="background:var(--surface-hover);padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">Salesperson</span>`;
            return `<tr>
              <td><strong>${escHtml(m.display_name)}</strong>${isSelf ? ' <span style="color:var(--text-muted);font-size:11px">(you)</span>' : ""}</td>
              <td style="color:var(--text-muted)">${escHtml(m.email)}</td>
              <td>${roleBadge}</td>
              <td>${statusBadge}</td>
              <td style="text-align:right">
                <button class="btn btn-ghost btn-sm" onclick='showEditTeamMemberModal(${JSON.stringify(m).replace(/'/g, "&#39;")})'>Edit</button>
                ${!isSelf ? `<button class="btn btn-ghost btn-sm" style="color:${m.is_active ? "var(--danger)" : "var(--success)"}" onclick='toggleTeamMember("${m.id}", ${!m.is_active})'>${m.is_active ? "Deactivate" : "Reactivate"}</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick='deleteTeamMember("${m.id}", "${escHtml(m.display_name)}")'>Delete</button>` : ""}
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
            <option value="owner">Owner</option>
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

function showEditTeamMemberModal(member) {
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
            <option value="owner" ${member.role === "owner" ? "selected" : ""}>Owner</option>
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
      isTeamleader = role === "teamleader";
      document.getElementById("user-display").innerHTML =
        `<strong>${escHtml(displayName)}</strong><br>${role === "teamleader" ? "team leader" : role}`;
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

async function deleteTeamMember(userId, name) {
  if (!confirm(`Permanently delete ${name}? This removes their account entirely and cannot be undone.`)) return;
  try {
    await api("delete_team_member", { user_id: userId });
    toast("Team member deleted", "success");
    await loadTeamList();
  } catch (e) {
    toast(e.message, "error");
  }
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
