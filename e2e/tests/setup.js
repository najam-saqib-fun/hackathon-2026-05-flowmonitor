// @ts-check
/** Global setup: logs in once, saves storage state for all tests. */
const { test: setup, expect } = require('@playwright/test');

const BASE = 'http://localhost:4200';
const STORAGE_STATE = 'e2e-auth.json';

setup('acquire auth token', async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.locator('input').first().fill('admin');
  await page.locator('input[type="password"]').fill('admin123');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 15000 });
  await page.context().storageState({ path: STORAGE_STATE });
});
