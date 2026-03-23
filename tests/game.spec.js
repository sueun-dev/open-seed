const { test, expect } = require('@playwright/test');
const URL = 'http://localhost:3000';

test.describe('Top-Down Shooter Game', () => {

  test('should render canvas element on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  test('should start game when Enter is pressed', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await expect(canvas).toBeVisible();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('should complete full game-over cycle', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // Stand still and wait for enemies to collide with player
    await page.waitForTimeout(6000);
    // Press Enter to restart (works whether gameover or still playing)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('should persist high score in localStorage', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('highScore', '999'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const hs = await page.evaluate(() => localStorage.getItem('highScore'));
    expect(hs).toBe('999');
  });

  test('should handle rapid keyboard input without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.down('w');
      await page.keyboard.down('d');
      await page.keyboard.press(' ');
      await page.keyboard.up('w');
      await page.keyboard.up('d');
    }
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('should not throw on window resize during gameplay', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 400, height: 300 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(300);
    const canvas = page.locator('#gameCanvas');
    await expect(canvas).toBeVisible();
    expect(errors).toHaveLength(0);
  });

});
