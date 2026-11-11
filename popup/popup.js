'use strict';

const DEFAULT_RULE_PATTERN = '^\\s*(?:\\*\\*)?\\[low\\](?:\\*\\*)?';
const DEFAULT_RULE = Object.freeze({
  id: 'rule-low',
  name: 'low',
  pattern: DEFAULT_RULE_PATTERN,
});
const DEFAULTS = Object.freeze({
  collapseReviews: true,
  reverseTimeline: true,
  patternCollapse: true,
});

const uiLanguage = (
  (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) ||
  navigator.language ||
  'en'
).toLowerCase();
const isZh = uiLanguage.startsWith('zh');

const TEXT = isZh
  ? {
      subtitle: 'Gitea 页面增强',
      collapseTitle: '折叠较早评审',
      collapseDesc: '只展开最新一轮，其余正文和行内意见默认折叠。',
      reverseTitle: '时间线倒序',
      reverseDesc: 'PR / Issue 描述留在顶部，其余内容最新在前。',
      patternTitle: '按规则隐藏评论',
      patternDesc: '匹配规则的评论卡片整体隐藏，可在页面顶部点「显示…」找回。',
      rulesLabel: '隐藏规则',
      addRule: '+ 添加规则',
      rulesHint: '每条规则包含名称和正则。匹配的评论卡片默认隐藏，页面顶部会出现对应的「显示名称」开关。',
      noRules: '还没有规则，点「添加规则」新建一条。',
      ruleNamePlaceholder: '规则名',
      rulePatternPlaceholder: '正则表达式',
      removeRule: '删除规则',
      ruleInvalid: '正则表达式无效',
      invalidRules: '有无效正则，未保存',
      hint: '更改会即时应用到已打开的 Gitea 页面。',
      reset: '恢复默认',
      saved: '已保存，立即生效',
      error: '设置保存失败',
    }
  : {
      subtitle: 'Gitea page enhancements',
      collapseTitle: 'Collapse older reviews',
      collapseDesc: 'Keep only the newest review expanded; older bodies and inline comments stay folded.',
      reverseTitle: 'Newest comments first',
      reverseDesc: 'Keep the PR/issue description on top and show the rest of the timeline newest-first.',
      patternTitle: 'Hide comments by rule',
      patternDesc: 'Cards matching a rule are hidden; use the “Show …” checkboxes at the top of the conversation to reveal them.',
      rulesLabel: 'Hide rules',
      addRule: '+ Add rule',
      rulesHint: 'Each rule has a name and a regex. Matching comment cards are hidden by default; a “Show <name>” checkbox appears at the top of the conversation.',
      noRules: 'No rules yet. Click “Add rule” to create one.',
      ruleNamePlaceholder: 'Rule name',
      rulePatternPlaceholder: 'Regular expression',
      removeRule: 'Remove rule',
      ruleInvalid: 'Invalid regular expression',
      invalidRules: 'Some patterns are invalid; not saved',
      hint: 'Changes apply to open Gitea tabs immediately.',
      reset: 'Reset to defaults',
      saved: 'Saved. Applied immediately.',
      error: 'Could not save settings.',
    };

const inputs = {
  collapseReviews: document.getElementById('collapseReviews'),
  reverseTimeline: document.getElementById('reverseTimeline'),
  patternCollapse: document.getElementById('patternCollapse'),
};
const rulesSection = document.getElementById('rulesSection');
const rulesList = document.getElementById('rules');
const addRuleButton = document.getElementById('addRule');
const statusEl = document.getElementById('status');
const resetButton = document.getElementById('reset');

let currentRules = [];
let ruleIdCounter = 0;
let statusTimer = 0;
let saveTimer = 0;

function localize() {
  document.documentElement.lang = isZh ? 'zh-CN' : 'en';
  document.title = 'Gitea Plus';

  for (const element of document.querySelectorAll('[data-i18n]')) {
    const message = TEXT[element.dataset.i18n];
    if (message) element.textContent = message;
  }
  for (const element of document.querySelectorAll('[data-i18n-aria]')) {
    const message = TEXT[element.dataset.i18nAria];
    if (message) element.setAttribute('aria-label', message);
  }
}

function showStatus(message) {
  statusEl.textContent = message;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 1800);
}

function newRuleId() {
  ruleIdCounter += 1;
  return `rule-${Date.now().toString(36)}-${ruleIdCounter}`;
}

function fallbackRuleName(index) {
  return isZh ? `规则 ${index + 1}` : `Rule ${index + 1}`;
}

function upgradeLegacyPattern(pattern) {
  return pattern.trim() === '^\\s*\\[low\\]' ? DEFAULT_RULE_PATTERN : pattern;
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
    source = [{ ...DEFAULT_RULE }];
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

    const name =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : fallbackRuleName(rules.length);
    const pattern = typeof item.pattern === 'string' ? item.pattern : '';
    rules.push({ id, name, pattern });
  }

  return Array.isArray(raw) ? rules : rules.length ? rules : [{ ...DEFAULT_RULE }];
}

function toggleValues() {
  const values = {};
  for (const [key, input] of Object.entries(inputs)) {
    values[key] = input.checked;
  }
  return values;
}

function setToggles(values) {
  for (const [key, input] of Object.entries(inputs)) {
    input.checked = values[key] !== false;
  }
}

function regexIsValid(pattern) {
  if (!pattern.trim()) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function rulesAreValid() {
  return currentRules.every((rule) => regexIsValid(rule.pattern));
}

function updateRulesDisabledState() {
  const disabled = !inputs.patternCollapse.checked;
  rulesSection.classList.toggle('disabled', disabled);
  addRuleButton.disabled = disabled;
  for (const element of rulesSection.querySelectorAll('input, button')) {
    element.disabled = disabled;
  }
}

function validateRuleRow(row, rule) {
  const patternInput = row.querySelector('.rule-pattern');
  const error = row.querySelector('.rule-error');
  const valid = regexIsValid(rule.pattern);
  error.textContent = valid ? '' : TEXT.ruleInvalid;
  patternInput.setAttribute('aria-invalid', String(!valid));
  return valid;
}

function renderRules(focusIndex = -1) {
  rulesList.replaceChildren();

  if (!currentRules.length) {
    const empty = document.createElement('p');
    empty.className = 'rules-empty';
    empty.textContent = TEXT.noRules;
    rulesList.appendChild(empty);
    updateRulesDisabledState();
    return;
  }

  currentRules.forEach((rule, index) => {
    const row = document.createElement('div');
    row.className = 'rule';
    row.dataset.ruleId = rule.id;

    const top = document.createElement('div');
    top.className = 'rule-top';

    const nameInput = document.createElement('input');
    nameInput.className = 'rule-name';
    nameInput.type = 'text';
    nameInput.value = rule.name;
    nameInput.placeholder = TEXT.ruleNamePlaceholder;
    nameInput.setAttribute('aria-label', TEXT.ruleNamePlaceholder);
    nameInput.spellcheck = false;

    const removeButton = document.createElement('button');
    removeButton.className = 'rule-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = TEXT.removeRule;
    removeButton.setAttribute('aria-label', TEXT.removeRule);

    const patternInput = document.createElement('input');
    patternInput.className = 'rule-pattern';
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.placeholder = TEXT.rulePatternPlaceholder;
    patternInput.setAttribute('aria-label', TEXT.rulePatternPlaceholder);
    patternInput.spellcheck = false;
    patternInput.autocomplete = 'off';
    patternInput.autocapitalize = 'off';

    const error = document.createElement('p');
    error.className = 'rule-error';
    error.setAttribute('role', 'alert');

    nameInput.addEventListener('input', () => {
      currentRules[index].name = nameInput.value;
      scheduleSaveRules();
    });

    patternInput.addEventListener('input', () => {
      currentRules[index].pattern = patternInput.value;
      validateRuleRow(row, currentRules[index]);
      if (rulesAreValid()) scheduleSaveRules();
    });

    removeButton.addEventListener('click', () => {
      currentRules.splice(index, 1);
      renderRules();
      saveRules();
    });

    top.append(nameInput, removeButton);
    row.append(top, patternInput, error);
    rulesList.appendChild(row);
    validateRuleRow(row, rule);

    if (index === focusIndex) {
      requestAnimationFrame(() => patternInput.focus());
    }
  });

  updateRulesDisabledState();
}

async function persist(values) {
  try {
    await chrome.storage.sync.set(values);
    showStatus(TEXT.saved);
  } catch {
    showStatus(TEXT.error);
  }
}

async function saveToggles() {
  await persist(toggleValues());
}

async function saveRules() {
  if (!rulesAreValid()) {
    showStatus(TEXT.invalidRules);
    return;
  }
  const rules = currentRules.map((rule, index) => ({
    id: rule.id,
    name: rule.name.trim() || fallbackRuleName(index),
    pattern: rule.pattern,
  }));
  await persist({ commentRules: rules });
}

function scheduleSaveRules() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveRules, 300);
}

function addRule() {
  if (currentRules.length >= 20) return;
  const index = currentRules.length;
  currentRules.push({
    id: newRuleId(),
    name: fallbackRuleName(index),
    pattern: '',
  });
  renderRules(index);
  saveRules();
}

function useDefaults() {
  setToggles(DEFAULTS);
  currentRules = [{ ...DEFAULT_RULE }];
  renderRules();
  updateRulesDisabledState();
}

async function load() {
  useDefaults();

  try {
    const stored = await chrome.storage.sync.get(null);
    setToggles(stored);
    currentRules = normalizeRules(stored.commentRules, stored.commentPattern);
  } catch {
    /* keep defaults */
  }

  renderRules();
  updateRulesDisabledState();

  for (const input of Object.values(inputs)) {
    input.addEventListener('change', () => {
      updateRulesDisabledState();
      saveToggles();
    });
  }

  addRuleButton.addEventListener('click', addRule);

  resetButton.addEventListener('click', async () => {
    useDefaults();
    await persist({
      ...toggleValues(),
      commentRules: [{ ...DEFAULT_RULE }],
    });
  });
}

localize();
load();
