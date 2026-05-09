const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:4200';
const API_URL = 'http://localhost:3000';
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

const PAGES = [
  { name: 'dashboard',    path: '/dashboard' },
  { name: 'flows',        path: '/flows' },
  { name: 'domains',      path: '/domains' },
  { name: 'mappings',     path: '/mappings' },
  { name: 'subscribers',  path: '/subscribers' },
  { name: 'ipdr',         path: '/ipdr' },
  { name: 'alerts',       path: '/alerts' },
  { name: 'policy',       path: '/policy' },
];

async function getToken() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const data = await res.json();
  return data.token;
}

(async () => {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const token = await getToken();
  if (!token) { console.error('Login failed'); process.exit(1); }
  console.log('Logged in, token acquired');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [],
      origins: [{
        origin: BASE_URL,
        localStorage: [{ name: 'token', value: token }],
      }],
    },
  });

  const page = await context.newPage();

  for (const { name, path: route } of PAGES) {
    const url = `${BASE_URL}${route}`;
    console.log(`Capturing ${name}...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);
      const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  → saved ${file}`);
    } catch (err) {
      console.error(`  Error on ${name}: ${err.message}`);
    }
  }

  await browser.close();
  console.log('All screenshots done.');
})();
