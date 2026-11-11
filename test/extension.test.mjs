// Integration test: load the unpacked extension in a real Chromium instance,
// verify the content script/styles on PR and issue URLs, and exercise the popup
// settings panel (chrome.storage -> live content-script update).
//
// Requires a Chromium/Chrome for Testing build that still supports
// --load-extension (Chromium and Chrome for Testing do). Set CHROME_PATH if the
// default is not the right binary.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PR_URL = 'https://git.genarrative.world/git/test/demo/pulls/1';
const ISSUE_URL = 'https://git.genarrative.world/git/test/demo/issues/2';
const FIXTURE = fileURLToPath(new URL('./fixtures/pr-conversation.html', import.meta.url));
const EXTENSION_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-for-testing',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('No Chromium binary found. Set CHROME_PATH.');
}

// Chrome derives the ID of an unpacked extension from the SHA-256 of its path.
function extensionIdForPath(path) {
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

async function timelineOrder(page) {
  return page.evaluate(() =>
    [...document.querySelector('.ui.timeline').children].map((node) => node.id || node.className)
  );
}

async function groupState(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.timeline-item-group')].map((group) => {
      const body = group.querySelector(':scope > .timeline-item.comment');
      const toggle = group.querySelector('.gp-toggle');
      return {
        id: group.id,
        collapsed: group.classList.contains('gp-collapsed'),
        bodyDisplay: body ? getComputedStyle(body).display : null,
        toggleCount: group.querySelectorAll('.gp-toggle').length,
        toggleBorder: toggle ? getComputedStyle(toggle).borderTopWidth : null,
        toggleLabel: toggle?.querySelector('.gp-toggle-label')?.textContent ?? '',
      };
    })
  );
}

const executablePath = await findChrome();
const profileDir = await mkdtemp(join(tmpdir(), 'gp-extension-test-'));
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
  ],
});

try {
  await context.route(PR_URL, (route) =>
    route.fulfill({ path: FIXTURE, contentType: 'text/html' })
  );
  await context.route(ISSUE_URL, (route) =>
    route.fulfill({ path: FIXTURE, contentType: 'text/html' })
  );

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(PR_URL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // Default settings: reverse timeline + collapse older reviews.
  assert.deepEqual(await timelineOrder(page), [
    'issue-1',
    'merge-box',
    'issuecomment-10',
    'issuecomment-8',
    'issuecomment-7',
    'issuecomment-5',
    'issuecomment-4',
    'issuecomment-2',
    'timeline-comments-end',
    'login-warning',
  ]);

  const state = await groupState(page);
  assert.deepEqual(
    state.map((item) => item.id),
    ['issuecomment-10', 'issuecomment-7', 'issuecomment-4']
  );
  assert.deepEqual(
    state.map((item) => item.collapsed),
    [false, true, true]
  );
  assert.equal(state[0].bodyDisplay, 'block');
  assert.equal(state[1].bodyDisplay, 'none');
  assert.equal(state[1].toggleBorder, '1px', 'content.css should be injected');
  assert.equal(state[1].toggleLabel, '展开评审意见');

  await page.locator('.timeline-item-group').first().locator('.gp-toggle').click();
  assert.equal(
    await page
      .locator('.timeline-item-group')
      .first()
      .evaluate((group) => group.classList.contains('gp-collapsed')),
    true
  );

  // Issue pages get the reverse treatment but no review controls.
  const issuePage = await context.newPage();
  await issuePage.goto(ISSUE_URL, { waitUntil: 'load' });
  await issuePage.waitForTimeout(800);
  assert.equal((await timelineOrder(issuePage))[0], 'issue-1');
  assert.equal((await timelineOrder(issuePage))[1], 'merge-box');
  assert.equal((await timelineOrder(issuePage))[2], 'issuecomment-10');
  assert.equal(await issuePage.locator('.gp-toggle').count(), 0);
  await issuePage.close();

  // Popup settings panel: defaults checked, unchecking applies live.
  const extensionId = extensionIdForPath(EXTENSION_DIR);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#reverseTimeline')?.checked === true);
  assert.equal(await popup.locator('#collapseReviews').isChecked(), true);
  assert.equal(await popup.locator('#reverseTimeline').isChecked(), true);

  await popup.locator('#reverseTimeline').uncheck();
  await page.waitForTimeout(400);
  assert.deepEqual(await timelineOrder(page), [
    'issue-1',
    'issuecomment-2',
    'issuecomment-4',
    'issuecomment-5',
    'issuecomment-7',
    'issuecomment-8',
    'issuecomment-10',
    'merge-box',
    'timeline-comments-end',
    'login-warning',
  ]);

  await popup.locator('#collapseReviews').uncheck();
  await page.waitForTimeout(400);
  const expanded = await groupState(page);
  assert.deepEqual(
    expanded.map((item) => item.toggleCount),
    [0, 0, 0]
  );
  assert.deepEqual(
    expanded.map((item) => item.bodyDisplay),
    ['block', 'block', 'block']
  );

  await popup.locator('#reverseTimeline').check();
  await page.waitForTimeout(400);
  assert.equal((await timelineOrder(page))[1], 'merge-box');
  assert.equal((await timelineOrder(page))[2], 'issuecomment-10');

  await popup.locator('#reset').click();
  await page.waitForTimeout(400);
  assert.equal(await popup.locator('#collapseReviews').isChecked(), true);
  assert.equal(await popup.locator('#reverseTimeline').isChecked(), true);
  assert.equal(await popup.locator('#patternCollapse').isChecked(), true);
  assert.equal(await popup.locator('.rule').count(), 1);
  assert.equal(await popup.locator('.rule-name').inputValue(), 'low');
  assert.equal(
    await popup.locator('.rule-pattern').inputValue(),
    '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?'
  );
  const resetState = await groupState(page);
  assert.deepEqual(
    resetState.map((item) => item.collapsed),
    [false, true, true]
  );
  assert.ok(resetState.every((item) => item.toggleCount === 1));

  // Named rules from the popup hide whole comment cards and add page filters.
  await popup.locator('.rule-pattern').first().fill('^普通讨论');
  await page.waitForTimeout(600);
  const hiddenCards = () =>
    page.evaluate(() =>
      ['issuecomment-2', 'issuecomment-5', 'issuecomment-8'].map((id) => ({
        hidden: document.getElementById(id).classList.contains('gp-rule-hidden'),
        display: getComputedStyle(document.getElementById(id)).display,
      }))
    );
  assert.deepEqual(await hiddenCards(), [
    { hidden: true, display: 'none' },
    { hidden: true, display: 'none' },
    { hidden: true, display: 'none' },
  ]);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 1);
  assert.deepEqual(
    await page.locator('.gp-rule-filter span').allTextContents(),
    ['显示low']
  );

  await page.locator('.gp-rule-toolbar input').check();
  await page.waitForTimeout(150);
  assert.deepEqual(await hiddenCards(), [
    { hidden: false, display: 'block' },
    { hidden: false, display: 'block' },
    { hidden: false, display: 'block' },
  ]);
  await page.locator('.gp-rule-toolbar input').uncheck();
  await page.waitForTimeout(150);
  assert.deepEqual(await hiddenCards(), [
    { hidden: true, display: 'none' },
    { hidden: true, display: 'none' },
    { hidden: true, display: 'none' },
  ]);

  await popup.locator('.rule-name').first().fill('低优先级');
  await page.waitForTimeout(500);
  assert.deepEqual(
    await page.locator('.gp-rule-filter span').allTextContents(),
    ['显示低优先级']
  );

  await popup.locator('#patternCollapse').uncheck();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.gp-rule-hidden').count(), 0);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);
  assert.deepEqual(await hiddenCards(), [
    { hidden: false, display: 'block' },
    { hidden: false, display: 'block' },
    { hidden: false, display: 'block' },
  ]);

  await popup.locator('#patternCollapse').check();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.gp-rule-hidden').count(), 3);
  assert.deepEqual(
    await page.locator('.gp-rule-filter span').allTextContents(),
    ['显示低优先级']
  );

  await popup.locator('#reset').click();
  await page.waitForTimeout(400);
  assert.equal(await popup.locator('#patternCollapse').isChecked(), true);
  assert.equal(await popup.locator('.rule').count(), 1);
  assert.equal(await popup.locator('.rule-name').inputValue(), 'low');
  assert.equal(await page.locator('.gp-rule-hidden').count(), 0);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);

  // Adding and removing named rules keeps the list editable.
  await popup.locator('#addRule').click();
  await page.waitForTimeout(300);
  assert.equal(await popup.locator('.rule').count(), 2);
  assert.equal(await popup.locator('.rule-name').nth(1).inputValue(), '规则 2');
  await popup.locator('.rule-remove').nth(1).click();
  await page.waitForTimeout(300);
  assert.equal(await popup.locator('.rule').count(), 1);

  // A matching review body gets its own filter in that review section.
  await popup.locator('.rule-pattern').first().fill('^第三轮');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);
  assert.equal(await page.locator('.gp-rule-event-filter').count(), 1);
  assert.deepEqual(
    await page.locator('.gp-rule-event-filter span').allTextContents(),
    ['显示low']
  );
  const reviewBody = page.locator(
    '#issuecomment-10 > .timeline-item.comment'
  );
  assert.equal(
    await reviewBody.evaluate((element) => getComputedStyle(element).display),
    'none'
  );
  const reviewFilter = page.locator(
    '#issuecomment-10 > .timeline-item.event > .gp-rule-event-filter input'
  );
  await reviewFilter.check();
  await page.waitForTimeout(150);
  assert.equal(
    await reviewBody.evaluate((element) => getComputedStyle(element).display),
    'block'
  );
  await reviewFilter.uncheck();
  await page.waitForTimeout(150);
  assert.equal(
    await reviewBody.evaluate((element) => getComputedStyle(element).display),
    'none'
  );

  // Upgrade path: an existing 0.3.x commentPattern becomes one named rule.
  await popup.evaluate(async () => {
    await chrome.storage.sync.remove('commentRules');
    await chrome.storage.sync.set({
      commentPattern: '^普通讨论',
      patternCollapse: true,
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.gp-rule-hidden').count(), 3);
  assert.deepEqual(
    await page.locator('.gp-rule-filter span').allTextContents(),
    ['显示low']
  );

  await popup.close();
  console.log('ok - unpacked extension, reverse timeline, and popup settings work');
} finally {
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
}
