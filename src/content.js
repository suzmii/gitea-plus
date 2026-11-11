/*
 * Gitea Plus
 *
 * Enhances Gitea pull request / issue conversation pages with three optional
 * features:
 *   1. Collapse every review round except the newest one (PR pages).
 *   2. Keep the PR/issue description at the top and show the remaining
 *      timeline newest-first.
 *   3. Fold the body of comments whose text matches a user-supplied regex,
 *      leaving the comment header visible.
 *
 * All features are controlled from the extension popup (chrome.storage.sync).
 * The content script reacts to setting changes without a page reload.
 *
 * Built against Gitea 1.26.x templates:
 *   templates/repo/issue/view_content.tmpl
 *   templates/repo/issue/view_content/comments.tmpl (type 22 = review)
 *   templates/repo/issue/view_content/conversation.tmpl (inline comments)
 */
(() => {
  'use strict';

  // A content script can be injected once per document. Keep a guard so the
  // script is safe to evaluate again (useful for tests and manual reloads).
  if (globalThis.__giteaPlusLoaded) return;
  globalThis.__giteaPlusLoaded = true;

  const DEFAULT_RULE = Object.freeze({
    id: 'rule-low',
    name: 'low',
    pattern: '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?',
  });

  const DEFAULT_SETTINGS = Object.freeze({
    collapseReviews: true,
    reverseTimeline: true,
    patternCollapse: true,
    commentRules: Object.freeze([DEFAULT_RULE]),
  });

  const GROUP_SELECTOR = '.timeline-item-group';
  const COLLAPSED_CLASS = 'gp-collapsed';
  const READY_ATTR = 'data-gp-ready';
  const USER_ATTR = 'data-gp-user';
  const RULE_HIDDEN_CLASS = 'gp-rule-hidden';
  const RULE_ATTR = 'data-gp-rules';
  const PULL_PATH_RE = /\/pulls\/\d+\/?$/;
  const CONVERSATION_PATH_RE = /\/(?:pulls|issues)\/\d+\/?$/;

  const settings = { ...DEFAULT_SETTINGS };
  const sequence = new WeakMap();
  let sequenceCounter = 0;
  let applyTimer = 0;
  let handledHash = '';
  let controlId = 0;

  const pageLang = (
    document.documentElement.getAttribute('lang') ||
    navigator.language ||
    'en'
  ).toLowerCase();
  const isZh = pageLang.startsWith('zh');

  const TEXT = isZh
    ? {
        expand: '展开评审意见',
        collapse: '收起评审意见',
        expandTip: '评审意见已折叠，点击展开',
        collapseTip: '点击收起这轮评审意见',
        countTitle: (n) => `含 ${n} 条行内意见`,
        countAria: (n) => `${n} 条行内意见`,
        ruleFilterAria: '隐藏评论规则',
        showRule: (name) => `显示${name}`,
        showRuleTip: '勾选后显示匹配这条规则的评论卡片',
      }
    : {
        expand: 'Expand review',
        collapse: 'Collapse review',
        expandTip: 'Review is collapsed. Click to expand.',
        collapseTip: 'Click to collapse this review.',
        countTitle: (n) => `${n} inline comment${n === 1 ? '' : 's'}`,
        countAria: (n) => `${n} inline comment${n === 1 ? '' : 's'}`,
        ruleFilterAria: 'Hidden comment rules',
        showRule: (name) => `Show ${name}`,
        showRuleTip: 'Check to show comment cards matched by this rule.',
      };

  const CHEVRON_SVG =
    '<svg class="gp-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /*
   * ---------------------------- page / timeline ----------------------------
   */

  function isConversationPage() {
    return CONVERSATION_PATH_RE.test(location.pathname);
  }

  function isPullConversation() {
    return PULL_PATH_RE.test(location.pathname);
  }

  function getTimeline() {
    const list =
      document.querySelector('.issue-content-left.comment-list') ||
      document.querySelector('.comment-list');
    if (!list) return null;
    return list.querySelector(':scope > .ui.timeline') || list.querySelector('.ui.timeline');
  }

  function isDescription(node) {
    return node.matches('.timeline-item.comment.first') || /^issue-\d+$/.test(node.id);
  }

  /*
   * Conversation items are reorderable, including the merge box (checks and
   * merge actions). The description stays first; non-timeline elements and the
   * hidden pagination marker remain at the tail.
   */
  function isConversationItem(node) {
    if (!node.classList.contains('timeline-item') && !node.classList.contains('timeline-item-group')) {
      return false;
    }
    return !isDescription(node) && node.id !== 'timeline-comments-end';
  }

  function ensureSequences(timeline) {
    for (const node of timeline.children) {
      if (!isConversationItem(node) || sequence.has(node)) continue;
      sequenceCounter += 1;
      sequence.set(node, sequenceCounter);
    }
  }

  function sequenceOf(node) {
    return sequence.get(node) ?? 0;
  }

  function applyTimelineOrder() {
    if (!isConversationPage()) return;

    const timeline = getTimeline();
    if (!timeline) return;

    ensureSequences(timeline);

    const children = [...timeline.children];
    const description = children.find(isDescription) || null;
    const items = children.filter(isConversationItem);
    const itemSet = new Set(items);
    const tail = children.filter((node) => node !== description && !itemSet.has(node));

    items.sort((a, b) => sequenceOf(a) - sequenceOf(b));
    if (settings.reverseTimeline) items.reverse();

    const desired = [...(description ? [description] : []), ...items, ...tail];
    if (
      desired.length === children.length &&
      desired.every((node, index) => node === children[index])
    ) {
      return;
    }

    timeline.append(...desired);
  }

  /*
   * ------------------------------- settings --------------------------------
   */

  function getSyncStorage() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        return chrome.storage.sync;
      }
    } catch {
      /* extension context unavailable (e.g. tests) */
    }
    return null;
  }

  async function loadSettings() {
    const sync = getSyncStorage();
    if (!sync) return;
    try {
      const stored = await sync.get(null);
      settings.collapseReviews = stored.collapseReviews !== false;
      settings.reverseTimeline = stored.reverseTimeline !== false;
      settings.patternCollapse = stored.patternCollapse !== false;
      settings.commentRules = normalizeRules(stored.commentRules, stored.commentPattern);
    } catch {
      /* keep defaults */
    }
  }

  function listenForSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
        return;
      }
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync') return;
        let changed = false;

        if (changes.collapseReviews) {
          settings.collapseReviews = changes.collapseReviews.newValue !== false;
          changed = true;
        }
        if (changes.reverseTimeline) {
          settings.reverseTimeline = changes.reverseTimeline.newValue !== false;
          changed = true;
        }
        if (changes.patternCollapse) {
          settings.patternCollapse = changes.patternCollapse.newValue !== false;
          changed = true;
        }
        if (changes.commentRules) {
          settings.commentRules = normalizeRules(changes.commentRules.newValue);
          changed = true;
        }
        if (changed) applyFeatures();
      });
    } catch {
      /* no extension storage */
    }
  }

  /*
   * --------------------------- review collapsing ---------------------------
   */

  /*
   * A review round is a timeline group whose event header carries the white
   * review badge (`.badge.tw-text-white`). A dismissed review keeps that badge
   * and adds a "dismissed" label, so it still counts as a review round. The
   * separate dismissal event (type 32) uses a grey badge and is ignored.
   * The inline-comment list is a fallback marker for template changes.
   */
  function getReviewEvent(group) {
    const event = group.querySelector(':scope > .timeline-item.event');
    if (!event) return null;
    if (event.querySelector(':scope > .badge.grey')) return null;
    if (event.querySelector(':scope > .badge.tw-text-white')) return event;
    if (group.querySelector(':scope > .timeline-item.event.code-comments-list')) return event;
    return null;
  }

  function isReviewGroup(group) {
    return group.classList.contains('timeline-item-group') && getReviewEvent(group) !== null;
  }

  function getContentParts(group) {
    return {
      body: group.querySelector(':scope > .timeline-item.comment'),
      codeComments: group.querySelector(':scope > .timeline-item.event.code-comments-list'),
    };
  }

  function hasReviewContent(group) {
    const { body, codeComments } = getContentParts(group);
    return Boolean(body || codeComments);
  }

  function countInlineComments(group) {
    const list = getContentParts(group).codeComments;
    if (!list) return 0;

    // Count only inline comments that are actually visible: resolved threads,
    // rule-hidden cards and rule-empty comment sections do not contribute.
    return Array.from(list.querySelectorAll('.comment.code-comment')).filter(
      (comment) => {
        const cloud = comment.closest('.comment-code-cloud');
        return (
          (!cloud || !cloud.classList.contains('tw-hidden')) &&
          !comment.classList.contains(RULE_HIDDEN_CLASS) &&
          !comment.closest(`.${RULE_HIDDEN_CLASS}`) &&
          !comment.closest('.gp-rule-empty')
        );
      }
    ).length;
  }

  function refreshReviewCounts() {
    for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
      updateToggle(group);
    }
  }

  function updateToggle(group) {
    const toggle = group.querySelector(':scope > .timeline-item.event > .gp-toggle');
    if (!toggle) return;

    const collapsed = group.classList.contains(COLLAPSED_CLASS);
    const count = countInlineComments(group);
    const label = collapsed ? TEXT.expand : TEXT.collapse;

    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? TEXT.expandTip : TEXT.collapseTip;
    toggle.setAttribute(
      'aria-label',
      count > 0 ? `${label} (${TEXT.countAria(count)})` : label
    );

    const labelEl = toggle.querySelector('.gp-toggle-label');
    if (labelEl) labelEl.textContent = label;

    const countEl = toggle.querySelector('.gp-count');
    if (countEl) {
      countEl.hidden = count === 0;
      countEl.textContent = String(count);
      countEl.title = count > 0 ? TEXT.countTitle(count) : '';
    }
  }

  function setCollapsed(group, collapsed, markUser = false) {
    const changed = group.classList.contains(COLLAPSED_CLASS) !== collapsed;
    group.classList.toggle(COLLAPSED_CLASS, collapsed);
    if (markUser) group.setAttribute(USER_ATTR, '1');
    if (changed || markUser) updateToggle(group);
    return changed;
  }

  function createToggle(group) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gp-toggle';
    toggle.innerHTML =
      CHEVRON_SVG +
      '<span class="gp-toggle-label"></span>' +
      '<span class="gp-count" hidden></span>';

    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const collapsed = group.classList.contains(COLLAPSED_CLASS);
      setCollapsed(group, !collapsed, true);
    });

    return toggle;
  }

  function ensureElementId(element, kind) {
    if (!element.id) {
      controlId += 1;
      element.id = `gp-${kind}-${controlId}`;
    }
    return element.id;
  }

  function ensureToggle(group) {
    const event = getReviewEvent(group);
    if (!event) return;

    const { body, codeComments } = getContentParts(group);
    const controlled = [];
    if (body) controlled.push(ensureElementId(body, 'body'));
    if (codeComments) controlled.push(ensureElementId(codeComments, 'comments'));

    let toggle = event.querySelector(':scope > .gp-toggle');
    if (!toggle) {
      toggle = createToggle(group);
      event.appendChild(toggle);
    }
    if (controlled.length > 0) {
      toggle.setAttribute('aria-controls', controlled.join(' '));
    }
    updateToggle(group);
  }

  /*
   * When the URL points at a comment (for example a notification link to
   * `#issuecomment-123`), make sure it is visible after reordering. Reviews
   * that were collapsed are expanded and marked as user-opened so a later
   * rescan does not collapse them again.
   */
  function handleHashTarget() {
    const rawHash = location.hash.slice(1);
    if (!rawHash) {
      handledHash = '';
      return;
    }
    if (rawHash === handledHash) return;

    let id = rawHash;
    try {
      id = decodeURIComponent(rawHash);
    } catch {
      /* keep the raw hash */
    }

    const target = document.getElementById(id);
    if (!target) return;

    handledHash = rawHash;
    const group = target.closest(GROUP_SELECTOR);
    const hiddenCard = target.closest(`.${RULE_HIDDEN_CLASS}`);
    if (hiddenCard) {
      const ids = (hiddenCard.getAttribute(RULE_ATTR) || '')
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) {
        const shown = group ? getGroupShownSet(group) : shownGlobalRules;
        for (const ruleId of ids) shown.add(ruleId);
        applyRuleVisibility();
      }
    }
    if (group && group.classList.contains(COLLAPSED_CLASS)) {
      setCollapsed(group, false, true);
    }
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' });
    });
  }

  function clearReviewCollapse() {
    for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
      group.querySelectorAll(':scope > .timeline-item.event > .gp-toggle').forEach((toggle) => {
        toggle.remove();
      });
      group.removeAttribute(READY_ATTR);
      group.removeAttribute(USER_ATTR);
      group.classList.remove(COLLAPSED_CLASS);
    }
  }

  function scanReviews() {
    const timeline = getTimeline();
    if (timeline) ensureSequences(timeline);

    const groups = Array.from(document.querySelectorAll(GROUP_SELECTOR)).filter(isReviewGroup);
    const contentGroups = groups.filter(hasReviewContent);
    if (contentGroups.length === 0) {
      clearReviewCollapse();
      return;
    }

    // The DOM may be reversed, so pick the newest round by original sequence.
    let latest = null;
    let latestSequence = -Infinity;
    for (const group of contentGroups) {
      const groupSequence = sequenceOf(group);
      if (groupSequence >= latestSequence) {
        latestSequence = groupSequence;
        latest = group;
      }
    }

    for (const group of contentGroups) {
      ensureToggle(group);
      group.setAttribute(READY_ATTR, '1');
    }

    for (const group of groups) {
      if (hasReviewContent(group)) continue;
      const event = getReviewEvent(group);
      event?.querySelector(':scope > .gp-toggle')?.remove();
      group.removeAttribute(READY_ATTR);
      group.classList.remove(COLLAPSED_CLASS);
    }

    for (const group of contentGroups) {
      if (group.getAttribute(USER_ATTR) === '1') continue;
      const shouldCollapse = group !== latest;
      if (group.classList.contains(COLLAPSED_CLASS) !== shouldCollapse) {
        setCollapsed(group, shouldCollapse);
      }
    }
  }

  /*
   * ----------------------------- rule hiding -------------------------------
   */

  function cloneDefaultRules() {
    return [{ ...DEFAULT_RULE }];
  }

  function upgradeLegacyPattern(pattern) {
    const normalized = (pattern || '').trim();
    if (normalized === '^\\s*\\[low\\]') return DEFAULT_RULE.pattern;
    return pattern;
  }

  function normalizeRules(raw, legacyPattern) {
    let source;
    if (Array.isArray(raw)) {
      source = raw;
    } else if (typeof legacyPattern === 'string' && legacyPattern.trim()) {
      source = [
        {
          id: DEFAULT_RULE.id,
          name: DEFAULT_RULE.name,
          pattern: upgradeLegacyPattern(legacyPattern),
        },
      ];
    } else {
      source = cloneDefaultRules();
    }

    const seen = new Set();
    const rules = [];
    for (let index = 0; index < source.length && rules.length < 20; index += 1) {
      const item = source[index];
      if (!item || typeof item !== 'object') continue;

      let id =
        typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `rule-${index + 1}`;
      if (seen.has(id)) {
        let suffix = 1;
        do {
          id = `rule-${index + 1}-${suffix}`;
          suffix += 1;
        } while (seen.has(id));
      }
      seen.add(id);

      const fallbackName = isZh ? `规则 ${rules.length + 1}` : `Rule ${rules.length + 1}`;
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : fallbackName;
      const pattern = typeof item.pattern === 'string' ? item.pattern : '';
      rules.push({ id, name, pattern });
    }

    return Array.isArray(raw) ? rules : rules.length ? rules : cloneDefaultRules();
  }

  function getCommentContainer(comment) {
    return (
      comment.querySelector(':scope > .content.comment-container') ||
      comment.querySelector(':scope > .content')
    );
  }

  function getCommentBody(comment) {
    const container = getCommentContainer(comment);
    if (!container) return null;
    return (
      container.querySelector(':scope > .comment-body') ||
      container.querySelector(':scope > .text.comment-content') ||
      null
    );
  }

  function isRuleComment(comment) {
    if (!comment.matches('.timeline-item.comment, .comment.code-comment')) return false;
    if (isDescription(comment)) return false;
    if (comment.classList.contains('pull-merge-box')) return false;
    return true;
  }

  function hasVisibleEditor(element) {
    for (const node of element.querySelectorAll('textarea, .ui.form')) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (node.getClientRects().length > 0) return true;
    }
    return false;
  }

  function getCommentText(comment) {
    const body = getCommentBody(comment);
    if (!body) return null;

    // Keep the edit form usable when the user is editing a comment. Gitea can
    // keep hidden edit forms in the DOM; only a visible editor means editing.
    if (hasVisibleEditor(body)) return null;

    // Prefer the rendered body: Gitea may keep a hidden raw-Markdown copy in
    // the comment body, which would otherwise break patterns anchored at `^`.
    const rendered = body.querySelector('.render-content.markup, .render-content');
    return ((rendered || body).textContent || '').trim();
  }

  function compileRules() {
    const compiled = [];
    for (const rule of settings.commentRules) {
      const source = (rule.pattern || '').trim();
      if (!source) continue;
      try {
        compiled.push({ ...rule, regex: new RegExp(source) });
      } catch {
        /* invalid regex: skip this rule */
      }
    }
    return compiled;
  }

  const shownGlobalRules = new Set();
  let shownGroupRules = new WeakMap();
  let ruleTargets = new WeakMap();
  let ruleToolbar = null;

  function removeRuleToolbar() {
    if (ruleToolbar) {
      ruleToolbar.remove();
      ruleToolbar = null;
    }
  }

  function getRuleTarget(comment) {
    // Inline review comments live in their own conversation-holder together
    // with the file header and diff. Hiding the holder removes the entire card
    // instead of leaving an empty diff segment behind.
    if (comment.matches('.comment.code-comment')) {
      const holder = comment.closest('.conversation-holder');
      if (holder && holder.querySelectorAll('.comment.code-comment').length === 1) {
        return holder;
      }
    }
    return comment;
  }

  function clearRuleTarget(comment) {
    const target = ruleTargets.get(comment);
    if (!target) return;
    target.classList.remove(RULE_HIDDEN_CLASS);
    target.removeAttribute(RULE_ATTR);
    ruleTargets.delete(comment);
  }

  function updateEmptyCodeComments() {
    for (const list of document.querySelectorAll('.timeline-item.event.code-comments-list')) {
      const holders = [...list.querySelectorAll(':scope .conversation-holder')];
      const anyVisible = holders.some(
        (holder) => !holder.classList.contains(RULE_HIDDEN_CLASS)
      );
      list.classList.toggle('gp-rule-empty', holders.length > 0 && !anyVisible);
    }
  }

  function getGroupShownSet(group) {
    let shown = shownGroupRules.get(group);
    if (!shown) {
      shown = new Set();
      shownGroupRules.set(group, shown);
    }
    return shown;
  }

  function syncRuleFilterCheckboxes() {
    for (const input of document.querySelectorAll('input[data-gp-rule-id]')) {
      const group = input.closest(GROUP_SELECTOR);
      const shown = group ? shownGroupRules.get(group) : shownGlobalRules;
      input.checked = Boolean(shown && shown.has(input.dataset.gpRuleId));
    }
  }

  function applyRuleVisibility() {
    for (const target of document.querySelectorAll(`[${RULE_ATTR}]`)) {
      const ids = (target.getAttribute(RULE_ATTR) || '')
        .split(/\s+/)
        .filter(Boolean);
      const group = target.closest(GROUP_SELECTOR);
      const shown = group ? shownGroupRules.get(group) : shownGlobalRules;
      const visible = Boolean(shown && ids.some((id) => shown.has(id)));
      const editing = hasVisibleEditor(target);
      target.classList.toggle(RULE_HIDDEN_CLASS, !visible && !editing);
    }
    syncRuleFilterCheckboxes();
    updateEmptyCodeComments();
    refreshReviewCounts();
  }

  function buildRuleToolbar(entries) {
    const timeline = getTimeline();
    const host = timeline ? timeline.parentElement : null;
    if (!entries.length || !timeline || !host) {
      removeRuleToolbar();
      return;
    }

    if (ruleToolbar && (!ruleToolbar.isConnected || ruleToolbar.parentElement !== host)) {
      ruleToolbar.remove();
      ruleToolbar = null;
    }

    if (!ruleToolbar) {
      ruleToolbar = document.createElement('div');
      ruleToolbar.className = 'gp-rule-toolbar';
      ruleToolbar.setAttribute('role', 'group');
      ruleToolbar.setAttribute('aria-label', TEXT.ruleFilterAria);
      ruleToolbar.addEventListener('change', (event) => {
        const input = event.target.closest('input[data-gp-rule-id]');
        if (!input) return;
        if (input.checked) shownGlobalRules.add(input.dataset.gpRuleId);
        else shownGlobalRules.delete(input.dataset.gpRuleId);
        applyRuleVisibility();
      });
      host.insertBefore(ruleToolbar, timeline);
    }

    const filters = [];
    for (const entry of entries) {
      const label = document.createElement('label');
      label.className = 'gp-rule-filter';
      label.title = TEXT.showRuleTip;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.gpRuleId = entry.id;
      input.checked = shownGlobalRules.has(entry.id);
      input.setAttribute('aria-label', TEXT.showRule(entry.name));

      const text = document.createElement('span');
      text.textContent = TEXT.showRule(entry.name);

      label.append(input, text);
      filters.push(label);
    }
    ruleToolbar.replaceChildren(...filters);
  }

  function updateGroupFilters(groupCounts) {
    for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
      const event = getReviewEvent(group);
      if (!event) continue;

      const counts = groupCounts.get(group) || new Map();
      const shown = getGroupShownSet(group);
      for (const ruleId of [...shown]) {
        if (!counts.has(ruleId)) shown.delete(ruleId);
      }

      event.querySelectorAll(':scope > .gp-rule-event-filter').forEach((filter) => {
        filter.remove();
      });

      const toggle = event.querySelector(':scope > .gp-toggle');
      let filterCount = 0;
      for (const rule of settings.commentRules) {
        if (!counts.get(rule.id)) continue;

        const label = document.createElement('label');
        label.className = 'gp-rule-filter gp-rule-event-filter';
        label.title = TEXT.showRuleTip;

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.gpRuleId = rule.id;
        input.checked = shown.has(rule.id);
        input.setAttribute('aria-label', TEXT.showRule(rule.name));
        input.addEventListener('change', () => {
          if (input.checked) {
            shown.add(rule.id);
            if (group.classList.contains(COLLAPSED_CLASS)) {
              setCollapsed(group, false, true);
            }
          } else {
            shown.delete(rule.id);
          }
          applyRuleVisibility();
        });

        const text = document.createElement('span');
        text.textContent = TEXT.showRule(rule.name);

        label.append(input, text);
        if (toggle) event.insertBefore(label, toggle);
        else event.appendChild(label);
        filterCount += 1;
      }

      event.classList.toggle('gp-has-rule-filters', filterCount > 0);
    }
  }

  function clearRuleHiding() {
    for (const comment of document.querySelectorAll(`[${RULE_ATTR}], .${RULE_HIDDEN_CLASS}`)) {
      comment.classList.remove(RULE_HIDDEN_CLASS);
      comment.removeAttribute(RULE_ATTR);
    }
    for (const list of document.querySelectorAll('.gp-rule-empty')) {
      list.classList.remove('gp-rule-empty');
    }
    document.querySelectorAll('.gp-rule-event-filter').forEach((filter) => filter.remove());
    document.querySelectorAll('.gp-has-rule-filters').forEach((event) => {
      event.classList.remove('gp-has-rule-filters');
    });
    removeRuleToolbar();
    shownGlobalRules.clear();
    shownGroupRules = new WeakMap();
    ruleTargets = new WeakMap();
    refreshReviewCounts();
  }

  function scanRuleComments() {
    if (!isConversationPage()) return;

    const timeline = getTimeline();
    if (!timeline) {
      clearRuleHiding();
      return;
    }

    const compiled = settings.patternCollapse ? compileRules() : [];
    if (!compiled.length) {
      clearRuleHiding();
      return;
    }

    const validIds = new Set(compiled.map((rule) => rule.id));
    for (const id of [...shownGlobalRules]) {
      if (!validIds.has(id)) shownGlobalRules.delete(id);
    }

    const groupCounts = new Map();
    const globalCounts = new Map(compiled.map((rule) => [rule.id, 0]));
    const comments = document.querySelectorAll(
      '.timeline-item.comment, .comment.code-comment'
    );

    for (const comment of comments) {
      if (!isRuleComment(comment)) continue;

      const text = getCommentText(comment);
      if (text === null) {
        clearRuleTarget(comment);
        continue;
      }

      const matches = [];
      for (const rule of compiled) {
        if (rule.regex.test(text)) matches.push(rule.id);
      }

      if (!matches.length) {
        clearRuleTarget(comment);
        continue;
      }

      const target = getRuleTarget(comment);
      ruleTargets.set(comment, target);
      target.setAttribute(RULE_ATTR, matches.join(' '));

      const group = target.closest(GROUP_SELECTOR);
      if (group) {
        let counts = groupCounts.get(group);
        if (!counts) {
          counts = new Map(compiled.map((rule) => [rule.id, 0]));
          groupCounts.set(group, counts);
        }
        for (const ruleId of matches) {
          counts.set(ruleId, counts.get(ruleId) + 1);
        }
      } else {
        for (const ruleId of matches) {
          globalCounts.set(ruleId, globalCounts.get(ruleId) + 1);
        }
      }
    }

    updateGroupFilters(groupCounts);
    applyRuleVisibility();

    const entries = compiled
      .filter((rule) => globalCounts.get(rule.id) > 0)
      .map((rule) => ({ id: rule.id, name: rule.name }));
    buildRuleToolbar(entries);
  }

  /*
   * ------------------------------- runtime --------------------------------
   */

  function applyFeatures() {
    if (!isConversationPage()) return;
    applyTimelineOrder();
    if (settings.collapseReviews && isPullConversation()) {
      scanReviews();
    } else {
      clearReviewCollapse();
    }
    scanRuleComments();
    handleHashTarget();
  }

  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = window.setTimeout(() => {
      applyTimer = 0;
      applyFeatures();
    }, 50);
  }

  function nodeNeedsRescan(node) {
    if (!(node instanceof Element)) return false;
    const markers =
      '.timeline-item-group, .timeline-item, .ui.timeline, .code-comments-list, .comment.code-comment, .render-content, .ui.form';
    if (node.matches(markers)) return true;
    return node.querySelector(markers) !== null;
  }

  function startObserver() {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (nodeNeedsRescan(node)) {
            scheduleApply();
            return;
          }
        }
        for (const node of record.removedNodes) {
          if (nodeNeedsRescan(node)) {
            scheduleApply();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function start() {
    listenForSettings();
    await loadSettings();
    applyFeatures();
    startObserver();

    window.addEventListener('pjax:end', scheduleApply, true);
    document.addEventListener('turbo:load', scheduleApply, true);
    window.addEventListener('popstate', scheduleApply, true);
    window.addEventListener('hashchange', scheduleApply, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
