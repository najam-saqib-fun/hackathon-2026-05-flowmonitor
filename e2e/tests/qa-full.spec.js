// @ts-check
/**
 * Full QA suite for FlowMon frontend + backend.
 * Auth token is loaded from storageState (set by setup.js).
 * Only the Auth describe still tests actual login/logout flows with fresh pages.
 */
const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');

const BASE = 'http://localhost:4200';
const API  = 'http://localhost:3000/api';
const USER = 'admin';
const PASS = 'admin123';

/** Login via the UI form (for auth-describe tests that start with empty storageState) */
async function loginViaUI(page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input').first().fill(USER);
  await page.locator('input[type="password"]').fill(PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 12000 });
}

// ─── Authentication ────────────────────────────────────────────────────────────
test.describe('Authentication', () => {
  // These tests intentionally log in/out so we do NOT use the shared storageState
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login with valid credentials', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.locator('input').first().fill(USER);
    await page.locator('input[type="password"]').fill(PASS);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE}/dashboard`, { timeout: 12000 });
    expect(page.url()).toContain('/dashboard');
  });

  test('login rejects wrong password', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.locator('input').first().fill(USER);
    await page.locator('input[type="password"]').fill('wrongpass');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2500);
    expect(page.url()).toContain('/login');
  });

  test('unauthenticated access redirects to login', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await page.waitForURL(/\/login/, { timeout: 6000 });
    expect(page.url()).toContain('/login');
  });

  test('logout returns to login page', async ({ page }) => {
    await loginViaUI(page);
    await page.click('button:has-text("Logout")');
    await page.waitForURL(/\/login/, { timeout: 6000 });
    expect(page.url()).toContain('/login');
  });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/dashboard`); });

  test('KPI cards visible in stat-grid', async ({ page }) => {
    await page.waitForTimeout(2500);
    await expect(page.locator('.stat-grid .card, .card-value').first()).toBeVisible({ timeout: 8000 });
  });

  test('Quick and Custom mode buttons visible', async ({ page }) => {
    await expect(page.getByText('Quick').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Custom').first()).toBeVisible({ timeout: 5000 });
  });

  test('Quick mode shows preset dropdown with Last Week default', async ({ page }) => {
    const select = page.locator('app-time-filter select').first();
    await expect(select).toBeVisible({ timeout: 5000 });
    expect(await select.inputValue()).toBe('week');
  });

  test('switching to Last Hour triggers bandwidth API call', async ({ page }) => {
    // Wait for initial load to settle, then trigger a new bandwidth call via preset change
    await page.waitForTimeout(3000);
    const promise = page.waitForResponse(
      r => r.url().includes('/api/stats/bandwidth') && r.status() === 200,
      { timeout: 10000 }
    );
    await page.locator('app-time-filter select').first().selectOption('hour');
    expect((await promise).status()).toBe(200);
  });

  test('Custom mode shows date-time inputs', async ({ page }) => {
    await page.getByText('Custom').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('app-time-filter input[type="datetime-local"]').first()).toBeVisible({ timeout: 3000 });
  });

  test('live flows section shows "last 5 min" label', async ({ page }) => {
    await page.waitForTimeout(2000);
    await expect(page.getByText(/live flows/i).first()).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/last 5 min/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('bandwidth chart canvas renders', async ({ page }) => {
    await page.waitForTimeout(3000);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 8000 });
  });

  test('top applications section visible', async ({ page }) => {
    await page.waitForTimeout(3000);
    await expect(page.getByText(/top app/i).first()).toBeVisible({ timeout: 8000 });
  });

  test('switching preset updates top-apps API call', async ({ page }) => {
    // Wait for initial data load to complete, then set up listener and change preset
    await page.waitForTimeout(3000);
    const promise = page.waitForResponse(
      r => r.url().includes('/api/stats/top-apps') && r.status() === 200,
      { timeout: 10000 }
    );
    await page.locator('app-time-filter select').first().selectOption('day');
    expect((await promise).status()).toBe(200);
  });
});

// ─── Flows Page ────────────────────────────────────────────────────────────────
test.describe('Flows Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/flows`); });

  test('time filter component present', async ({ page }) => {
    await expect(page.locator('app-time-filter')).toBeVisible({ timeout: 5000 });
  });

  test('flows table or empty state visible after load', async ({ page }) => {
    // Wait for spinner to disappear
    await page.waitForFunction(() => !document.querySelector('mat-spinner'), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const table  = page.locator('table').first();
    const empty  = page.getByText('no flows').or(page.getByText('No flows')).or(page.getByText('No data')).first();
    const tableOk = await table.isVisible().catch(() => false);
    const emptyOk = await empty.isVisible().catch(() => false);
    expect(tableOk || emptyOk).toBe(true);
  });

  test('filter inputs present (src IP, dst IP, application)', async ({ page }) => {
    // Flows uses mat-form-field with matInput (no placeholder attr — uses mat-label)
    const inputs = page.locator('mat-form-field input[matInput], input[formcontrolname], input[formControlName]');
    await expect(inputs.first()).toBeVisible({ timeout: 5000 });
  });
});

// ─── Domains Page ──────────────────────────────────────────────────────────────
test.describe('Domains Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/domains`); });

  test('page header contains "domain"', async ({ page }) => {
    await expect(page.getByText(/domain/i).first()).toBeVisible({ timeout: 6000 });
  });

  test('time filter component present', async ({ page }) => {
    await expect(page.locator('app-time-filter')).toBeVisible({ timeout: 5000 });
  });
});

// ─── App Mappings ──────────────────────────────────────────────────────────────
test.describe('App Mappings', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/mappings`); });

  test('All Mappings tab shows mat-table', async ({ page }) => {
    await page.waitForTimeout(2000);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 8000 });
  });

  test('Bulk Import tab has CSV / JSON toggle buttons', async ({ page }) => {
    await page.getByText('Bulk Import').click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: 'CSV' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'JSON' })).toBeVisible({ timeout: 3000 });
  });

  test('import rejects JSON object (not array)', async ({ page }) => {
    await page.getByText('Bulk Import').click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'JSON' }).click();
    await page.locator('textarea').first().fill(JSON.stringify({ wrong: 'format' }));
    await page.getByRole('button', { name: /^Import$/i }).click();
    await page.waitForTimeout(800);
    await expect(
      page.locator('span').filter({ hasText: /must be an array|invalid|error/i }).first()
    ).toBeVisible({ timeout: 4000 });
  });

  test('import rejects CSV missing required columns', async ({ page }) => {
    await page.getByText('Bulk Import').click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'CSV' }).click();
    await page.locator('textarea').first().fill('name,value\ntest,123\n');
    await page.getByRole('button', { name: /^Import$/i }).click();
    await page.waitForTimeout(800);
    await expect(
      page.locator('span').filter({ hasText: /missing|invalid|error/i }).first()
    ).toBeVisible({ timeout: 4000 });
  });

  test('Load File populates textarea with file content', async ({ page }) => {
    await page.getByText('Bulk Import').click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'JSON' }).click();
    const tmpFile = '/tmp/qa_mappings.json';
    fs.writeFileSync(tmpFile, JSON.stringify([
      { pattern_type: 'hostname_exact', pattern: 'qa-load.example.com', application: 'QA Load', category: 'Test' }
    ]));
    await page.locator('input[type="file"]').first().setInputFiles(tmpFile);
    await page.waitForTimeout(800);
    const val = await page.locator('textarea').first().inputValue();
    expect(val).toContain('qa-load.example.com');
  });
});

// ─── Subscribers Page ──────────────────────────────────────────────────────────
test.describe('Subscribers Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/subscribers`); });

  test('page header "Subscribers" visible', async ({ page }) => {
    await expect(page.getByText('Subscribers').first()).toBeVisible({ timeout: 6000 });
  });

  test('table or empty state after load', async ({ page }) => {
    await page.waitForFunction(() => !document.querySelector('mat-spinner'), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const table = page.locator('table').first();
    const empty = page.getByText(/no subscriber|no data/i).first();
    expect(await table.isVisible().catch(() => false) || await empty.isVisible().catch(() => false)).toBe(true);
  });

  test('Bulk Import tab rejects wrong CSV columns', async ({ page }) => {
    await page.getByText('Bulk Import').click();
    await page.waitForTimeout(400);
    await page.locator('textarea').first().fill('name,email\nJohn,john@test.com\n');
    await page.getByRole('button', { name: /^Import$/i }).click();
    await page.waitForTimeout(800);
    await expect(
      page.locator('span').filter({ hasText: /missing|invalid|error/i }).first()
    ).toBeVisible({ timeout: 4000 });
  });
});

// ─── IPDRs Page ────────────────────────────────────────────────────────────────
test.describe('IPDRs Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/ipdr`); });

  test('page header contains IPDR', async ({ page }) => {
    await expect(page.getByText(/IPDR/i).first()).toBeVisible({ timeout: 6000 });
  });

  test('table or empty state renders', async ({ page }) => {
    await page.waitForFunction(() => !document.querySelector('mat-spinner'), { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const table = page.locator('table').first();
    const empty = page.getByText(/no data|no IPDR/i).first();
    expect(await table.isVisible().catch(() => false) || await empty.isVisible().catch(() => false)).toBe(true);
  });
});

// ─── Alerts Page ───────────────────────────────────────────────────────────────
test.describe('Alerts Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/alerts`); });

  test('page header "Alert Management" visible', async ({ page }) => {
    await expect(page.getByText('Alert Management')).toBeVisible({ timeout: 6000 });
  });

  test('"New Alert Rule" form card visible', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.getByText(/new alert rule/i).first()).toBeVisible({ timeout: 6000 });
  });
});

// ─── Policy Page ───────────────────────────────────────────────────────────────
test.describe('Policy Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/policy`); });

  test('page header "Capture Policy" visible', async ({ page }) => {
    await expect(page.getByText('Capture Policy')).toBeVisible({ timeout: 6000 });
  });
});

// ─── App Usage Page ────────────────────────────────────────────────────────────
test.describe('App Usage Page', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/app-usage`); });

  test('page header "Application Usage by IP" visible', async ({ page }) => {
    await expect(page.getByText(/application usage by ip/i).first()).toBeVisible({ timeout: 6000 });
  });

  test('time filter component present', async ({ page }) => {
    await expect(page.locator('app-time-filter')).toBeVisible({ timeout: 5000 });
  });

  test('IP/subscriber search input present', async ({ page }) => {
    await expect(
      page.locator('input[placeholder*="IP" i], input[placeholder*="subscriber" i]').first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('application search input present', async ({ page }) => {
    await expect(
      page.locator('input[placeholder*="application" i]').first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('preset change triggers app-usage API call', async ({ page }) => {
    // Wait for initial load to complete before setting up the next response listener
    await page.waitForTimeout(3000);
    const promise = page.waitForResponse(
      r => r.url().includes('/api/stats/app-usage') && r.status() === 200,
      { timeout: 10000 }
    );
    await page.locator('app-time-filter select').first().selectOption('day');
    expect((await promise).status()).toBe(200);
  });
});

// ─── Sidenav Shell ─────────────────────────────────────────────────────────────
test.describe('App Shell', () => {
  test.beforeEach(async ({ page }) => { await page.goto(`${BASE}/dashboard`); });

  test('sidenav shows all 9 nav items', async ({ page }) => {
    for (const label of ['Dashboard', 'Flows', 'Domains', 'App Mappings', 'Subscribers', 'IPDRs', 'Alerts', 'Policy', 'App Usage']) {
      await expect(page.getByText(label).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('logged-in username "admin" in sidenav', async ({ page }) => {
    await expect(page.locator('.sidenav, mat-sidenav').getByText(/admin/).first()).toBeVisible({ timeout: 5000 });
  });

  test('WebSocket indicator (Live or Reconnecting) visible', async ({ page }) => {
    await page.waitForTimeout(2000);
    const live   = page.getByText('Live').first();
    const reconn = page.getByText(/Reconnecting/i).first();
    expect(await live.isVisible().catch(() => false) || await reconn.isVisible().catch(() => false)).toBe(true);
  });

  test('sidenav links navigate to correct routes', async ({ page }) => {
    for (const [text, url] of [
      ['Flows', '/flows'], ['Domains', '/domains'], ['App Mappings', '/mappings'],
      ['Subscribers', '/subscribers'], ['App Usage', '/app-usage'],
    ]) {
      await page.locator('mat-nav-list a', { hasText: text }).first().click();
      await page.waitForURL(`${BASE}${url}`, { timeout: 8000 });
      expect(page.url()).toContain(url);
      await page.waitForTimeout(200);
    }
  });
});

// ─── Backend REST API ──────────────────────────────────────────────────────────
test.describe('Backend API', () => {
  let token = '';

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { username: USER, password: PASS },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status(), `Login failed: ${res.status()}`).toBe(200);
    const body = await res.json();
    expect(body.token, 'No token in login response').toBeTruthy();
    token = body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('health check', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  test('rejects unauthenticated with 401', async ({ request }) => {
    expect((await request.get(`${API}/stats/overview`)).status()).toBe(401);
  });

  test('overview stats has total_flows', async ({ request }) => {
    const res = await request.get(`${API}/stats/overview`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(await res.json()).toHaveProperty('total_flows');
  });

  test('bandwidth with time range returns array', async ({ request }) => {
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const res = await request.get(`${API}/stats/bandwidth?start=${start}&end=${end}`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('top-apps with time range', async ({ request }) => {
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const res = await request.get(`${API}/stats/top-apps?start=${start}&end=${end}&limit=10`, { headers: auth() });
    expect(res.status()).toBe(200);
  });

  test('top-talkers with time range', async ({ request }) => {
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const res = await request.get(`${API}/stats/top-talkers?start=${start}&end=${end}&limit=10`, { headers: auth() });
    expect(res.status()).toBe(200);
  });

  test('app-usage endpoint returns array', async ({ request }) => {
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const res = await request.get(`${API}/stats/app-usage?start=${start}&end=${end}&limit=100`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('protocol distribution', async ({ request }) => {
    expect((await request.get(`${API}/stats/protocol-distribution`, { headers: auth() })).status()).toBe(200);
  });

  test('flows list paginated', async ({ request }) => {
    expect((await request.get(`${API}/flows?page=1&limit=20`, { headers: auth() })).status()).toBe(200);
  });

  test('live flows returns array', async ({ request }) => {
    const res = await request.get(`${API}/flows/live`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('mappings list', async ({ request }) => {
    expect((await request.get(`${API}/mappings`, { headers: auth() })).status()).toBe(200);
  });

  test('subscribers list', async ({ request }) => {
    expect((await request.get(`${API}/subscribers`, { headers: auth() })).status()).toBe(200);
  });

  test('alert rules list', async ({ request }) => {
    expect((await request.get(`${API}/alerts/rules`, { headers: auth() })).status()).toBe(200);
  });

  test('IPDR list', async ({ request }) => {
    expect((await request.get(`${API}/ipdr`, { headers: auth() })).status()).toBe(200);
  });
});
