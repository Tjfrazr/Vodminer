import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const PROFILE_DIR = path.resolve('state', 'playwright-profile');

async function main() {
  console.log('--- Twitch login (saves session for future Playwright runs) ---\n');
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log('A Chromium window will open. Log in to Twitch normally.');
  console.log('Once you see the Twitch homepage as a logged-in user, close the browser window.\n');

  await mkdir(PROFILE_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.twitch.tv/login', { waitUntil: 'domcontentloaded' });

  console.log('[waiting] Close the browser window once logged in.');
  await new Promise((resolve) => ctx.on('close', resolve));
  console.log('\nSession saved to profile dir. You can now run scripts that use clipPublisher.');
  process.exit(0);
}

main().catch((err) => {
  console.error('login failed:', err);
  process.exit(1);
});
