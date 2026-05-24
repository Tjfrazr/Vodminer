import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { logger } from '../lib/logger.js';

const PROFILE_DIR = path.resolve('state', 'playwright-profile');
const SCREENSHOT_DIR = path.resolve('state', 'playwright-screenshots');

const CLIP_BUTTON_SELECTORS = [
  'button[data-a-target="player-clip-button"]',
  'button[aria-label="Clip (X)"]',
  'button[aria-label*="Clip" i]',
  'button[title*="Clip" i]',
];

const TITLE_INPUT_SELECTORS = [
  'input[data-a-target="clip-title-input"]',
  'input[placeholder*="title" i]',
  'input[aria-label*="title" i]',
];

const PUBLISH_BUTTON_SELECTORS = [
  'button[data-a-target="clip-edit-publish-button"]',
  'button:has-text("Publish")',
];

let sharedContext = null;

async function getContext({ headless = false } = {}) {
  if (sharedContext) return sharedContext;
  await mkdir(PROFILE_DIR, { recursive: true });
  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return sharedContext;
}

export async function closeContext() {
  if (sharedContext) {
    await sharedContext.close();
    sharedContext = null;
  }
}

async function findFirst(page, selectors, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) return { el, selector: sel };
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function dumpFailure(page, vodId, label) {
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const ts = Date.now();
    const shot = path.join(SCREENSHOT_DIR, `${vodId}-${label}-${ts}.png`);
    const html = path.join(SCREENSHOT_DIR, `${vodId}-${label}-${ts}.html`);
    await page.screenshot({ path: shot, fullPage: false });
    const content = await page.content();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(html, content);
    logger.warn({ shot, html }, 'playwright: dumped failure artifacts');
  } catch (err) {
    logger.warn({ err: err?.message }, 'playwright: failed to dump artifacts');
  }
}

export async function publishClip({ vodId, startSec, endSec, title }, { headless = false } = {}) {
  const ctx = await getContext({ headless });
  const page = await ctx.newPage();

  try {
    const seekTo = Math.max(0, Math.floor(startSec));
    await page.goto(`https://www.twitch.tv/videos/${vodId}?t=${seekTo}s`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForSelector('video', { timeout: 30000 });

    await page.evaluate((t) => {
      const v = document.querySelector('video');
      if (!v) return;
      v.pause();
      v.currentTime = t;
    }, seekTo);
    await page.waitForTimeout(2500);

    const clipBtn = await findFirst(page, CLIP_BUTTON_SELECTORS);
    if (!clipBtn) {
      await dumpFailure(page, vodId, 'no-clip-button');
      throw new Error('clip button not found on player');
    }

    const editorPagePromise = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    await clipBtn.el.click();

    let editorPage = await editorPagePromise;
    if (!editorPage) editorPage = page;
    await editorPage.waitForLoadState('domcontentloaded');
    await editorPage.waitForTimeout(3000);

    const titleInput = await findFirst(editorPage, TITLE_INPUT_SELECTORS);
    if (titleInput) {
      await titleInput.el.fill('');
      await titleInput.el.type(title.slice(0, 100), { delay: 20 });
    } else {
      logger.warn({ vodId }, 'playwright: title input not found, publishing with default');
      await dumpFailure(editorPage, vodId, 'no-title-input');
    }

    const publishBtn = await findFirst(editorPage, PUBLISH_BUTTON_SELECTORS, { timeout: 10000 });
    if (!publishBtn) {
      await dumpFailure(editorPage, vodId, 'no-publish-button');
      throw new Error('publish button not found in clip editor');
    }
    await publishBtn.el.click();

    await editorPage.waitForTimeout(5000);
    const clipUrl = editorPage.url();
    const success = /clips\.twitch\.tv|\/clip\//i.test(clipUrl);

    if (!success) {
      await dumpFailure(editorPage, vodId, 'post-publish');
      logger.warn({ vodId, url: clipUrl }, 'playwright: unexpected URL after publish');
    }

    return { vodId, startSec, endSec, clipUrl, published: success };
  } finally {
    await page.close().catch(() => {});
  }
}

export default publishClip;
