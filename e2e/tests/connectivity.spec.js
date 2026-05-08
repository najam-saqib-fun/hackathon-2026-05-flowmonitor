const { test, expect } = require('@playwright/test');

const BACKEND = 'https://backend-sand-three-78.vercel.app';
const FRONTEND = 'https://frontend-mauve-ten-46.vercel.app';

test.describe('Vercel deployment connectivity', () => {

  test('backend health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${BACKEND}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('ts');
    expect(body).toHaveProperty('uptime_s');
    expect(body).toHaveProperty('node_version');
  });

  test('backend login API returns JWT', async ({ request }) => {
    const res = await request.post(`${BACKEND}/api/auth/login`, {
      data: { username: 'admin', password: 'admin123' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // valid JWT format
  });

  test('backend stats/overview returns correct shape', async ({ request }) => {
    const loginRes = await request.post(`${BACKEND}/api/auth/login`, {
      data: { username: 'admin', password: 'admin123' },
    });
    const { token } = await loginRes.json();

    const res = await request.get(`${BACKEND}/api/stats/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total_flows');
    expect(body).toHaveProperty('total_bytes');
    expect(body).toHaveProperty('unique_apps');
  });

  test('frontend login page loads', async ({ page }) => {
    await page.goto(FRONTEND);
    // Angular router redirects to /login
    await expect(page).toHaveURL(/login/);
    await expect(page.locator('input[formcontrolname="username"]')).toBeVisible();
    await expect(page.locator('input[formcontrolname="password"]')).toBeVisible();
  });

  test('frontend login → dashboard with backend data', async ({ page }) => {
    // Track XHR calls to backend
    const apiCalls = [];
    page.on('request', req => {
      if (req.url().includes(BACKEND)) apiCalls.push(req.url());
    });

    await page.goto(FRONTEND);
    await expect(page).toHaveURL(/login/);

    // Fill credentials and submit
    await page.fill('input[formcontrolname="username"]', 'admin');
    await page.fill('input[formcontrolname="password"]', 'admin123');
    await page.click('button[type="submit"]');

    // Should navigate to dashboard after successful login
    await expect(page).toHaveURL(/dashboard/, { timeout: 15000 });

    // At least one API call to the backend was made
    expect(apiCalls.some(url => url.includes(BACKEND))).toBe(true);
  });

  test('frontend dashboard renders stat cards after backend responds', async ({ page }) => {
    await page.goto(FRONTEND);
    await page.fill('input[formcontrolname="username"]', 'admin');
    await page.fill('input[formcontrolname="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/dashboard/, { timeout: 15000 });

    // Dashboard should render the Real-time Dashboard heading and stat cards
    await expect(page.getByText('Real-time Dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('TOTAL FLOWS')).toBeVisible();
  });

});
