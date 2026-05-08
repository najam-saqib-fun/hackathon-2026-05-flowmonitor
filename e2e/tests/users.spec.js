const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:4200';
const API  = 'http://localhost:3000';

test.describe('User Management', () => {

  test('Users nav item visible for admin', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('mat-nav-list').getByText('Users')).toBeVisible();
  });

  test('Navigate to /users shows user management page', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await expect(page.locator('h1')).toContainText('User Management');
    // Role legend text visible
    await expect(page.getByText('Full access — users, config, all data')).toBeVisible({ timeout: 5000 });
    // admin user row in table
    await expect(page.locator('table').getByText('admin', { exact: true })).toBeVisible();
    // "(you)" label
    await expect(page.getByText('(you)')).toBeVisible();
  });

  test('Add user dialog creates operator user', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.getByRole('button', { name: /add user/i }).click();
    await expect(page.getByRole('heading', { name: 'Add User' })).toBeVisible();

    await page.locator('mat-dialog-container input').first().fill('test_e2e_user');
    await page.locator('mat-dialog-container input[type="password"]').fill('testpass123');
    await page.locator('mat-dialog-container mat-select').click();
    await page.getByRole('option', { name: /^Operator/i }).first().click();
    await page.getByRole('button', { name: /create user/i }).click();

    await expect(page.getByText('User created')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('table').getByText('test_e2e_user')).toBeVisible();
  });

  test('Edit user dialog changes role', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.waitForTimeout(800);
    // Click edit button on test_e2e_user row (first icon button in that row)
    const row = page.locator('tr').filter({ hasText: 'test_e2e_user' });
    await row.locator('button').first().click();
    await expect(page.getByRole('heading', { name: 'Edit User' })).toBeVisible();

    // Change role to viewer
    await page.locator('mat-dialog-container mat-select').click();
    await page.getByRole('option', { name: /^Viewer/i }).first().click();
    await page.getByRole('button', { name: /save changes/i }).click();

    await expect(page.getByText('User updated')).toBeVisible({ timeout: 5000 });
  });

  test('Delete user removes from table', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.waitForTimeout(800);

    const row = page.locator('tr').filter({ hasText: 'test_e2e_user' });
    const buttons = row.locator('button');
    await buttons.last().click(); // delete button is the last in the row
    await expect(page.getByRole('heading', { name: 'Delete User' })).toBeVisible();
    await page.getByRole('button', { name: /^delete$/i }).click();

    await expect(page.getByText('User deleted')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('table').getByText('test_e2e_user')).not.toBeVisible({ timeout: 3000 });
  });

  test('Delete button disabled for own account', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.waitForTimeout(500);
    // The admin row's delete button (last button) should be disabled
    const adminRow = page.locator('tr').filter({ hasText: 'admin' }).filter({ hasText: '(you)' });
    const deleteBtn = adminRow.locator('button').last();
    await expect(deleteBtn).toBeDisabled();
  });

  test('Role filter chips filter the table', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.waitForTimeout(500);
    // Click Admin filter
    await page.getByRole('button', { name: /^Admin$/ }).click();
    await expect(page.locator('table').getByText('admin', { exact: true })).toBeVisible();
    // Click Viewer filter — admin should not be in viewer list
    await page.getByRole('button', { name: /^Viewer$/ }).click();
    await expect(page.locator('table').getByText('admin', { exact: true })).not.toBeVisible({ timeout: 2000 });
  });

  test('Search filters users by username', async ({ page }) => {
    await page.goto(`${BASE}/users`);
    await page.waitForTimeout(500);
    await page.locator('input[placeholder="Search users…"]').fill('adm');
    await expect(page.locator('table').getByText('admin', { exact: true })).toBeVisible();
    await page.locator('input[placeholder="Search users…"]').fill('zzzznotfound');
    await expect(page.getByText('No users match')).toBeVisible();
  });
});

test.describe('Top Apps time filter (API)', () => {
  test('Returns JSON array with and without date filter', async ({ request }) => {
    const loginRes = await request.post(`${API}/api/auth/login`, {
      data: { username: 'admin', password: 'admin123' },
    });
    const { token } = await loginRes.json();

    const noFilter = await request.get(`${API}/api/stats/top-apps?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const withFilter = await request.get(
      `${API}/api/stats/top-apps?limit=5&start=2024-01-01+00:00:00&end=2024-12-31+23:59:59`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    expect(noFilter.status()).toBe(200);
    expect(withFilter.status()).toBe(200);
    expect(Array.isArray(await noFilter.json())).toBe(true);
    expect(Array.isArray(await withFilter.json())).toBe(true);

    console.log(`No filter: ${(await noFilter.json()).length} apps | With 2024 filter: ${(await withFilter.json()).length} apps`);
  });
});
