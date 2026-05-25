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
  'button:has-text("Save Clip")',
  'button[data-a-target="clip-edit-publish-button"]',
  'button:has-text("Publish")',
];

const EDITOR_MODAL_SELECTOR = '[aria-label="Clip Creation Popup"]';
const POST_PUBLISH_SELECTOR = '[aria-label="Copy clip link button"]';

const RESIZE_PORTRAIT_SELECTORS = [
  '[aria-label="Resize Portrait Version to Fit"]',
  '[title="Resize Portrait Version to Fit"]',
  'button[aria-label*="Resize Portrait" i]',
  'button[title*="Resize Portrait" i]',
];

const TIKTOK_SHARE_SELECTORS = [
  'button[aria-label*="TikTok" i]',
  'button[title*="TikTok" i]',
  'a[aria-label*="TikTok" i]',
  '[data-a-target*="tiktok" i]',
];

const SEND_DRAFT_TIKTOK_SELECTORS = [
  'button:has-text("Send Draft to TikTok")',
  'button[aria-label*="Send Draft to TikTok" i]',
];

const CLIP_EDITOR_SLIDER_SELECTOR = '[aria-label="Clip Editor Slider"]';
const CLIP_START_HANDLE_SELECTOR = '[aria-label="Clip Start Time"]';
const CLIP_END_HANDLE_SELECTOR = '[aria-label="Clip End Time"]';
const TIKTOK_EXPAND_TOGGLE_SELECTOR = 'button[aria-label="Export clip to tiktok"]';

function parseValueTextDuration(text) {
  // Format example: "1:00 to 1:30"
  const m = /(\d+):(\d{2})\s+to\s+(\d+):(\d{2})/.exec(text || '');
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return { start, end, durationSec: end - start };
}

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

async function readSliderDuration(page) {
  const slider = await page.$(CLIP_EDITOR_SLIDER_SELECTOR);
  if (!slider) return null;
  const valueText = await slider.getAttribute('aria-valuetext');
  return parseValueTextDuration(valueText);
}

async function dragHandle(page, handle, targetX) {
  const box = await handle.boundingBox();
  if (!box) return false;
  const sourceX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(sourceX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 25 });
  await page.mouse.up();
  return true;
}

async function extendClipDuration(page, targetDurationSec, vodId) {
  const slider = await page.$(CLIP_EDITOR_SLIDER_SELECTOR);
  if (!slider) {
    logger.warn({ vodId }, 'playwright: Clip Editor Slider not found');
    await dumpFailure(page, vodId, 'no-clip-editor-slider');
    return false;
  }
  const sliderBox = await slider.boundingBox();
  if (!sliderBox) return false;

  const before = await readSliderDuration(page);
  if (before && before.durationSec >= targetDurationSec) {
    logger.info({ vodId, currentSec: before.durationSec, targetDurationSec }, 'playwright: slider already at/past target');
    return true;
  }

  const startHandle = await page.$(CLIP_START_HANDLE_SELECTOR);
  const endHandle = await page.$(CLIP_END_HANDLE_SELECTOR);
  if (!startHandle || !endHandle) {
    logger.warn({ vodId, startHandle: !!startHandle, endHandle: !!endHandle }, 'playwright: trim handles not found');
    await dumpFailure(page, vodId, 'no-trim-handles');
    return false;
  }

  const leftTarget = sliderBox.x - 400;
  const rightTarget = sliderBox.x + sliderBox.width + 400;

  try {
    let prev = before?.durationSec ?? 30;
    for (let pass = 0; pass < 6; pass += 1) {
      if (prev >= targetDurationSec) break;
      await dragHandle(page, endHandle, rightTarget);
      await page.waitForTimeout(250);
      await dragHandle(page, startHandle, leftTarget);
      await page.waitForTimeout(250);
      const now = await readSliderDuration(page);
      const nowSec = now?.durationSec ?? prev;
      if (nowSec <= prev) break;
      prev = nowSec;
    }
    // Dismiss drag tooltip portals + max-length alert that block subsequent clicks.
    await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y - 200).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      for (const p of document.querySelectorAll('.ReactModalPortal')) {
        if (!p.querySelector('[aria-label="Clip Creation Popup"]')) p.remove();
      }
      const alert = document.getElementById('CLIP_EDITOR_ALERT_BOX_ID');
      if (alert) alert.remove();
    }).catch(() => {});
    await page.waitForTimeout(200);
    const after = await readSliderDuration(page);
    logger.info(
      { vodId, before: before?.durationSec, after: after?.durationSec, targetDurationSec },
      'playwright: dragged trim handles outward',
    );
    return true;
  } catch (err) {
    logger.warn({ vodId, err: err?.message }, 'playwright: slider drag failed');
    return false;
  }
}

async function shareToTikTok(page, vodId) {
  const tiktokBtn = await findFirst(page, TIKTOK_SHARE_SELECTORS, { timeout: 8000 });
  if (!tiktokBtn) {
    logger.warn({ vodId }, 'playwright: TikTok share icon not found');
    await dumpFailure(page, vodId, 'no-tiktok-share-icon');
    return false;
  }
  await tiktokBtn.el.evaluate((el) => el.click());
  await page.waitForTimeout(1000);

  // Ensure the TikTok section in the Export Clip dialog is expanded.
  const toggle = await page.$(TIKTOK_EXPAND_TOGGLE_SELECTOR);
  if (toggle) {
    const wrapper = await toggle.evaluateHandle((el) => el.closest('[aria-expanded]'));
    const expanded = wrapper ? await wrapper.evaluate((el) => el.getAttribute('aria-expanded')) : null;
    if (expanded !== 'true') {
      await toggle.evaluate((el) => el.click());
      await page.waitForTimeout(800);
    }
  }

  const sendDraftBtn = await findFirst(page, SEND_DRAFT_TIKTOK_SELECTORS, { timeout: 12000 });
  if (!sendDraftBtn) {
    logger.warn({ vodId }, 'playwright: "Send Draft to TikTok" button not found');
    await dumpFailure(page, vodId, 'no-send-draft-button');
    return false;
  }
  await sendDraftBtn.el.evaluate((el) => el.click());
  logger.info({ vodId }, 'playwright: TikTok draft submitted');
  await page.waitForTimeout(3000);
  return true;
}

export async function publishClip({ vodId, startSec, endSec, title }, { headless = false, skipTikTok = false } = {}) {
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

    const editorPagePromise = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await clipBtn.el.click();

    let editorPage = await editorPagePromise;
    if (!editorPage) editorPage = page;
    await editorPage.waitForLoadState('domcontentloaded');
    await editorPage.waitForSelector(EDITOR_MODAL_SELECTOR, { timeout: 10000 }).catch(() => null);
    await editorPage.waitForTimeout(1500);

    const targetDurationSec = Math.max(0, Math.floor(endSec - startSec));
    await extendClipDuration(editorPage, targetDurationSec, vodId);

    const titleInput = await findFirst(editorPage, TITLE_INPUT_SELECTORS);
    if (titleInput) {
      // Set via React-friendly DOM call to bypass any drag-tooltip portal overlays.
      await titleInput.el.evaluate((el, value) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, title.slice(0, 100));
    } else {
      logger.warn({ vodId }, 'playwright: title input not found, publishing with default');
      await dumpFailure(editorPage, vodId, 'no-title-input');
    }

    const resizeBtn = await findFirst(editorPage, RESIZE_PORTRAIT_SELECTORS, { timeout: 4000 });
    if (resizeBtn) {
      await resizeBtn.el.evaluate((el) => el.click());
      await editorPage.waitForTimeout(500);
    } else {
      logger.warn({ vodId }, 'playwright: "Resize Portrait Version to Fit" not found; portrait will use default crop');
    }

    const publishBtn = await findFirst(editorPage, PUBLISH_BUTTON_SELECTORS, { timeout: 10000 });
    if (!publishBtn) {
      await dumpFailure(editorPage, vodId, 'no-publish-button');
      throw new Error('publish button not found in clip editor');
    }
    // Some drag-tooltip portals stay mounted and intercept pointer events.
    // Use a DOM-level click that bypasses Playwright's pointer-overlay check.
    await publishBtn.el.evaluate((el) => el.click());

    const confirmBtn = await findFirst(editorPage, [
      'button:has-text("Save Without Editing")',
      'button[aria-label*="Save Without Editing" i]',
    ], { timeout: 4000 });
    if (confirmBtn) {
      logger.info({ vodId }, 'playwright: confirming save-without-portrait-edit dialog');
      await confirmBtn.el.evaluate((el) => el.click());
    }

    let success = false;
    try {
      await editorPage.waitForSelector(POST_PUBLISH_SELECTOR, { timeout: 20000 });
      success = true;
    } catch {
      await dumpFailure(editorPage, vodId, 'no-post-publish-signal');
    }

    let tiktokDraftSent = false;
    if (success && !skipTikTok) {
      tiktokDraftSent = await shareToTikTok(editorPage, vodId);
    }

    // The editor opens as a modal overlay so editorPage.url() stays as the VOD URL.
    // After saving, Twitch renders the real clip URL in a link/input on the page.
    // Start as null so callers get null (not the VOD URL) when extraction fails.
    let clipUrl = null;
    if (success) {
      await editorPage.waitForTimeout(1500);
      try {
        const extracted = await editorPage.evaluate(() => {
          // Anchor link
          const a = document.querySelector('a[href*="clips.twitch.tv"]');
          if (a) return a.href;
          // Input field
          const inp = Array.from(document.querySelectorAll('input'))
            .find((el) => el.value?.includes('clips.twitch.tv'));
          if (inp) return inp.value;
          // Input near the "Copy clip link" button
          const copyBtn = document.querySelector('[aria-label="Copy clip link button"]');
          if (copyBtn) {
            const container = copyBtn.closest('[class]') || copyBtn.parentElement;
            if (container) {
              const nearInp = container.querySelector('input');
              if (nearInp?.value?.includes('clips.twitch.tv')) return nearInp.value;
            }
          }
          // Any element whose textContent matches a Twitch clips URL
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const m = node.textContent.match(/https:\/\/clips\.twitch\.tv\/\S+/);
            if (m) return m[0];
          }
          return null;
        });
        if (extracted) {
          clipUrl = extracted;
          logger.info({ vodId, clipUrl }, 'playwright: extracted clip URL');
        } else {
          logger.warn({ vodId }, 'playwright: could not extract clip URL from page');
        }
      } catch (err) {
        logger.warn({ err: err?.message, vodId }, 'playwright: clip URL extraction failed');
      }
    }
    return { vodId, startSec, endSec, clipUrl, published: success, tiktokDraftSent };
  } finally {
    await page.close().catch(() => {});
  }
}

export default publishClip;
