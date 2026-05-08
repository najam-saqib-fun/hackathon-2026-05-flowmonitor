const { test, expect } = require('@playwright/test');

const FRONTEND = 'http://localhost:4200';
const BACKEND  = 'http://localhost:3000';

test.use({ baseURL: FRONTEND });

test.describe('Local login diagnostics', () => {

  test('backend health check', async ({ request }) => {
    const res = await request.get(`${BACKEND}/api/health`);
    console.log('health status:', res.status());
    const body = await res.json();
    console.log('health body:', JSON.stringify(body));
    expect(res.status()).toBe(200);
  });

  test('backend login API returns JWT', async ({ request }) => {
    const res = await request.post(`${BACKEND}/api/auth/login`, {
      data: { username: 'admin', password: 'admin123' },
    });
    console.log('login status:', res.status());
    const body = await res.json();
    console.log('login body:', JSON.stringify(body));
    expect(res.status()).toBe(200);
    expect(body).toHaveProperty('token');
  });

  test('frontend login page loads', async ({ page }) => {
    await page.goto(FRONTEND);
    console.log('final url after goto:', page.url());
    await page.screenshot({ path: 'playwright-report/01-login-page.png', fullPage: true });
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
    await expect(page.locator('input[formcontrolname="username"]')).toBeVisible();
    await expect(page.locator('input[formcontrolname="password"]')).toBeVisible();
  });

  test('login with admin/admin123 → dashboard', async ({ page }) => {
    // Capture all network requests and responses for diagnosis
    const networkLog = [];
    page.on('request',  req  => networkLog.push(`REQ  ${req.method()} ${req.url()}`));
    page.on('response', resp => networkLog.push(`RESP ${resp.status()} ${resp.url()}`));

    page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    await page.goto(FRONTEND);
    await page.waitForURL(/login/, { timeout: 10000 });
    await page.screenshot({ path: 'playwright-report/02-before-login.png', fullPage: true });

    await page.fill('input[formcontrolname="username"]', 'admin');
    await page.fill('input[formcontrolname="password"]', 'admin123');
    await page.screenshot({ path: 'playwright-report/03-filled.png', fullPage: true });

    await page.click('button[type="submit"]');

    // Wait a moment to let navigation or error messages appear
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'playwright-report/04-after-submit.png', fullPage: true });

    console.log('\n--- Network log ---');
    networkLog.forEach(l => console.log(l));
    console.log('--- End network log ---\n');
    console.log('Current URL after submit:', page.url());

    // Check for visible error messages
    const errorVisible = await page.locator('text=/invalid|failed|error|incorrect/i').isVisible().catch(() => false);
    if (errorVisible) {
      const errorText = await page.locator('text=/invalid|failed|error|incorrect/i').textContent().catch(() => '');
      console.log('Error message on page:', errorText);
    }

    await expect(page).toHaveURL(/dashboard/, { timeout: 15000 });
  });

});
