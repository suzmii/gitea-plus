// Behavior tests for src/content.js. Run with `npm test` after `npm install`.
// The fixture mirrors the DOM produced by Gitea 1.26.x for a PR conversation
// with three review rounds.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const FIXTURE = fileURLToPath(new URL('./fixtures/pr-conversation.html', import.meta.url));
const CONTENT_CSS = fileURLToPath(new URL('../src/content.css', import.meta.url));
const CONTENT_JS = fileURLToPath(new URL('../src/content.js', import.meta.url));
const PR_URL = 'https://git.genarrative.world/git/test/demo/pulls/1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  headless: true,
});

const TEST_DEFAULTS = Object.freeze({
  collapseReviews: true,
  reverseTimeline: false,
  patternCollapse: true,
  commentRules: [
    {
      id: 'rule-low',
      name: 'low',
      pattern: '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?',
    },
  ],
});

async function openPage(hash = '', lang = 'zh-CN', overrides = {}, url = PR_URL) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(url, (route) =>
    route.fulfill({ path: FIXTURE, contentType: 'text/html' })
  );
  const page = await context.newPage();
  await page.goto(url + hash, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ value, settings }) => {
      document.documentElement.lang = value;
      const current = { ...settings };
      const listeners = [];
      window.chrome = {
        storage: {
          sync: {
            get: async (defaults) => ({ ...defaults, ...current }),
            set: async (next) => {
              Object.assign(current, next);
            },
          },
          onChanged: {
            addListener: (listener) => listeners.push(listener),
          },
        },
      };
      window.__gpApplySettings = (next) => {
        const changes = {};
        for (const [key, value] of Object.entries(next)) {
          changes[key] = { oldValue: current[key], newValue: value };
          current[key] = value;
        }
        for (const listener of listeners) listener(changes, 'sync');
      };
    },
    { value: lang, settings: { ...TEST_DEFAULTS, ...overrides } }
  );
  await page.addStyleTag({ path: CONTENT_CSS });
  await page.addScriptTag({ path: CONTENT_JS });
  await page.waitForTimeout(160);
  return { page, context };
}

async function timelineOrder(page) {
  return page.evaluate(() =>
    [...document.querySelector('.ui.timeline').children].map((node) => node.id || node.className)
  );
}

function groupState(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.timeline-item-group')].map((group) => {
      const body = group.querySelector(':scope > .timeline-item.comment');
      const code = group.querySelector(':scope > .timeline-item.event.code-comments-list');
      const toggle = group.querySelector(':scope > .timeline-item.event > .gp-toggle');
      return {
        id: group.id,
        ready: group.hasAttribute('data-gp-ready'),
        collapsed: group.classList.contains('gp-collapsed'),
        user: group.getAttribute('data-gp-user') === '1',
        bodyDisplay: body ? getComputedStyle(body).display : null,
        codeDisplay: code ? getComputedStyle(code).display : null,
        toggleCount: group.querySelectorAll('.gp-toggle').length,
        label: toggle?.querySelector('.gp-toggle-label')?.textContent ?? '',
        count: toggle?.querySelector('.gp-count')?.textContent ?? '',
        ariaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
        ariaControls: toggle?.getAttribute('aria-controls') ?? '',
        ariaLabel: toggle?.getAttribute('aria-label') ?? '',
      };
    })
  );
}

function assertInitialState(states) {
  assert.equal(states.length, 3);
  assert.deepEqual(
    states.map((s) => s.collapsed),
    [true, true, false]
  );
  for (const state of states.slice(0, 2)) {
    assert.equal(state.ready, true, `${state.id} should be initialized`);
    assert.equal(state.bodyDisplay, 'none', `${state.id} review body should be hidden`);
    assert.equal(state.codeDisplay, 'none', `${state.id} inline comments should be hidden`);
    assert.equal(state.ariaExpanded, 'false');
    assert.equal(state.toggleCount, 1);
    assert.equal(state.count, '1');
    assert.ok(state.ariaControls.includes('gp-body-'), 'body should have an id');
    assert.ok(state.ariaControls.includes('gp-comments-'), 'comment list should have an id');
  }
  const latest = states[2];
  assert.equal(latest.bodyDisplay, 'block');
  assert.equal(latest.codeDisplay, 'block');
  assert.equal(latest.ariaExpanded, 'true');
  assert.equal(latest.label, '收起评审意见');
}

// 1. Default state: every round except the newest is collapsed.
{
  const { page, context } = await openPage();
  assertInitialState(await groupState(page));
  await context.close();
  console.log('ok - collapses earlier rounds and keeps the latest expanded');
}

// 2. Toggles expand and collapse a round.
{
  const { page, context } = await openPage();
  const first = page.locator('.timeline-item-group').first();
  await first.locator('.gp-toggle').click();
  let states = await groupState(page);
  assert.equal(states[0].collapsed, false);
  assert.equal(states[0].bodyDisplay, 'block');
  assert.equal(states[0].codeDisplay, 'block');
  assert.equal(states[0].ariaExpanded, 'true');
  assert.equal(states[0].label, '收起评审意见');

  await page.locator('.timeline-item-group').last().locator('.gp-toggle').click();
  states = await groupState(page);
  assert.equal(states[2].collapsed, true);
  assert.equal(states[2].bodyDisplay, 'none');
  assert.equal(states[2].ariaExpanded, 'false');
  await context.close();
  console.log('ok - toggles expand and collapse individually');
}

// 3. A hash pointing into an older round opens it instead of hiding it.
{
  const { page, context } = await openPage('#issuecomment-3');
  const states = await groupState(page);
  assert.equal(states[0].collapsed, false);
  assert.equal(states[0].bodyDisplay, 'block');
  assert.equal(states[0].user, true);
  assert.equal(states[1].collapsed, true);
  await context.close();
  console.log('ok - hash anchor expands the round containing the targeted comment');
}

// 4. When a newer review arrives, the previous newest round collapses and the
//    new one becomes the expanded latest.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.timeline-item-group')];
    const latest = groups[groups.length - 1];
    const clone = latest.cloneNode(true);
    clone.id = 'issuecomment-99';
    clone.querySelectorAll('[id]').forEach((node) => {
      node.id = node.id + '-copy';
    });
    clone.classList.remove('gp-collapsed');
    clone.querySelectorAll('.gp-toggle').forEach((node) => node.remove());
    clone.removeAttribute('data-gp-ready');
    latest.after(clone);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.deepEqual(
    states.map((s) => s.collapsed),
    [true, true, true, false]
  );
  assert.equal(states[3].ready, true);
  assert.equal(states[3].bodyDisplay, 'block');
  await context.close();
  console.log('ok - new review round becomes the only expanded one');
}

// 5. Re-evaluating the script does not add duplicate toggles.
{
  const { page, context } = await openPage();
  await page.addScriptTag({ path: CONTENT_JS });
  await page.waitForTimeout(100);
  const states = await groupState(page);
  assert.deepEqual(
    states.map((s) => s.toggleCount),
    [1, 1, 1]
  );
  await context.close();
  console.log('ok - guard prevents duplicate initialization');
}

// 6. Non-conversation pages (files tab) are left untouched.
{
  const context = await browser.newContext();
  await context.route(PR_URL + '/files', (route) =>
    route.fulfill({ path: FIXTURE, contentType: 'text/html' })
  );
  const page = await context.newPage();
  await page.goto(PR_URL + '/files', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: CONTENT_JS });
  await page.waitForTimeout(100);
  const count = await page.locator('.gp-toggle').count();
  assert.equal(count, 0);
  await context.close();
  console.log('ok - does nothing on the files tab');
}

// 7. An empty review event (approve without body/inline comments) does not
//    become the "latest review" and is left untouched.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'empty-review';
    group.innerHTML =
      '<div class="timeline-item event">' +
      '<span class="badge tw-text-white"></span>' +
      '<span class="comment-text-line">testuser 评审</span></div>';
    document.querySelector('.ui.timeline').appendChild(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states.length, 4);
  assert.equal(states[3].toggleCount, 0);
  assert.equal(states[3].ready, false);
  assert.equal(states[2].collapsed, false);
  await context.close();
  console.log('ok - empty review events are ignored');
}

// 8. A review with only inline comments becomes the latest expanded round.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'inline-only-review';
    group.innerHTML =
      '<div class="timeline-item event">' +
      '<span class="badge tw-text-white"></span>' +
      '<span class="comment-text-line">testuser 评审</span></div>' +
      '<div class="timeline-item event code-comments-list">' +
      '<div class="ui comments"><div class="comment code-comment">只有行内意见</div></div></div>';
    document.querySelector('.ui.timeline').appendChild(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states.length, 4);
  assert.equal(states[2].collapsed, true);
  assert.equal(states[3].collapsed, false);
  assert.equal(states[3].toggleCount, 1);
  assert.equal(states[3].bodyDisplay, null);
  assert.equal(states[3].codeDisplay, 'block');
  await context.close();
  console.log('ok - inline-only review becomes the expanded latest round');
}

// 9. A dismissed review keeps the white badge and is folded like any other
//    older review round.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'dismissed-review';
    group.innerHTML =
      '<div class="timeline-item event">' +
      '<span class="badge tw-text-white"></span>' +
      '<span class="comment-text-line">testuser 评审</span>' +
      '<div class="ui small label">已驳回</div></div>' +
      '<div class="timeline-item comment"><div class="content comment-container">' +
      '<div class="ui attached segment comment-body">' +
      '<div class="render-content markup"><p>已被驳回的评审正文</p></div></div></div></div>';
    document.querySelector('.timeline-item-group').after(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states.length, 4);
  assert.equal(states[1].collapsed, true);
  assert.equal(states[1].bodyDisplay, 'none');
  assert.equal(states[1].toggleCount, 1);
  assert.equal(states[3].collapsed, false);
  await context.close();
  console.log('ok - dismissed reviews are folded as normal review rounds');
}

// 10. The separate dismissal event (grey badge + reason body) is ignored.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'dismiss-event';
    group.innerHTML =
      '<div class="timeline-item event">' +
      '<span class="badge grey"></span>' +
      '<span class="comment-text-line">testuser 驳回了一条评审</span></div>' +
      '<div class="timeline-item comment"><div class="content comment-container">' +
      '<div class="ui attached segment comment-body">' +
      '<div class="render-content markup"><p>驳回原因</p></div></div></div></div>';
    document.querySelector('.ui.timeline').appendChild(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states.length, 4);
  assert.equal(states[3].toggleCount, 0);
  assert.equal(states[3].ready, false);
  assert.equal(states[2].collapsed, false);
  await context.close();
  console.log('ok - dismissal events are ignored');
}

// 11. English page language switches the button labels.
{
  const { page, context } = await openPage('', 'en-US');
  const states = await groupState(page);
  assert.equal(states[0].label, 'Expand review');
  assert.equal(states[2].label, 'Collapse review');
  assert.match(states[0].ariaLabel, /Expand review/);
  await context.close();
  console.log('ok - English labels follow the page language');
}

// 12. Removing a review's content cleans up its stale toggle and state.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.querySelector('.timeline-item-group');
    group.querySelector(':scope > .timeline-item.comment')?.remove();
    group.querySelector(':scope > .timeline-item.event.code-comments-list')?.remove();
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states[0].toggleCount, 0);
  assert.equal(states[0].ready, false);
  assert.equal(states[0].collapsed, false);
  assert.equal(states[0].bodyDisplay, null);
  assert.equal(states[2].collapsed, false);
  await context.close();
  console.log('ok - stale toggle is removed when review content disappears');
}

// 13. Resolved inline threads hidden by Gitea are not counted.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'inline-resolved-review';
    group.innerHTML =
      '<div class="timeline-item event">' +
      '<span class="badge tw-text-white"></span>' +
      '<span class="comment-text-line">testuser 评审</span></div>' +
      '<div class="timeline-item event code-comments-list">' +
      '<div class="conversation-holder"><div class="comment-code-cloud ui segment">' +
      '<div class="comment code-comment">可见意见</div></div></div>' +
      '<div class="conversation-holder"><div class="comment-code-cloud ui segment tw-hidden">' +
      '<div class="comment code-comment">已解决意见</div></div></div>' +
      '</div>';
    document.querySelector('.ui.timeline').appendChild(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states[3].collapsed, false);
  assert.equal(states[3].count, '1');
  await context.close();
  console.log('ok - hidden resolved threads are not counted');
}

// 14. Rescanning after an ordinary comment does not disturb review state.
{
  const { page, context } = await openPage();
  await page.evaluate(() => {
    const comment = document.createElement('div');
    comment.className = 'timeline-item comment';
    comment.id = 'ordinary-comment';
    comment.innerHTML =
      '<div class="content comment-container"><div class="ui attached segment comment-body">' +
      '<div class="render-content markup"><p>普通评论</p></div></div></div>';
    document.querySelector('.ui.timeline').appendChild(comment);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.deepEqual(
    states.map((state) => state.toggleCount),
    [1, 1, 1]
  );
  assert.deepEqual(
    states.map((state) => state.collapsed),
    [true, true, false]
  );
  assert.deepEqual(
    states.map((state) => state.user),
    [false, false, false]
  );
  await context.close();
  console.log('ok - rescan after an ordinary comment is idempotent');
}

// 15. The description stays first and the rest of the timeline is reversed.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: false,
    reverseTimeline: true,
  });
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
  await context.close();
  console.log('ok - reverse order keeps description first and includes merge box');
}

// 16. Changing the setting restores chronology and can reverse again.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: false,
    reverseTimeline: true,
  });
  await page.evaluate(() => window.__gpApplySettings({ reverseTimeline: false }));
  await page.waitForTimeout(120);
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

  await page.evaluate(() => window.__gpApplySettings({ reverseTimeline: true }));
  await page.waitForTimeout(120);
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
  await context.close();
  console.log('ok - settings changes reorder and restore the timeline live');
}

// 17. Reverse and review collapsing work together: newest review is on top.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: true,
  });
  const states = await groupState(page);
  assert.deepEqual(
    states.map((state) => state.id),
    ['issuecomment-10', 'issuecomment-7', 'issuecomment-4']
  );
  assert.deepEqual(
    states.map((state) => state.collapsed),
    [false, true, true]
  );
  assert.equal(states[0].bodyDisplay, 'block');
  assert.equal(states[1].bodyDisplay, 'none');

  await page.evaluate(() => window.__gpApplySettings({ collapseReviews: false }));
  await page.waitForTimeout(120);
  const expanded = await groupState(page);
  assert.deepEqual(
    expanded.map((state) => state.toggleCount),
    [0, 0, 0]
  );
  assert.deepEqual(
    expanded.map((state) => state.bodyDisplay),
    ['block', 'block', 'block']
  );
  await context.close();
  console.log('ok - reverse and collapse interact correctly across settings');
}

// 18. Issue pages are reversed too, but review collapsing is PR-only.
{
  const issueUrl = 'https://git.genarrative.world/git/test/demo/issues/2';
  const { page, context } = await openPage(
    '',
    'zh-CN',
    { collapseReviews: true, reverseTimeline: true },
    issueUrl
  );
  const order = await timelineOrder(page);
  assert.equal(order[0], 'issue-1');
  assert.equal(order[1], 'merge-box');
  assert.equal(order[2], 'issuecomment-10');
  assert.equal(order[order.length - 1], 'login-warning');
  assert.equal(await page.locator('.gp-toggle').count(), 0);
  await context.close();
  console.log('ok - issue pages reverse without review controls');
}

// 19. Hash anchors still open an older review when the timeline is reversed.
{
  const { page, context } = await openPage('#issuecomment-3', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: true,
  });
  const states = await groupState(page);
  const target = states.find((state) => state.id === 'issuecomment-4');
  assert.equal(target.collapsed, false);
  assert.equal(target.user, true);
  assert.equal(states[0].id, 'issuecomment-10');
  assert.equal(states[0].collapsed, false);
  await context.close();
  console.log('ok - hash anchor expands the targeted review in reversed order');
}

// 20. A comment added while reversed shows up at the top.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: false,
    reverseTimeline: true,
  });
  await page.evaluate(() => {
    const comment = document.createElement('div');
    comment.className = 'timeline-item comment';
    comment.id = 'issuecomment-99';
    comment.innerHTML =
      '<div class="content comment-container"><div class="ui attached segment comment-body">' +
      '<div class="render-content markup"><p>页面内新评论</p></div></div></div>';
    document.querySelector('.ui.timeline').appendChild(comment);
  });
  await page.waitForTimeout(150);
  const order = await timelineOrder(page);
  assert.equal(order[0], 'issue-1');
  assert.equal(order[1], 'issuecomment-99');
  await context.close();
  console.log('ok - newly added comment appears at the top while reversed');
}

// 21. A review added while reversed becomes the newest expanded round.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: true,
  });
  await page.evaluate(() => {
    const group = document.createElement('div');
    group.className = 'timeline-item-group';
    group.id = 'issuecomment-99';
    group.innerHTML =
      '<div class="timeline-item event"><span class="badge tw-text-white"></span>' +
      '<span class="comment-text-line">testuser 评审</span></div>' +
      '<div class="timeline-item comment"><div class="content comment-container">' +
      '<div class="ui attached segment comment-body"><div class="render-content markup">' +
      '<p>新评审</p></div></div></div></div>';
    document.querySelector('.ui.timeline').appendChild(group);
  });
  await page.waitForTimeout(150);
  const states = await groupState(page);
  assert.equal(states[0].id, 'issuecomment-99');
  assert.equal(states[0].collapsed, false);
  const previousLatest = states.find((state) => state.id === 'issuecomment-10');
  assert.equal(previousLatest.collapsed, true);
  await context.close();
  console.log('ok - newly added review becomes the expanded latest while reversed');
}

// 22. Rule-matched comments lose the whole card and can be revealed per rule.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: false,
    reverseTimeline: false,
    patternCollapse: true,
    commentRules: [
      {
        id: 'rule-low',
        name: '低优先级',
        pattern: '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?',
      },
    ],
  });
  await page.evaluate(() => {
    const timeline = document.querySelector('.ui.timeline');
    const makeComment = (id, inner) => {
      const comment = document.createElement('div');
      comment.className = 'timeline-item comment';
      comment.id = id;
      comment.innerHTML =
        '<div class="content comment-container">' +
        '<div class="comment-header"><div class="comment-header-left">testuser</div>' +
        '<div class="comment-header-right"></div></div>' +
        inner +
        '</div>';
      timeline.appendChild(comment);
      return comment;
    };

    makeComment(
      'low-comment',
      '<div class="ui attached segment comment-body">' +
        '<div class="tw-hidden">**[low]** raw markdown copy</div>' +
        '<div class="render-content markup"><p><strong>[low]</strong> 这条评论应整卡隐藏。</p></div>' +
        '</div>'
    );
    makeComment(
      'normal-comment',
      '<div class="ui attached segment comment-body">' +
        '<div class="render-content markup"><p>这条评论不匹配。</p></div></div>'
    );
    makeComment(
      'editing-comment',
      '<div class="ui attached segment comment-body">' +
        '<div class="ui form"><textarea>**[low]** editing</textarea></div></div>'
    );
    makeComment(
      'hidden-editor-comment',
      '<div class="ui form" style="display:none"><textarea>[low] hidden editor</textarea></div>' +
        '<div class="ui attached segment comment-body">' +
        '<div class="render-content markup"><p><strong>[low]</strong> 隐藏编辑器不应阻止折叠。</p></div></div>'
    );

    const holder = document.createElement('div');
    holder.className = 'ui segments conversation-holder';
    holder.id = 'low-inline-card';
    holder.innerHTML =
      '<div class="ui segment">file header</div>' +
      '<div class="ui table segment">diff</div>' +
      '<div class="comment-code-cloud ui segment"><div class="ui comments">' +
      '<div class="comment code-comment" id="low-inline">' +
      '<div class="content comment-container">' +
      '<div class="comment-header"><div class="comment-header-left">testuser</div>' +
      '<div class="comment-header-right"></div></div>' +
      '<div class="text comment-content"><div class="render-content markup">' +
      '<p><strong>[low]</strong> 行内意见也应隐藏。</p></div></div></div>' +
      '</div></div></div>';
    timeline.appendChild(holder);
  });
  await page.waitForTimeout(180);

  const state = await page.evaluate(() => {
    const info = (id) => {
      const comment = document.getElementById(id);
      return {
        hidden: comment.classList.contains('gp-rule-hidden'),
        display: getComputedStyle(comment).display,
        rules: comment.getAttribute('data-gp-rules'),
      };
    };
    const toolbar = document.querySelector('.gp-rule-toolbar');
    const timeline = document.querySelector('.ui.timeline');
    return {
      low: info('low-comment'),
      inlineCard: info('low-inline-card'),
      normal: info('normal-comment'),
      editing: info('editing-comment'),
      hiddenEditor: info('hidden-editor-comment'),
      toolbarNextToTimeline: Boolean(toolbar && toolbar.nextElementSibling === timeline),
      filters: toolbar
        ? [...toolbar.querySelectorAll('.gp-rule-filter span')].map((node) => node.textContent)
        : [],
      checked: toolbar
        ? [...toolbar.querySelectorAll('input')].map((input) => input.checked)
        : [],
    };
  });

  assert.deepEqual(state.low, {
    hidden: true,
    display: 'none',
    rules: 'rule-low',
  });
  assert.deepEqual(state.inlineCard, {
    hidden: true,
    display: 'none',
    rules: 'rule-low',
  });
  assert.deepEqual(state.normal, {
    hidden: false,
    display: 'block',
    rules: null,
  });
  assert.deepEqual(state.editing, {
    hidden: false,
    display: 'block',
    rules: null,
  });
  assert.deepEqual(state.hiddenEditor, {
    hidden: true,
    display: 'none',
    rules: 'rule-low',
  });
  assert.equal(state.toolbarNextToTimeline, true);
  assert.deepEqual(state.filters, ['显示低优先级']);
  assert.deepEqual(state.checked, [false]);

  await page.locator('.gp-rule-filter input').check();
  await page.waitForTimeout(100);
  const revealed = await page.evaluate(() => ({
    low: getComputedStyle(document.getElementById('low-comment')).display,
    inline: getComputedStyle(document.getElementById('low-inline-card')).display,
  }));
  assert.deepEqual(revealed, { low: 'block', inline: 'block' });

  await page.locator('.gp-rule-filter input').uncheck();
  await page.waitForTimeout(100);
  const rehidden = await page.evaluate(() => ({
    low: getComputedStyle(document.getElementById('low-comment')).display,
    inline: getComputedStyle(document.getElementById('low-inline-card')).display,
  }));
  assert.deepEqual(rehidden, { low: 'none', inline: 'none' });
  await context.close();
  console.log('ok - matching comments hide the whole card, with a named show filter');
}

// 23. Multiple named rules compose; rule edits and invalid patterns re-evaluate.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: false,
    reverseTimeline: false,
    patternCollapse: true,
    commentRules: [
      { id: 'low', name: 'low', pattern: '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?' },
      { id: 'nit', name: 'nit', pattern: '^nit' },
    ],
  });
  await page.evaluate(() => {
    const timeline = document.querySelector('.ui.timeline');
    const makeComment = (id, text) => {
      const comment = document.createElement('div');
      comment.className = 'timeline-item comment';
      comment.id = id;
      comment.innerHTML =
        '<div class="content comment-container">' +
        '<div class="comment-header"><div class="comment-header-left">testuser</div>' +
        '<div class="comment-header-right"></div></div>' +
        '<div class="ui attached segment comment-body">' +
        '<div class="render-content markup"><p>' + text + '</p></div></div></div>';
      timeline.appendChild(comment);
    };
    makeComment('low-comment', '[low] low');
    makeComment('nit-comment', 'nit only');
    makeComment('both-comment', '[low] nit');
  });
  await page.waitForTimeout(180);

  const display = (id) =>
    page.evaluate(
      (commentId) => getComputedStyle(document.getElementById(commentId)).display,
      id
    );
  const filters = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.gp-rule-filter')].map((label) => ({
        text: label.querySelector('span')?.textContent,
        checked: label.querySelector('input')?.checked,
      }))
    );

  assert.deepEqual(await filters(), [
    { text: '显示low', checked: false },
    { text: '显示nit', checked: false },
  ]);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['none', 'none', 'none']
  );

  await page.locator('.gp-rule-filter', { hasText: '显示low' }).locator('input').check();
  await page.waitForTimeout(100);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['block', 'none', 'block']
  );

  await page.locator('.gp-rule-filter', { hasText: '显示nit' }).locator('input').check();
  await page.waitForTimeout(100);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['block', 'block', 'block']
  );

  await page.locator('.gp-rule-filter', { hasText: '显示low' }).locator('input').uncheck();
  await page.waitForTimeout(100);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['none', 'block', 'none']
  );

  await page.evaluate(() =>
    window.__gpApplySettings({
      commentRules: [{ id: 'nit-only', name: 'nit only', pattern: '^nit' }],
    })
  );
  await page.waitForTimeout(120);
  assert.deepEqual(await filters(), [{ text: '显示nit only', checked: false }]);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['block', 'none', 'block']
  );

  await page.evaluate(() =>
    window.__gpApplySettings({
      commentRules: [{ id: 'bad', name: 'bad', pattern: '[' }],
    })
  );
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);
  assert.deepEqual(
    await Promise.all([
      display('low-comment'),
      display('nit-comment'),
      display('both-comment'),
    ]),
    ['block', 'block', 'block']
  );

  await page.evaluate(() =>
    window.__gpApplySettings({
      patternCollapse: false,
      commentRules: [{ id: 'nit', name: 'nit', pattern: '^nit' }],
    })
  );
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);
  assert.equal(await display('nit-comment'), 'block');
  await context.close();
  console.log('ok - named rules compose and react to edits, invalid regex, and off');
}

// 24. Rule filters belong to each review section instead of the page top.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: false,
    patternCollapse: true,
    commentRules: [
      { id: 'low', name: '低优先级', pattern: '^行内意见' },
    ],
  });
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.gp-rule-toolbar').count(), 0);

  const groupFilters = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.timeline-item-group')].map((group) => {
        const event = group.querySelector(':scope > .timeline-item.event');
        const label = event?.querySelector(':scope > .gp-rule-event-filter');
        const toggle = event?.querySelector(':scope > .gp-toggle');
        return {
          id: group.id,
          text: label?.querySelector('span')?.textContent ?? null,
          checked: label?.querySelector('input')?.checked ?? null,
          beforeToggle: Boolean(
            label &&
              toggle &&
              label.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
          ),
        };
      })
    );
  assert.deepEqual(await groupFilters(), [
    { id: 'issuecomment-4', text: '显示低优先级', checked: false, beforeToggle: true },
    { id: 'issuecomment-7', text: '显示低优先级', checked: false, beforeToggle: true },
    { id: 'issuecomment-10', text: '显示低优先级', checked: false, beforeToggle: true },
  ]);
  assert.equal(
    await page.locator('.conversation-holder.gp-rule-hidden').count(),
    3
  );

  const reviewCounts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.timeline-item-group')].map((group) => {
        const count = group.querySelector('.gp-count');
        return {
          id: group.id,
          hidden: count?.hidden ?? null,
          text: count?.textContent ?? null,
        };
      })
    );
  assert.deepEqual(await reviewCounts(), [
    { id: 'issuecomment-4', hidden: true, text: '0' },
    { id: 'issuecomment-7', hidden: true, text: '0' },
    { id: 'issuecomment-10', hidden: true, text: '0' },
  ]);

  await page
    .locator('#issuecomment-10 > .timeline-item.event > .gp-rule-event-filter input')
    .check();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('#issuecomment-10 .conversation-holder.gp-rule-hidden').count(),
    0
  );
  assert.equal(
    await page.locator('#issuecomment-7 .conversation-holder.gp-rule-hidden').count(),
    1
  );
  assert.deepEqual(
    (await groupFilters()).map((filter) => filter.checked),
    [false, false, true]
  );
  assert.deepEqual(await reviewCounts(), [
    { id: 'issuecomment-4', hidden: true, text: '0' },
    { id: 'issuecomment-7', hidden: true, text: '0' },
    { id: 'issuecomment-10', hidden: false, text: '1' },
  ]);

  await page
    .locator('#issuecomment-10 > .timeline-item.event > .gp-rule-event-filter input')
    .uncheck();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('#issuecomment-10 .conversation-holder.gp-rule-hidden').count(),
    1
  );
  await context.close();
  console.log('ok - review sections get their own named show filters');
}

// 25. A hidden reply inside a multi-comment thread still changes the badge.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: false,
    patternCollapse: true,
    commentRules: [{ id: 'low', name: 'low', pattern: '^\\[low\\]' }],
  });
  await page.evaluate(() => {
    const comments = document.querySelector('#code-comments-9 .ui.comments');
    const extra = document.createElement('div');
    extra.className = 'comment code-comment';
    extra.id = 'low-extra';
    extra.innerHTML =
      '<div class="content comment-container"><div class="text comment-content">' +
      '<div class="render-content markup"><p>[low] 同一线程中的隐藏回复。</p></div>' +
      '</div></div>';
    comments.appendChild(extra);
  });
  await page.waitForTimeout(180);

  const badge = () =>
    page.evaluate(() => {
      const count = document.querySelector('#issuecomment-10 .gp-count');
      return { hidden: count.hidden, text: count.textContent };
    });
  const extraState = () =>
    page.evaluate(() => {
      const extra = document.getElementById('low-extra');
      const holder = extra.closest('.conversation-holder');
      return {
        hidden: extra.classList.contains('gp-rule-hidden'),
        display: getComputedStyle(extra).display,
        holderHidden: holder.classList.contains('gp-rule-hidden'),
      };
    });

  assert.deepEqual(await badge(), { hidden: false, text: '1' });
  assert.deepEqual(await extraState(), {
    hidden: true,
    display: 'none',
    holderHidden: false,
  });

  await page
    .locator('#issuecomment-10 > .timeline-item.event > .gp-rule-event-filter input')
    .check();
  await page.waitForTimeout(100);
  assert.deepEqual(await badge(), { hidden: false, text: '2' });
  assert.deepEqual(await extraState(), {
    hidden: false,
    display: 'block',
    holderHidden: false,
  });

  await page
    .locator('#issuecomment-10 > .timeline-item.event > .gp-rule-event-filter input')
    .uncheck();
  await page.waitForTimeout(100);
  assert.deepEqual(await badge(), { hidden: false, text: '1' });
  await context.close();
  console.log('ok - badge counts visible inline comments, not just threads');
}

// 26. Checking a filter expands the collapsed review it belongs to.
{
  const { page, context } = await openPage('', 'zh-CN', {
    collapseReviews: true,
    reverseTimeline: false,
    patternCollapse: true,
    commentRules: [{ id: 'low', name: 'low', pattern: '^行内意见' }],
  });
  const group = page.locator('#issuecomment-7');
  assert.equal(await group.evaluate((element) => element.classList.contains('gp-collapsed')), true);
  await page
    .locator('#issuecomment-7 > .timeline-item.event > .gp-rule-event-filter input')
    .check();
  await page.waitForTimeout(150);
  assert.equal(await group.evaluate((element) => element.classList.contains('gp-collapsed')), false);
  assert.equal(
    await group.locator('.comment.code-comment').first().evaluate((element) => getComputedStyle(element).display),
    'block'
  );
  await context.close();
  console.log('ok - checking a review filter expands that review');
}

await browser.close();
console.log('\nall DOM behavior tests passed');
