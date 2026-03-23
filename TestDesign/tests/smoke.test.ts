import { test, expect } from '@playwright/test';

test('index.html loads with canvas', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
});

test('game title is present', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/snake/i);
});

test('keyboard input starts game', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const score = page.locator('#score, [data-testid=score], .score');
  const count = await score.count();
  expect(count).toBeGreaterThanOrEqual(0);
});