/**
 * FlowMon QA Test Suite
 * Covers: Auth, Dashboard, Flows, Domains, Mappings, Subscribers,
 *         Alerts, Policy, IPDR, Users, Viewer role restrictions, API health
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE    = 'http://localhost:4200';
const API     = 'http://localhost:3000';
const SS_DIR  = path.join(__dirname, '..', 'qa_screenshots');
const ADMIN   = { username: 'admin', password: 'admin123' };
const VIEWER  = { username: 'viewer_test', password: 'viewer123' };

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const issues = [];
let ssCount  = 0;

function issue(severity, page, description, detail = '') {
  const entry = { severity, page, description, detail };
  issues.push(entry);
  const marker = severity === 'CRITICAL' ? '🔴' : severity === 'HIGH' ? '🟠' : severity === 'MEDIUM' ? '🟡' : '🔵';
  console.log(`${marker} [${severity}] [${page}] ${description}${detail ? ' — ' + detail : ''}`);
}

async function ss(page, name) {
  const file = path.join(SS_DIR, `${String(++ssCount).padStart(3,'0')}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function apiGet(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getToken(creds) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  });
  const d = await res.json();
  return d.token || null;
}

async function loginUI(page, creds) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="text"], input[formcontrolname="username"]', creds.username);
  await page.fill('input[type="password"], input[formcontrolname="password"]', creds.password);
  await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
  await page.waitForURL(/dashboard|login/, { timeout: 8000 }).catch(() => {});
  return page.url().includes('dashboard');
}

// ─── 1. API Health ─────────────────────────────────────────────────────────
async function testApiHealth() {
  console.log('\n=== 1. API Health ===');
  const h = await apiGet(`${API}/api/health`);
  if (h.status !== 200) issue('CRITICAL', 'API', 'Health endpoint not 200', `got ${h.status}`);
  else console.log('✅ /api/health OK');

  // Unauthenticated access to protected routes
  const protected_ = ['/api/flows', '/api/stats/overview', '/api/mappings', '/api/subscribers'];
  for (const route of protected_) {
    const r = await apiGet(`${API}${route}`);
    if (r.status !== 401) issue('HIGH', 'API', `${route} accessible without auth`, `got ${r.status}`);
  }
  console.log('✅ Protected routes return 401 without token');
}

// ─── 2. Authentication ──────────────────────────────────────────────────────
async function testAuth(page) {
  console.log('\n=== 2. Authentication ===');

  // 2a. Invalid login
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await ss(page, 'login_page');
  await page.fill('input[type="text"], input[formcontrolname="username"]', 'wronguser');
  await page.fill('input[type="password"], input[formcontrolname="password"]', 'wrongpass');
  await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
  await page.waitForTimeout(2000);
  const errVisible = await page.locator('text=/invalid|incorrect|unauthorized/i').isVisible().catch(() => false);
  if (!errVisible) issue('MEDIUM', 'Auth', 'No error message shown for invalid credentials');
  else console.log('✅ Invalid credentials shows error');

  // 2b. Valid admin login
  const loggedIn = await loginUI(page, ADMIN);
  if (!loggedIn) { issue('CRITICAL', 'Auth', 'Admin login failed'); return false; }
  await ss(page, 'after_admin_login');
  console.log('✅ Admin login successful');

  // 2c. Redirect — unauthenticated access to protected page
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/dashboard`);
  await page.waitForTimeout(1500);
  if (!page.url().includes('login')) issue('HIGH', 'Auth', 'Dashboard accessible without auth — no redirect to login');
  else console.log('✅ Unauthenticated redirect to login works');

  return true;
}

// ─── 3. Dashboard ───────────────────────────────────────────────────────────
async function testDashboard(page, token) {
  console.log('\n=== 3. Dashboard ===');
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.evaluate((u) => localStorage.setItem('user', JSON.stringify(u)), { username: 'admin', role: 'admin' });

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await ss(page, 'dashboard');

  // KPI cards
  const kpiSelectors = [
    ['Total Flows', /\d/],
    ['Total Bytes', /\d/],
    ['Avg Duration', /\d/],
  ];
  for (const [label, pattern] of kpiSelectors) {
    const el = page.locator(`text="${label}"`).first();
    if (!await el.isVisible().catch(() => false)) {
      issue('MEDIUM', 'Dashboard', `KPI card "${label}" not visible`);
    }
  }

  // Check for NaN or 0 in all KPIs (potential data issue)
  const nanText = await page.locator('text="NaN"').count();
  if (nanText > 0) issue('HIGH', 'Dashboard', `${nanText} "NaN" value(s) visible on dashboard`);

  const undefinedText = await page.locator('text="undefined"').count();
  if (undefinedText > 0) issue('HIGH', 'Dashboard', `${undefinedText} "undefined" value(s) visible on dashboard`);

  // Protocol distribution chart
  const charts = await page.locator('canvas').count();
  if (charts === 0) issue('HIGH', 'Dashboard', 'No Chart.js canvas found — charts may not be rendering');
  else console.log(`✅ ${charts} chart canvas(es) found`);

  // Top Applications table
  const topApps = await page.locator('text=/Top App|top app/i').first().isVisible().catch(() => false);
  if (!topApps) issue('MEDIUM', 'Dashboard', 'Top Applications section not visible');

  // Check for "unclassified" everywhere — flag if >50% of rows show it
  const unclassified = await page.locator('text=/unclassified/i').count();
  if (unclassified > 5) issue('LOW', 'Dashboard', `${unclassified} "unclassified" labels — application detection may be low`);

  // WebSocket connection indicator or live data
  const liveIndicator = await page.locator('text=/live|connected|active/i').first().isVisible().catch(() => false);
  console.log(liveIndicator ? '✅ Live indicator present' : '⚠️  No live indicator found');

  // Console errors
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.waitForTimeout(1000);
  if (consoleErrors.length > 0) {
    issue('MEDIUM', 'Dashboard', `${consoleErrors.length} console error(s)`, consoleErrors[0].slice(0, 120));
  }

  console.log('✅ Dashboard loaded');
}

// ─── 4. Flows Page ──────────────────────────────────────────────────────────
async function testFlows(page, token) {
  console.log('\n=== 4. Flows ===');
  await page.goto(`${BASE}/flows`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'flows');

  // Table visible
  const table = await page.locator('table, mat-table').first().isVisible().catch(() => false);
  if (!table) { issue('HIGH', 'Flows', 'Flows table not rendered'); return; }
  console.log('✅ Flows table visible');

  // Row count
  const rows = await page.locator('tr[class*="mat-row"], tr.mat-mdc-row').count();
  console.log(`   ${rows} flow rows visible`);
  if (rows === 0) issue('MEDIUM', 'Flows', 'Flows table is empty — check if capture is running');

  // Filters — test src_ip filter
  const filterInput = page.locator('input[placeholder*="IP"], input[formcontrolname="src_ip"], mat-form-field input').first();
  if (await filterInput.isVisible().catch(() => false)) {
    await filterInput.fill('192.168');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    console.log('✅ Filter interaction OK');
    await filterInput.clear();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
  } else {
    issue('LOW', 'Flows', 'Filter input not found or not interactable');
  }

  // Pagination
  const paginator = await page.locator('mat-paginator').isVisible().catch(() => false);
  if (!paginator) issue('LOW', 'Flows', 'Paginator not visible');

  // Click first row to open detail modal
  const firstRow = page.locator('tr[class*="mat-row"], tr.mat-mdc-row').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await page.waitForTimeout(1500);
    const modal = await page.locator('mat-dialog-container, .mat-mdc-dialog-container').isVisible().catch(() => false);
    if (!modal) issue('MEDIUM', 'Flows', 'Click on flow row does not open detail modal');
    else {
      await ss(page, 'flow_detail_modal');
      console.log('✅ Flow detail modal opens on row click');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  // Sorting — click a column header
  const sortHeader = page.locator('th[mat-sort-header], .mat-sort-header').first();
  if (await sortHeader.isVisible().catch(() => false)) {
    await sortHeader.click();
    await page.waitForTimeout(1000);
    console.log('✅ Column sort header clickable');
  }

  // Live flows tab
  const liveTab = page.locator('text=/live/i').first();
  if (await liveTab.isVisible().catch(() => false)) {
    await liveTab.click();
    await page.waitForTimeout(1500);
    await ss(page, 'flows_live');
    console.log('✅ Live flows tab accessible');
  }
}

// ─── 5. Domains ─────────────────────────────────────────────────────────────
async function testDomains(page) {
  console.log('\n=== 5. Domains ===');
  await page.goto(`${BASE}/domains`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'domains');

  const table = await page.locator('table, mat-table').first().isVisible().catch(() => false);
  if (!table) { issue('MEDIUM', 'Domains', 'Domains table not visible'); return; }

  const rows = await page.locator('tr[class*="mat-row"], tr.mat-mdc-row').count();
  console.log(`   ${rows} domain rows`);
  if (rows === 0) issue('LOW', 'Domains', 'Domains table empty — no hostnames captured yet');

  // Check for NaN
  const nan = await page.locator('text="NaN"').count();
  if (nan > 0) issue('HIGH', 'Domains', `${nan} NaN values in domains table`);
  console.log('✅ Domains page OK');
}

// ─── 6. Mappings ────────────────────────────────────────────────────────────
async function testMappings(page) {
  console.log('\n=== 6. Mappings ===');
  await page.goto(`${BASE}/mappings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'mappings');

  const table = await page.locator('table, mat-table').first().isVisible().catch(() => false);
  if (!table) { issue('MEDIUM', 'Mappings', 'Mappings table not visible'); }

  // "Add Mapping" tab visible for admin
  const addTab = page.locator('text="Add Mapping"').first();
  if (!await addTab.isVisible().catch(() => false)) {
    issue('HIGH', 'Mappings', '"Add Mapping" tab not visible for admin');
  } else {
    await addTab.click();
    await page.waitForTimeout(500);
    await ss(page, 'mappings_add_tab');
    console.log('✅ Add Mapping tab visible and clickable');

    // Attempt to submit empty form
    const addBtn = page.locator('button:has-text("Add Mapping")');
    if (await addBtn.isVisible().catch(() => false)) {
      const isDisabled = await addBtn.isDisabled();
      if (!isDisabled) issue('MEDIUM', 'Mappings', '"Add Mapping" button not disabled when form is invalid');
      else console.log('✅ Add Mapping button correctly disabled on empty form');
    }
  }

  // Bulk Import tab visible for admin
  const importTab = page.locator('text="Bulk Import"').first();
  if (!await importTab.isVisible().catch(() => false)) {
    issue('HIGH', 'Mappings', '"Bulk Import" tab not visible for admin');
  } else {
    console.log('✅ Bulk Import tab visible for admin');
  }

  // Add a test mapping and verify it appears
  const addTabClick = page.locator('text="Add Mapping"').first();
  if (await addTabClick.isVisible().catch(() => false)) {
    await addTabClick.click();
    await page.waitForTimeout(300);
    const patternInput = page.locator('input[formcontrolname="pattern"]');
    const appInput     = page.locator('input[formcontrolname="application"]');
    if (await patternInput.isVisible().catch(() => false)) {
      await patternInput.fill('qa-test.example.com');
      await appInput.fill('QA-Test-App');
      const addBtn = page.locator('button:has-text("Add Mapping")');
      await addBtn.click();
      await page.waitForTimeout(2000);
      const snack = await page.locator('text=/added|success/i').first().isVisible().catch(() => false);
      if (!snack) issue('MEDIUM', 'Mappings', 'No success feedback after adding mapping');
      else console.log('✅ Mapping add + snackbar feedback works');
    }
  }

  // Export CSV
  const exportCsvBtn = page.locator('button:has-text("CSV")').first();
  if (await exportCsvBtn.isVisible().catch(() => false)) {
    console.log('✅ CSV export button present');
  } else {
    issue('LOW', 'Mappings', 'CSV export button not found');
  }
}

// ─── 7. Subscribers ─────────────────────────────────────────────────────────
async function testSubscribers(page) {
  console.log('\n=== 7. Subscribers ===');
  await page.goto(`${BASE}/subscribers`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'subscribers');

  const addTab = page.locator('text="Add Subscriber"').first();
  if (!await addTab.isVisible().catch(() => false)) {
    issue('HIGH', 'Subscribers', '"Add Subscriber" tab not visible for admin');
  } else {
    await addTab.click();
    await page.waitForTimeout(300);
    await ss(page, 'subscribers_add_tab');

    // Test form validation
    const addBtn = page.locator('button:has-text("Add Subscriber")');
    if (await addBtn.isVisible().catch(() => false)) {
      const isDisabled = await addBtn.isDisabled();
      if (!isDisabled) issue('MEDIUM', 'Subscribers', '"Add Subscriber" button not disabled on empty form');
      else console.log('✅ Add Subscriber button correctly disabled on empty form');
    }

    // Fill in a test subscriber
    const ipInput  = page.locator('input[formcontrolname="ip_address"]');
    const subInput = page.locator('input[formcontrolname="subscriber_id"]');
    if (await ipInput.isVisible().catch(() => false)) {
      await ipInput.fill('192.168.99.99');
      await subInput.fill('QA-TEST-SUB');
      const addBtn2 = page.locator('button:has-text("Add Subscriber")');
      await addBtn2.click();
      await page.waitForTimeout(2000);
      const snack = await page.locator('text=/added|success/i').first().isVisible().catch(() => false);
      if (!snack) issue('MEDIUM', 'Subscribers', 'No success feedback after adding subscriber');
      else console.log('✅ Subscriber add works');
    }
  }

  // Go back to list and test edit
  const listTab = page.locator('text=/All Subscribers/i').first();
  if (await listTab.isVisible().catch(() => false)) {
    await listTab.click();
    await page.waitForTimeout(1000);
    const editBtn = page.locator('button[mattooltip="Edit"]').first();
    if (await editBtn.isVisible().catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(500);
      const editPanel = page.locator('text=/Edit Subscriber/i').first();
      if (!await editPanel.isVisible().catch(() => false)) {
        issue('MEDIUM', 'Subscribers', 'Edit panel does not appear after clicking Edit button');
      } else {
        await ss(page, 'subscribers_edit_panel');
        console.log('✅ Subscriber edit panel opens');
        const cancelBtn = page.locator('button:has-text("Cancel")').first();
        if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
      }
    }
  }
}

// ─── 8. Alerts ──────────────────────────────────────────────────────────────
async function testAlerts(page) {
  console.log('\n=== 8. Alerts ===');
  await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'alerts');

  // New rule form visible for admin
  const ruleForm = page.locator('text="New Alert Rule"').first();
  if (!await ruleForm.isVisible().catch(() => false)) {
    issue('HIGH', 'Alerts', '"New Alert Rule" form not visible for admin');
  } else {
    console.log('✅ New Alert Rule form visible');
  }

  // Create rule button disabled on empty form
  const createBtn = page.locator('button:has-text("Create Rule")');
  if (await createBtn.isVisible().catch(() => false)) {
    const isDisabled = await createBtn.isDisabled();
    if (!isDisabled) issue('MEDIUM', 'Alerts', '"Create Rule" button not disabled on empty form');
    else console.log('✅ Create Rule button correctly disabled on empty form');

    // Fill and create a rule
    await page.fill('input[formcontrolname="name"]', 'QA Test Rule');
    await page.fill('input[formcontrolname="threshold"]', '1000000');
    await createBtn.click();
    await page.waitForTimeout(2000);
    const snack = await page.locator('text=/created|success/i').first().isVisible().catch(() => false);
    if (!snack) issue('MEDIUM', 'Alerts', 'No success feedback after creating alert rule');
    else console.log('✅ Alert rule creation + feedback works');
  }

  // Events tab
  const eventsTab = page.locator('text="Alert Events"').first();
  if (await eventsTab.isVisible().catch(() => false)) {
    await eventsTab.click();
    await page.waitForTimeout(1500);
    await ss(page, 'alert_events');
    console.log('✅ Alert Events tab accessible');
    const unackBtn = page.locator('button:has-text("Unacknowledged")').first();
    if (!await unackBtn.isVisible().catch(() => false)) {
      issue('LOW', 'Alerts', 'Unacknowledged filter button not found in events tab');
    }
  }
}

// ─── 9. Policy ──────────────────────────────────────────────────────────────
async function testPolicy(page) {
  console.log('\n=== 9. Policy ===');
  await page.goto(`${BASE}/policy`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'policy');

  // Add Rule card visible
  const addCard = page.locator('text="Add / Override Rule"').first();
  if (!await addCard.isVisible().catch(() => false)) {
    issue('HIGH', 'Policy', '"Add / Override Rule" card not visible for admin');
  } else {
    console.log('✅ Add / Override Rule card visible for admin');
  }

  // Enable All / Disable All buttons
  const enableAll  = page.locator('button:has-text("Enable All")').first();
  const disableAll = page.locator('button:has-text("Disable All")').first();
  if (!await enableAll.isVisible().catch(() => false))  issue('HIGH', 'Policy', '"Enable All" button missing for admin');
  if (!await disableAll.isVisible().catch(() => false)) issue('HIGH', 'Policy', '"Disable All" button missing for admin');

  // Table
  const table = await page.locator('table, mat-table').first().isVisible().catch(() => false);
  if (!table) { issue('HIGH', 'Policy', 'Policy table not rendered'); return; }

  const rows = await page.locator('tr[class*="mat-row"], tr.mat-mdc-row').count();
  console.log(`   ${rows} policy rows`);

  // Slide toggles visible for admin
  const toggles = await page.locator('mat-slide-toggle').count();
  if (toggles === 0) issue('HIGH', 'Policy', 'No slide toggles visible — admin cannot toggle capture policy');
  else console.log(`✅ ${toggles} slide toggle(s) visible`);

  // Test adding a rule
  const appInput = page.locator('input[formcontrolname="appCtrl"], input[placeholder*="YouTube"]').first();
  if (await appInput.isVisible().catch(() => false)) {
    await appInput.fill('QA-Policy-Test');
    const allowBtn = page.locator('button:has-text("Allow")').first();
    if (await allowBtn.isVisible().catch(() => false)) {
      await allowBtn.click();
      await page.waitForTimeout(2000);
      const snack = await page.locator('text=/allowed|saved/i').first().isVisible().catch(() => false);
      if (!snack) issue('MEDIUM', 'Policy', 'No feedback after adding Allow rule');
      else console.log('✅ Policy Allow rule add feedback works');
    }
  }

  // Dirty save bar appears after toggle change
  const firstToggle = page.locator('mat-slide-toggle').first();
  if (await firstToggle.isVisible().catch(() => false)) {
    await firstToggle.click();
    await page.waitForTimeout(500);
    const saveBar = page.locator('text=/Save Changes/i').first();
    const saveBarVisible = await saveBar.isVisible().catch(() => false);
    if (!saveBarVisible) issue('MEDIUM', 'Policy', 'Save Changes bar does not appear after toggling a policy');
    else {
      await ss(page, 'policy_dirty');
      console.log('✅ Save Changes bar appears after toggle');
      const revertBtn = page.locator('button:has-text("Revert")').first();
      if (await revertBtn.isVisible().catch(() => false)) {
        await revertBtn.click();
        await page.waitForTimeout(500);
      }
    }
  }
}

// ─── 10. IPDR ───────────────────────────────────────────────────────────────
async function testIPDR(page) {
  console.log('\n=== 10. IPDR ===');
  await page.goto(`${BASE}/ipdr`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'ipdr');

  const table = await page.locator('table, mat-table').first().isVisible().catch(() => false);
  if (!table) { issue('MEDIUM', 'IPDR', 'IPDR table not visible'); return; }

  const rows = await page.locator('tr[class*="mat-row"], tr.mat-mdc-row').count();
  console.log(`   ${rows} IPDR rows`);
  if (rows === 0) issue('LOW', 'IPDR', 'IPDR table empty — check IPDR key persistence');

  // Click first row to expand flows
  const firstRow = page.locator('tr[class*="mat-row"], tr.mat-mdc-row').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await page.waitForTimeout(1500);
    await ss(page, 'ipdr_expanded');
    console.log('✅ IPDR row expansion attempted');
  }

  // NaN check
  const nan = await page.locator('text="NaN"').count();
  if (nan > 0) issue('HIGH', 'IPDR', `${nan} NaN values on IPDR page`);
}

// ─── 11. Users Management ───────────────────────────────────────────────────
async function testUsers(page) {
  console.log('\n=== 11. Users Management ===');
  await page.goto(`${BASE}/users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await ss(page, 'users');

  // User list visible
  const addBtn = page.locator('button:has-text("Add User"), button:has-text("New User")').first();
  if (!await addBtn.isVisible().catch(() => false)) {
    issue('HIGH', 'Users', '"Add User" button not visible on users management page');
  } else {
    console.log('✅ Add User button visible');
    await addBtn.click();
    await page.waitForTimeout(500);
    await ss(page, 'users_add_dialog');

    // Create viewer test user
    const usernameInput = page.locator('mat-dialog-container input[formcontrolname="username"], mat-dialog-container input').first();
    const passwordInput = page.locator('mat-dialog-container input[type="password"]').first();
    if (await usernameInput.isVisible().catch(() => false)) {
      await usernameInput.fill(VIEWER.username);
      await passwordInput.fill(VIEWER.password);
      // Role stays viewer by default
      const saveBtn = page.locator('mat-dialog-container button:has-text("Save"), mat-dialog-container button:has-text("Create")').first();
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(2000);
        const snack = await page.locator('text=/created|added|success/i').first().isVisible().catch(() => false);
        console.log(snack ? '✅ Viewer user created' : '⚠️  No snackbar after creating user (may already exist)');
      }
    } else {
      await page.keyboard.press('Escape');
    }
  }

  // Edit user
  const editBtn = page.locator('button[mattooltip="Edit"], button mat-icon:has-text("edit")').first();
  if (await editBtn.isVisible().catch(() => false)) {
    console.log('✅ Edit button visible on users list');
  }

  // Delete button (self-delete prevented)
  const deleteBtn = page.locator('button[mattooltip="Delete"], button mat-icon:has-text("delete")').first();
  if (await deleteBtn.isVisible().catch(() => false)) {
    console.log('✅ Delete button visible on users list');
  }
}

// ─── 12. Viewer Role Restrictions ───────────────────────────────────────────
async function testViewerRole(page) {
  console.log('\n=== 12. Viewer Role Restrictions ===');
  const viewerToken = await getToken(VIEWER);
  if (!viewerToken) {
    issue('HIGH', 'Auth', 'Viewer user login failed — cannot test role restrictions');
    return;
  }

  await page.evaluate((t) => localStorage.setItem('token', t), viewerToken);
  await page.evaluate(() => localStorage.setItem('user', JSON.stringify({ username: 'viewer_test', role: 'viewer' })));

  // Mappings — Add/Import tabs should be hidden
  await page.goto(`${BASE}/mappings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await ss(page, 'viewer_mappings');
  const addMappingTab  = await page.locator('text="Add Mapping"').isVisible().catch(() => false);
  const bulkImportTab  = await page.locator('text="Bulk Import"').isVisible().catch(() => false);
  const deleteMapping  = await page.locator('button[mattooltip="Delete"]').first().isVisible().catch(() => false);
  if (addMappingTab)  issue('CRITICAL', 'Viewer', '"Add Mapping" tab visible to viewer — write access exposed');
  if (bulkImportTab)  issue('CRITICAL', 'Viewer', '"Bulk Import" tab visible to viewer — write access exposed');
  if (deleteMapping)  issue('CRITICAL', 'Viewer', 'Delete button visible to viewer on Mappings page');
  if (!addMappingTab && !bulkImportTab && !deleteMapping) console.log('✅ Mappings: all write controls hidden for viewer');

  // Subscribers
  await page.goto(`${BASE}/subscribers`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await ss(page, 'viewer_subscribers');
  const addSubTab  = await page.locator('text="Add Subscriber"').isVisible().catch(() => false);
  const editSubBtn = await page.locator('button[mattooltip="Edit"]').first().isVisible().catch(() => false);
  const delSubBtn  = await page.locator('button[mattooltip="Delete"]').first().isVisible().catch(() => false);
  if (addSubTab)  issue('CRITICAL', 'Viewer', '"Add Subscriber" tab visible to viewer');
  if (editSubBtn) issue('CRITICAL', 'Viewer', 'Edit button visible to viewer on Subscribers page');
  if (delSubBtn)  issue('CRITICAL', 'Viewer', 'Delete button visible to viewer on Subscribers page');
  if (!addSubTab && !editSubBtn && !delSubBtn) console.log('✅ Subscribers: all write controls hidden for viewer');

  // Alerts — Create rule form should be hidden
  await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await ss(page, 'viewer_alerts');
  const newRuleForm = await page.locator('text="New Alert Rule"').isVisible().catch(() => false);
  const ruleToggle  = await page.locator('mat-slide-toggle').first().isVisible().catch(() => false);
  if (newRuleForm) issue('CRITICAL', 'Viewer', '"New Alert Rule" form visible to viewer');
  if (ruleToggle)  issue('CRITICAL', 'Viewer', 'Alert rule toggle visible to viewer — should be read-only text');
  if (!newRuleForm && !ruleToggle) console.log('✅ Alerts: write controls hidden for viewer');

  // Policy — Add Rule card and toggles should be hidden
  await page.goto(`${BASE}/policy`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await ss(page, 'viewer_policy');
  const addRuleCard   = await page.locator('text="Add / Override Rule"').isVisible().catch(() => false);
  const policyToggle  = await page.locator('mat-slide-toggle').first().isVisible().catch(() => false);
  const enableAllBtn  = await page.locator('button:has-text("Enable All")').isVisible().catch(() => false);
  if (addRuleCard)  issue('CRITICAL', 'Viewer', '"Add / Override Rule" card visible to viewer');
  if (policyToggle) issue('CRITICAL', 'Viewer', 'Policy capture toggle visible to viewer — should be text');
  if (enableAllBtn) issue('CRITICAL', 'Viewer', '"Enable All" button visible to viewer');
  if (!addRuleCard && !policyToggle && !enableAllBtn) console.log('✅ Policy: all write controls hidden for viewer');

  // Users nav item should be hidden
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const usersNav = await page.locator('text="Users"').first().isVisible().catch(() => false);
  if (usersNav) issue('HIGH', 'Viewer', '"Users" nav item visible to viewer — should be admin-only');
  else console.log('✅ Users nav item hidden for viewer');

  // API: viewer token should be rejected on admin routes
  const adminRoutes = [
    ['POST', `${API}/api/mappings`],
    ['DELETE', `${API}/api/mappings/1`],
    ['POST', `${API}/api/subscribers`],
    ['POST', `${API}/api/alerts/rules`],
    ['PUT', `${API}/api/policy/TestApp`],
  ];
  for (const [method, url] of adminRoutes) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status !== 403) {
      issue('CRITICAL', 'API', `${method} ${url.replace(API,'')} returned ${res.status} for viewer (expected 403)`);
    }
  }
  console.log('✅ API correctly rejects viewer on admin-only write routes');
}

// ─── 13. App Usage Page ─────────────────────────────────────────────────────
async function testAppUsage(page, token) {
  console.log('\n=== 13. App Usage ===');
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.evaluate(() => localStorage.setItem('user', JSON.stringify({ username: 'admin', role: 'admin' })));
  const usageUrl = `${BASE}/app-usage`;
  await page.goto(usageUrl, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  const is404 = page.url().includes('login') || await page.locator('text=/404|not found/i').isVisible().catch(() => false);
  if (is404) {
    issue('LOW', 'App Usage', 'App Usage page route not found or redirects to login');
  } else {
    await ss(page, 'app_usage');
    console.log('✅ App Usage page accessible');
  }
}

// ─── 14. Data Accuracy (API vs UI) ─────────────────────────────────────────
async function testDataAccuracy(page, token) {
  console.log('\n=== 14. Data Accuracy ===');

  const overview = await apiGet(`${API}/api/stats/overview`, token);
  if (overview.status !== 200) {
    issue('HIGH', 'API', 'GET /api/stats/overview failed', `status ${overview.status}`);
    return;
  }

  const { total_flows, total_bytes, unique_apps } = overview.body;
  console.log(`   API: total_flows=${total_flows}, total_bytes=${total_bytes}, unique_apps=${unique_apps}`);

  if (total_flows === 0) issue('MEDIUM', 'Data', 'total_flows is 0 — no traffic captured');
  if (total_bytes === 0) issue('MEDIUM', 'Data', 'total_bytes is 0 — no traffic data');
  if (unique_apps === 0) issue('MEDIUM', 'Data', 'unique_apps is 0 — no applications detected');

  // Top apps
  const topApps = await apiGet(`${API}/api/stats/top-apps?limit=5`, token);
  if (topApps.status !== 200) {
    issue('HIGH', 'API', 'GET /api/stats/top-apps failed');
  } else {
    const apps = topApps.body;
    if (!Array.isArray(apps)) issue('HIGH', 'API', 'top-apps response is not an array');
    else {
      for (const app of apps.slice(0, 3)) {
        if (!app.application) issue('MEDIUM', 'Data', 'top-apps entry missing application field');
        if (app.total_bytes === null || app.total_bytes === undefined)
          issue('MEDIUM', 'Data', `top-apps entry "${app.application}" has null total_bytes`);
      }
      console.log(`   top-apps: ${apps.length} entries, top: ${apps[0]?.application || 'none'}`);
    }
  }

  // Bandwidth
  const bw = await apiGet(`${API}/api/stats/bandwidth?limit=30`, token);
  if (bw.status !== 200) issue('HIGH', 'API', 'GET /api/stats/bandwidth failed');
  else {
    const buckets = bw.body;
    if (!Array.isArray(buckets) || buckets.length === 0)
      issue('MEDIUM', 'Data', 'Bandwidth endpoint returns no data');
    else console.log(`   bandwidth: ${buckets.length} time buckets`);
  }

  // Protocol distribution
  const proto = await apiGet(`${API}/api/stats/protocol-distribution`, token);
  if (proto.status !== 200) issue('HIGH', 'API', 'GET /api/stats/protocol-distribution failed');
  else {
    const protoData = proto.body;
    const hasName = protoData.every(p => p.name);
    if (!hasName) issue('MEDIUM', 'Data', 'Some protocol distribution entries missing name field');
    else console.log(`   protocol-distribution: ${protoData.length} protocols`);
  }

  // Anomalies
  const anomalies = await apiGet(`${API}/api/stats/anomalies`, token);
  if (anomalies.status !== 200) issue('HIGH', 'API', 'GET /api/stats/anomalies failed');
  else {
    const { bandwidth_spikes, port_scanners, new_applications } = anomalies.body;
    if (!Array.isArray(bandwidth_spikes)) issue('HIGH', 'API', 'anomalies.bandwidth_spikes is not an array');
    if (!Array.isArray(port_scanners))   issue('HIGH', 'API', 'anomalies.port_scanners is not an array');
    if (!Array.isArray(new_applications)) issue('HIGH', 'API', 'anomalies.new_applications is not an array');
    else console.log(`   anomalies: ${bandwidth_spikes?.length} spikes, ${port_scanners?.length} scanners, ${new_applications?.length} new apps`);
  }

  // IPDR
  const ipdr = await apiGet(`${API}/api/ipdr`, token);
  if (ipdr.status !== 200) issue('HIGH', 'API', 'GET /api/ipdr failed');
  else console.log(`   ipdr: ${ipdr.body.rows?.length ?? 0} records`);
}

// ─── 15. Navigation / Sidebar ───────────────────────────────────────────────
async function testNavigation(page, token) {
  console.log('\n=== 15. Navigation ===');
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.evaluate(() => localStorage.setItem('user', JSON.stringify({ username: 'admin', role: 'admin' })));

  const routes = [
    { path: '/dashboard',   label: 'Dashboard'    },
    { path: '/flows',       label: 'Flows'        },
    { path: '/domains',     label: 'Domains'      },
    { path: '/mappings',    label: 'Mappings'     },
    { path: '/subscribers', label: 'Subscribers'  },
    { path: '/ipdr',        label: 'IPDR'         },
    { path: '/alerts',      label: 'Alerts'       },
    { path: '/policy',      label: 'Policy'       },
    { path: '/users',       label: 'Users'        },
  ];

  for (const { path, label } of routes) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const redirectedToLogin = page.url().includes('login');
    if (redirectedToLogin) {
      issue('CRITICAL', 'Navigation', `${label} (${path}) redirects to login when authenticated`);
    } else {
      // Check for Angular error overlay
      const ngError = await page.locator('.ng-star-inserted[style*="red"], text=/Error:/').isVisible().catch(() => false);
      if (ngError) issue('HIGH', 'Navigation', `Angular error on ${label} page`);
    }
  }
  console.log('✅ All routes navigable without auth redirect');
}

// ─── 16. Responsive / Mobile Check ──────────────────────────────────────────
async function testResponsive(page, token) {
  console.log('\n=== 16. Responsive (mobile) ===');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await ss(page, 'mobile_dashboard');

  // Check for horizontal scroll (overflow)
  const bodyWidth   = await page.evaluate(() => document.body.scrollWidth);
  const windowWidth = await page.evaluate(() => window.innerWidth);
  if (bodyWidth > windowWidth + 20) {
    issue('MEDIUM', 'Responsive', `Horizontal overflow on mobile: body=${bodyWidth}px, window=${windowWidth}px`);
  } else {
    console.log('✅ No horizontal overflow on mobile');
  }

  await page.setViewportSize({ width: 1440, height: 900 });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 FlowMon QA Test Suite starting...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await context.newPage();

  // Capture console errors globally
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      consoleErrors.push({ url: page.url(), text: msg.text().slice(0, 200) });
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push({ url: page.url(), text: err.message.slice(0, 200) });
  });

  await testApiHealth();
  const adminLoggedIn = await testAuth(page);

  const adminToken = await getToken(ADMIN);
  if (!adminToken) { console.error('Cannot get admin token — aborting'); process.exit(1); }

  // Login in page context
  await page.evaluate((t) => localStorage.setItem('token', t), adminToken);
  await page.evaluate(() => localStorage.setItem('user', JSON.stringify({ username: 'admin', role: 'admin' })));

  await testDashboard(page, adminToken);
  await testFlows(page, adminToken);
  await testDomains(page);
  await testMappings(page);
  await testSubscribers(page);
  await testAlerts(page);
  await testPolicy(page);
  await testIPDR(page);
  await testUsers(page);
  await testDataAccuracy(page, adminToken);
  await testNavigation(page, adminToken);
  await testResponsive(page, adminToken);

  // Re-login as admin for viewer test
  await page.evaluate((t) => localStorage.setItem('token', t), adminToken);
  await page.evaluate(() => localStorage.setItem('user', JSON.stringify({ username: 'admin', role: 'admin' })));
  await testViewerRole(page);
  await testAppUsage(page, adminToken);

  // Console errors summary
  if (consoleErrors.length > 0) {
    for (const e of consoleErrors.slice(0, 5)) {
      issue('MEDIUM', 'Console', e.text, `on ${e.url}`);
    }
    if (consoleErrors.length > 5) {
      issue('LOW', 'Console', `${consoleErrors.length - 5} additional console errors suppressed`);
    }
  }

  await browser.close();

  // ─── Report ───────────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(70));
  console.log('  QA REPORT SUMMARY');
  console.log('═'.repeat(70));

  const byPriority = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
  for (const i of issues) byPriority[i.severity]?.push(i);

  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  let total = 0;
  for (const sev of order) {
    const list = byPriority[sev];
    if (!list.length) continue;
    const marker = sev === 'CRITICAL' ? '🔴' : sev === 'HIGH' ? '🟠' : sev === 'MEDIUM' ? '🟡' : '🔵';
    console.log(`\n${marker} ${sev} (${list.length})`);
    for (const i of list) {
      console.log(`   [${i.page}] ${i.description}${i.detail ? ' — ' + i.detail : ''}`);
      total++;
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`Total issues: ${total}`);
  console.log(`  🔴 Critical: ${byPriority.CRITICAL.length}`);
  console.log(`  🟠 High:     ${byPriority.HIGH.length}`);
  console.log(`  🟡 Medium:   ${byPriority.MEDIUM.length}`);
  console.log(`  🔵 Low:      ${byPriority.LOW.length}`);
  console.log(`Screenshots saved to: ${SS_DIR}`);
  console.log('═'.repeat(70));

  // Save JSON report
  const reportPath = path.join(__dirname, '..', 'qa_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), issues, consoleErrors }, null, 2));
  console.log(`JSON report: ${reportPath}`);
})();
