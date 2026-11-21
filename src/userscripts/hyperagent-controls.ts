/**
 * Bundled Hyperagent thread controls. The body of an async function, like every
 * catalog script.
 *
 * Unlike the other bundled scripts this one is not an observer. It mounts a small
 * rail on the page and, when the user changes a control in it, PATCHes that
 * thread's settings through Hyperagent's own same-origin REST routes. Running the
 * script changes nothing by itself: every write follows a click on the rail.
 *
 * Why it exists: on 2026-11-21 changing a thread's model took four clicks through
 * nested menus, reasoning effort five, the subagent model six, and none of the
 * current values were visible without opening a menu.
 *
 * The ids below are the ones the app itself sends, captured from its requests on
 * 2026-11-21. Two of them matter because the server does not reject a wrong one:
 * `effort` and `toolSettings.autoCompactThresholdPercent` accept any string and
 * store it. `modelId` and `defaultSubagentModel` are validated (400 on an unknown
 * id).
 */
export const HYPERAGENT_CONTROLS_CODE = `// hyperagent-controls: a docked rail that puts a thread's buried settings one click away.
// Reads and writes Hyperagent's own cookie-authenticated REST routes (same origin).
// WRITES: PATCH /api/threads/{id} with modelId, effort, defaultSubagentModel,
// autoProviderOverride, and toolSettings.autoCompactThresholdPercent. Nothing else.
// Every field and value below was captured from the app's own requests on 2026-11-21.
const ALLOWED_HOSTS = ['hyperagent.com', 'www.hyperagent.com'];
if (ALLOWED_HOSTS.indexOf(location.hostname.toLowerCase()) === -1) {
  return { scriptId: 'hyperagent-controls', ok: false, reason: 'host-not-allowed', host: location.hostname };
}

const ROOT_ID = 'hb-hyperagent-controls';
const previous = document.getElementById(ROOT_ID);
if (previous) {
  if (previous.__hbStop) previous.__hbStop();
  previous.remove();
}

// The effort route does not validate: a misspelt value is stored and silently means
// nothing. These are the five ids the app itself sends.
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const AUTO_MODES = [['auto:frontier', 'Auto: Quality'], ['auto:balanced', 'Auto: Balanced'], ['auto:cost', 'Auto: Low cost']];
const PROVIDERS = [['', 'Any'], ['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['open_weights', 'Open weights']];
const COMPACT = [['', 'Default'], ['50', '50%'], ['60', '60%'], ['70', '70%'], ['80', '80%'], ['90', '90%']];

const threadIdFromPath = () => {
  const m = location.pathname.match(/^\\/thread\\/([a-z0-9]+)/);
  return m ? m[1] : null;
};

const api = async (path, init) => {
  const res = await fetch(path, Object.assign({ credentials: 'include' }, init || {}));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || (res.status + ' ' + path));
  }
  return data;
};

const parseToolSettings = (thread) => {
  const raw = thread && thread.toolSettings;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  return raw;
};

const fmtTokens = (n) => {
  if (n == null) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
};
const fmtUsd = (n) => (n == null ? '-' : '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2)));

const el = (tag, props, children) => {
  const node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach((key) => {
      if (key === 'style') node.style.cssText = props.style;
      else if (key === 'text') node.textContent = props.text;
      else node[key] = props[key];
    });
  }
  (children || []).forEach((child) => node.appendChild(child));
  return node;
};

const root = el('div', { id: ROOT_ID });
root.style.cssText = [
  'position:fixed', 'top:76px', 'right:10px', 'width:232px', 'z-index:2147483000',
  'font:12px/1.35 ui-sans-serif,system-ui,sans-serif', 'color:#1b1b1b', 'background:#fbfaf7',
  'border:1px solid #cfcabd', 'border-radius:8px', 'box-shadow:0 2px 10px rgba(0,0,0,.12)',
  'padding:6px 8px 8px',
].join(';');

const title = el('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:600;cursor:pointer;user-select:none' });
const titleText = el('span', { text: 'Thread controls', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' });
const statusDot = el('span', { text: '', style: 'font-weight:400;color:#6b6b6b;font-size:11px' });
const caret = el('span', { text: '−', style: 'color:#6b6b6b' });
title.appendChild(titleText); title.appendChild(statusDot); title.appendChild(caret);
const body = el('div', { style: 'margin-top:6px' });
root.appendChild(title); root.appendChild(body);

let collapsed = false;
// Collapsed state lives in this variable only. Web storage is shared with the page,
// so writing a key there would leave a trace the site can read (R-02).
const applyCollapsed = () => {
  body.style.display = collapsed ? 'none' : 'block';
  caret.textContent = collapsed ? '+' : '−';
};
title.addEventListener('click', () => {
  collapsed = !collapsed;
  applyCollapsed();
});
applyCollapsed();

const SELECT_STYLE = 'width:100%;font:inherit;padding:2px 4px;border:1px solid #cfcabd;border-radius:5px;background:#fff;color:inherit';
const row = (label, control) => el('label', { style: 'display:block;margin:0 0 5px' }, [
  el('span', { text: label, style: 'display:block;font-size:10.5px;color:#6b6b6b;letter-spacing:.02em' }),
  control,
]);
const makeSelect = () => el('select', { style: SELECT_STYLE });
const fill = (select, options, value) => {
  select.textContent = '';
  let found = false;
  options.forEach((opt) => {
    if (opt.group) {
      const group = el('optgroup', { label: opt.group });
      opt.items.forEach((item) => {
        group.appendChild(el('option', { value: item[0], text: item[1] }));
        if (item[0] === value) found = true;
      });
      select.appendChild(group);
    } else {
      select.appendChild(el('option', { value: opt[0], text: opt[1] }));
      if (opt[0] === value) found = true;
    }
  });
  // A value the lists do not know (a model nobody has used yet) still has to show as
  // the current one, otherwise the select would lie about the thread's state.
  if (!found && value != null && value !== '') select.appendChild(el('option', { value: value, text: value }));
  select.value = value == null ? '' : value;
};

const modelSel = makeSelect();
const providerSel = makeSelect();
const effortSel = makeSelect();
const subSel = makeSelect();
const compactSel = makeSelect();
const presetBtn = el('button', {
  type: 'button', text: 'Low cost · Max · Open weights',
  style: 'width:100%;font:inherit;padding:3px 4px;margin:1px 0 6px;border:1px solid #9a9482;border-radius:5px;background:#efece3;cursor:pointer',
});
const usageBox = el('div', { style: 'border-top:1px solid #dedacd;padding-top:5px;font-variant-numeric:tabular-nums' });
const note = el('div', { style: 'margin-top:4px;font-size:10.5px;color:#6b6b6b;min-height:14px' });
const empty = el('div', { text: 'Open a thread to see its controls.', style: 'color:#6b6b6b' });
const controls = el('div', null, [
  row('Model', modelSel), row('Provider (Auto modes only)', providerSel), row('Reasoning effort', effortSel),
  row('Subagent model', subSel), row('Auto-compact at', compactSel), presetBtn, usageBox, note,
]);
body.appendChild(empty); body.appendChild(controls);

let knownModels = [];
let current = { id: null, thread: null };
let stopped = false;
let busy = false;

const loadKnownModels = async () => {
  const seen = {};
  const add = (v) => { if (v && typeof v === 'string' && v.indexOf('auto:') !== 0 && v !== 'inherit') seen[v] = true; };
  try {
    const threads = await api('/api/threads');
    ((threads && threads.items) || threads || []).forEach((t) => { add(t.modelId); add(t.defaultSubagentModel); });
  } catch (e) { /* the pickers fall back to the current value only */ }
  try {
    const agents = await api('/api/agents');
    ((agents && agents.items) || agents || []).forEach((a) => { add(a.modelId); add(a.defaultSubagentModel); });
  } catch (e) { /* same fallback */ }
  knownModels = Object.keys(seen).sort();
};

const usageLine = (label, value) => el('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, [
  el('span', { text: label, style: 'color:#6b6b6b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
  el('span', { text: value }),
]);

const renderUsage = (usage, breakdown) => {
  usageBox.textContent = '';
  const cap = usage && usage.lastCapture;
  if (cap) {
    usageBox.appendChild(usageLine('Context (last call)', fmtTokens((cap.input_tokens || 0) + (cap.cache_read_tokens || 0))));
    usageBox.appendChild(usageLine('new / cached / out', fmtTokens(cap.input_tokens) + ' / ' + fmtTokens(cap.cache_read_tokens) + ' / ' + fmtTokens(cap.output_tokens)));
  } else {
    usageBox.appendChild(usageLine('Context (last call)', 'no calls yet'));
  }
  usageBox.appendChild(usageLine('Thread cost', fmtUsd(usage && usage.totals ? usage.totals.total_cost_usd : null)));
  const names = (breakdown && breakdown.displayNames) || {};
  ((breakdown && breakdown.items) || []).slice(0, 6).forEach((item) => {
    usageBox.appendChild(usageLine(names[item.name] || item.name, fmtTokens(item.quantity) + ' · ' + fmtUsd(item.costUsd)));
  });
};

const render = () => {
  const thread = current.thread;
  empty.style.display = thread ? 'none' : 'block';
  controls.style.display = thread ? 'block' : 'none';
  if (!thread) { titleText.textContent = 'Thread controls'; return; }
  const settings = parseToolSettings(thread);
  const modelItems = knownModels.map((m) => [m, m]);
  titleText.textContent = thread.name || 'Thread controls';
  titleText.title = thread.name || '';
  fill(modelSel, [{ group: 'Auto', items: AUTO_MODES }, { group: 'Pinned (seen in your threads and agents)', items: modelItems }], thread.modelId);
  fill(providerSel, PROVIDERS, settings.autoProviderOverride || '');
  providerSel.disabled = String(thread.modelId || '').indexOf('auto:') !== 0;
  fill(effortSel, [['', 'Not set']].concat(EFFORTS), thread.effort || '');
  fill(subSel, [['', 'Default'], ['inherit', 'Parent model'], { group: 'Pinned', items: modelItems }], thread.defaultSubagentModel || '');
  fill(compactSel, COMPACT, settings.autoCompactThresholdPercent == null ? '' : String(settings.autoCompactThresholdPercent));
};

const refresh = async () => {
  const id = threadIdFromPath();
  if (!id) { current = { id: null, thread: null }; render(); return; }
  try {
    const thread = await api('/api/threads/' + id);
    if (threadIdFromPath() !== id) return;
    current = { id: id, thread: thread };
    if (!busy) render();
    const usage = await api('/api/threads/' + id + '/usage').catch(() => null);
    const breakdown = await api('/api/threads/' + id + '/usage-breakdown').catch(() => null);
    if (threadIdFromPath() === id) renderUsage(usage, breakdown);
  } catch (e) {
    note.textContent = 'Read failed: ' + e.message;
  }
};

const patch = async (bodyObj, label) => {
  if (!current.id) return;
  busy = true;
  statusDot.textContent = 'saving';
  try {
    current.thread = await api('/api/threads/' + current.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
    });
    // The app keeps its own cached copy of the thread, so its menus show the old value
    // until the page is reloaded. The rail re-reads the server and is the truth.
    note.textContent = label + ' saved. Hyperagent’s own menus update on reload.';
  } catch (e) {
    note.textContent = label + ' failed: ' + e.message;
  }
  statusDot.textContent = '';
  busy = false;
  render();
};

const orNull = (v) => (v === '' ? null : v);
modelSel.addEventListener('change', () => patch({ modelId: modelSel.value }, 'Model'));
providerSel.addEventListener('change', () => patch({ autoProviderOverride: orNull(providerSel.value) }, 'Provider'));
effortSel.addEventListener('change', () => { if (effortSel.value) patch({ effort: effortSel.value }, 'Effort'); });
subSel.addEventListener('change', () => patch({ defaultSubagentModel: orNull(subSel.value) }, 'Subagent model'));
// toolSettings merges server-side: sending one key leaves the other tool settings alone.
compactSel.addEventListener('change', () => patch({ toolSettings: { autoCompactThresholdPercent: orNull(compactSel.value) } }, 'Auto-compact'));
presetBtn.addEventListener('click', () => patch({ modelId: 'auto:cost', effort: 'max', autoProviderOverride: 'open_weights' }, 'Preset'));

document.body.appendChild(root);

let lastPath = location.pathname;
let ticks = 0;
const timer = setInterval(() => {
  if (stopped) return;
  ticks += 1;
  // The app is a single-page app: moving between threads never reloads, so the path is
  // polled. Usage is re-read every 15 s while a thread is open.
  if (location.pathname !== lastPath) { lastPath = location.pathname; note.textContent = ''; refresh(); }
  else if (ticks % 15 === 0 && current.id && !busy && document.visibilityState === 'visible') refresh();
}, 1000);
root.__hbStop = () => { stopped = true; clearInterval(timer); };

await loadKnownModels();
await refresh();

return {
  scriptId: 'hyperagent-controls',
  ok: true,
  mounted: true,
  threadId: current.id,
  modelId: current.thread ? current.thread.modelId : null,
  effort: current.thread ? current.thread.effort : null,
  knownModels: knownModels.length,
};
`;
