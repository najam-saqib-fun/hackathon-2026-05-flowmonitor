const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:4200';

test.describe('Dashboard Total Bytes Monitor', () => {
  test.setTimeout(90000);

  test('Watch Total Bytes for 1 min — flag if it decreases', async ({ page }) => {
    const readings = [];
    const POLLS = 12; // 12 × 5 s = 60 s

    for (let i = 0; i < POLLS; i++) {
      await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.card-value', { timeout: 8000 });

      // Find the "Total Bytes" KPI card
      const totalBytes = await page.$eval('.card', (_, els) => {
        // walk all .card elements and find the one whose .card-title is "Total Bytes"
      }, null).catch(() => null);

      // More reliable: grab all cards and find by label
      const value = await page.evaluate(() => {
        const cards = document.querySelectorAll('.card');
        for (const card of cards) {
          const title = card.querySelector('.card-title');
          const val   = card.querySelector('.card-value');
          if (title && title.textContent.trim() === 'Total Bytes' && val) {
            return val.textContent.trim();
          }
        }
        return null;
      });

      const elapsed = i * 5;
      readings.push({ elapsed, value });

      // Detect decrease
      const prev = readings[readings.length - 2];
      let flag = '';
      if (prev && prev.value && value) {
        const toBytes = s => {
          const n = parseFloat(s);
          if (s.includes('GB')) return n * 1e9;
          if (s.includes('MB')) return n * 1e6;
          if (s.includes('KB')) return n * 1e3;
          return n;
        };
        const prevB = toBytes(prev.value);
        const currB = toBytes(value);
        if (currB < prevB) flag = '  ⚠ DECREASED';
        else if (currB > prevB) flag = '  ▲';
      }

      console.log(`  +${String(elapsed).padStart(2, '0')}s  Total Bytes: ${String(value).padStart(12)}${flag}`);

      if (i < POLLS - 1) await page.waitForTimeout(5000);
    }

    // Print full table
    console.log('\n  ── Summary ──────────────────────────────');
    const decreases = [];
    for (let i = 1; i < readings.length; i++) {
      const toB = s => {
        const n = parseFloat(s);
        if (!s) return 0;
        if (s.includes('GB')) return n * 1e9;
        if (s.includes('MB')) return n * 1e6;
        if (s.includes('KB')) return n * 1e3;
        return n;
      };
      const prev = toB(readings[i - 1].value);
      const curr = toB(readings[i].value);
      if (curr < prev) {
        decreases.push({ at: readings[i].elapsed, from: readings[i-1].value, to: readings[i].value });
        console.log(`  ⚠ DECREASE at +${readings[i].elapsed}s: ${readings[i-1].value} → ${readings[i].value}`);
      }
    }

    if (decreases.length === 0) {
      console.log('  ✓ Total Bytes only increased (or stayed flat) throughout');
    } else {
      console.log(`\n  BUG CONFIRMED: Total Bytes decreased ${decreases.length} time(s)`);
    }

    expect(readings.every(r => r.value !== null)).toBe(true);
  });
});
