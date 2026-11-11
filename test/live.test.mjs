// Optional smoke test against a real Gitea instance. It injects the content
// script and stylesheet directly (no extension load), which makes it useful for
// checking that the DOM selectors still match after a Gitea upgrade.
//
//   GP_TEST_URL='https://git.genarrative.world/git/<owner>/<repo>/pulls/<n>' \
//   GP_STORAGE_STATE=/path/to/storage-state.json \
//   node test/live.test.mjs

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const url = process.env.GP_TEST_URL;
if (!url) {
  console.error('Set GP_TEST_URL to a pull request or issue conversation URL.');
  process.exit(2);
}

const executablePath = process.env.CHROME_PATH || '/usr/bin/chromium';
const storageState = process.env.GP_STORAGE_STATE;
const CONTENT_CSS = fileURLToPath(new URL('../src/content.css', import.meta.url));
const CONTENT_JS = fileURLToPath(new URL('../src/content.js', import.meta.url));

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(storageState ? { storageState } : {}),
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

// The content script reads chrome.storage.sync; provide the defaults in the
// page world because this test injects the script directly.
await page.evaluate(() => {
  const settings = {
    collapseReviews: true,
    reverseTimeline: true,
    patternCollapse: true,
    commentRules: [
      {
        id: 'rule-low',
        name: 'low',
        pattern: '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?',
      },
    ],
  };
  window.chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, ...settings }) },
      onChanged: { addListener() {} },
    },
  };
});

await page.addStyleTag({ path: CONTENT_CSS });
await page.addScriptTag({ path: CONTENT_JS });
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
  const timeline = document.querySelector('.ui.timeline');
  const children = timeline ? [...timeline.children] : [];
  const description = children.find(
    (node) => node.matches('.timeline-item.comment.first') || /^issue-\d+$/.test(node.id)
  );
  const mergeBox = children.find((node) => node.classList.contains('pull-merge-box'));
  const conversationIds = children
    .filter(
      (node) =>
        (node.classList.contains('timeline-item') ||
          node.classList.contains('timeline-item-group')) &&
        node !== description &&
        !node.classList.contains('pull-merge-box') &&
        node.id !== 'timeline-comments-end'
    )
    .map((node) => {
      const match = /^issuecomment-(\d+)$/.exec(node.id);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => value !== null);

  return {
    descriptionFirst: Boolean(description && children[0] === description),
    conversationIds,
    groups: [...document.querySelectorAll('.timeline-item-group')].map((group) => {
      const event = group.querySelector(':scope > .timeline-item.event');
      const badge = event?.querySelector(':scope > .badge');
      const isReview = Boolean(
        (badge && badge.classList.contains('tw-text-white')) ||
          (group.querySelector(':scope > .timeline-item.event.code-comments-list') &&
            !(badge && badge.classList.contains('grey')))
      );
      return {
        id: group.id,
        isReview,
        hasContent: Boolean(
          group.querySelector(':scope > .timeline-item.comment') ||
            group.querySelector(':scope > .timeline-item.event.code-comments-list')
        ),
        collapsed: group.classList.contains('gp-collapsed'),
        toggle: Boolean(group.querySelector('.gp-toggle')),
        badge: Number(group.querySelector('.gp-toggle .gp-count')?.textContent || 0),
        visibleComments: [
          ...group.querySelectorAll('.comment.code-comment'),
        ].filter((comment) => {
          const cloud = comment.closest('.comment-code-cloud');
          return (
            (!cloud || !cloud.classList.contains('tw-hidden')) &&
            !comment.classList.contains('gp-rule-hidden') &&
            !comment.closest('.gp-rule-hidden') &&
            !comment.closest('.gp-rule-empty')
          );
        }).length,
      };
    }),
    isPull: /\/pulls\/\d+\/?$/.test(location.pathname),
    mergeBoxIndex: mergeBox ? children.indexOf(mergeBox) : -1,
    ruleHidden: [...document.querySelectorAll('.gp-rule-hidden')].map((comment) => ({
      id: comment.id,
      display: getComputedStyle(comment).display,
    })),
    ruleToolbar: Boolean(document.querySelector('.gp-rule-toolbar')),
    groupFilters: document.querySelectorAll('.gp-rule-event-filter').length,
  };
});

assert.equal(result.descriptionFirst, true, 'description should stay first');
if (result.isPull && result.mergeBoxIndex >= 0) {
  assert.equal(
    result.mergeBoxIndex,
    1,
    'the merge box should follow the description when reversed'
  );
}
assert.ok(
  result.ruleHidden.every((comment) => comment.display === 'none'),
  `rule-matched cards should be hidden: ${JSON.stringify(result.ruleHidden)}`
);
if (result.ruleHidden.length > 0) {
  assert.ok(
    result.ruleToolbar || result.groupFilters > 0,
    'hidden rules should get a page or per-review filter'
  );
}
assert.ok(
  result.conversationIds.every(
    (value, index) => index === 0 || result.conversationIds[index - 1] >= value
  ),
  `timeline should be newest-first, got ${result.conversationIds.join(', ')}`
);

if (result.isPull) {
  const reviewGroups = result.groups.filter((group) => group.isReview && group.hasContent);
  assert.ok(reviewGroups.length > 0, 'no review rounds found on the page');
  assert.ok(
    reviewGroups.every((group) => group.toggle),
    'every review round with content should get a toggle'
  );

  const latest = reviewGroups.reduce((newest, group) => {
    const current = Number(/^issuecomment-(\d+)$/.exec(group.id)?.[1] ?? 0);
    const best = Number(/^issuecomment-(\d+)$/.exec(newest.id)?.[1] ?? 0);
    return current > best ? group : newest;
  });
  assert.ok(
    reviewGroups.every((group) => group.badge === group.visibleComments),
    `review badges should count visible threads: ${JSON.stringify(
      reviewGroups.map((group) => ({ id: group.id, badge: group.badge, visible: group.visibleComments }))
    )}`
  );
  assert.equal(latest.collapsed, false, 'the newest review round should stay expanded');
  for (const group of reviewGroups) {
    if (group === latest) continue;
    assert.equal(group.collapsed, true, `${group.id} should be collapsed`);
  }
  console.log(`ok - ${reviewGroups.length} review round(s) checked on ${url}`);
} else {
  assert.equal(
    result.groups.some((group) => group.toggle),
    false,
    'issue pages should not get review toggles'
  );
  console.log(`ok - issue timeline checked on ${url}`);
}

await context.close();
await browser.close();
