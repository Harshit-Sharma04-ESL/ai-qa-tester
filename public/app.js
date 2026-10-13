/* AI QA Tester dashboard — plain JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dur = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const ACTIVE = ['queued', 'starting', 'planning', 'running', 'paused'];
const EXAMPLES = [
  { url: 'https://the-internet.herokuapp.com/login', goal: 'Test the login flow with valid and invalid passwords' },
  { url: 'https://www.saucedemo.com/', goal: 'Log in as standard_user, add the Sauce Labs Backpack to the cart and verify the cart badge shows 1' },
  { url: 'https://demo.playwright.dev/todomvc/', goal: 'Add two todo items, mark the first one completed and verify that "1 item left" is shown' },
];

const state = {
  view: 'run',
  mode: 'ai',
  run: null, // run currently shown on the Run tab
  live: false, // is that run still executing (frames/events apply)
  activeRunId: null,
  status: null,
  scripts: [],
  script: null, // script open in the editor
  open: new Set(), // expanded test cards
  pane: 'log',
};

// ------------------------------------------------------------------ api
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ------------------------------------------------------------------ navigation
function setView(view) {
  state.view = view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'history') loadHistory();
  if (view === 'scripts') loadScripts();
  if (view === 'settings') loadStatus();
  try { localStorage.setItem('qa.view', view); } catch { /* storage unavailable */ }
}
$('#nav').addEventListener('click', (e) => e.target.dataset.view && setView(e.target.dataset.view));

function setMode(mode) {
  state.mode = mode;
  $$('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('.mode-ai').classList.toggle('hidden', mode !== 'ai');
  $('.mode-script').classList.toggle('hidden', mode !== 'script');
  $('#in-url').required = mode === 'ai';
  if (mode === 'script') loadScripts();
}
$('#mode-seg').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));

$$('#log-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    state.pane = b.dataset.pane;
    $$('#log-seg button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${state.pane}`));
  })
);

$('#examples').innerHTML = EXAMPLES.map((x, i) => `<button type="button" data-i="${i}" title="${esc(x.url)}">${esc(new URL(x.url).hostname)}: ${esc(x.goal.slice(0, 48))}…</button>`).join('');
$('#examples').addEventListener('click', (e) => {
  const x = EXAMPLES[e.target.closest('button')?.dataset.i];
  if (!x) return;
  $('#in-url').value = x.url;
  $('#in-goal').value = x.goal;
});

// ------------------------------------------------------------------ websocket
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => setChip('#chip-ws', 'ok', 'Live');
  ws.onclose = () => {
    setChip('#chip-ws', 'err', 'Disconnected');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function setChip(sel, cls, text, title) {
  const c = $(sel);
  c.className = `chip ${cls}`;
  $('span', c).textContent = text;
  if (title) c.title = title;
}

function handle(m) {
  if (m.type === 'pull') return renderPull(m.model, m.state);
  if (m.type === 'hello') {
    state.activeRunId = m.activeRun?.id || null;
    if (m.activeRun) showRun(m.activeRun, true);
    else if (!state.run) loadLatestRun();
    return renderControls();
  }
  if (m.type === 'started') {
    state.activeRunId = m.run.id;
    state.open.clear();
    showRun(m.run, true);
    return;
  }
  const run = state.run;
  if (m.type === 'done') {
    if (state.activeRunId === m.runId) state.activeRunId = null;
    if (run?.id === m.runId) {
      state.live = false;
      state.run = m.run;
      const s = m.run.summary;
      toast(`Run ${m.run.status}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
      render();
    }
    if (state.view === 'history') loadHistory();
    return renderControls();
  }
  if (!run || run.id !== m.runId || !state.live) return;
  switch (m.type) {
    case 'frame':
      $('#screen').src = `data:image/jpeg;base64,${m.data}`;
      $('#screen-empty').classList.add('hidden');
      return;
    case 'nav':
      run.currentUrl = m.url;
      break;
    case 'status':
      run.status = m.status;
      run.activity = m.activity;
      break;
    case 'plan':
      run.tests = m.tests;
      run.analysis = m.analysis;
      break;
    case 'test':
      run.tests[m.testIndex] = m.test;
      if (m.test.status === 'running') state.open.add(m.testIndex);
      break;
    case 'step': {
      const t = run.tests[m.testIndex];
      if (t) t.steps[m.stepIndex] = m.step;
      break;
    }
    case 'thought': {
      const t = run.tests[m.testIndex];
      if (t) t.thoughts.push(m.thought);
      break;
    }
    case 'log':
      run.log.push(m.entry);
      break;
    case 'console':
      run.consoleErrors.push(m.item);
      break;
    case 'network':
      run.networkErrors.push(m.item);
      break;
  }
  scheduleRender();
}

async function loadLatestRun() {
  try {
    const [latest] = await api('/api/runs');
    if (latest && !state.run) showRun(await api(`/api/runs/${latest.id}`), false);
  } catch { /* no history yet */ }
}

// ------------------------------------------------------------------ rendering (batched)
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function showRun(run, live) {
  state.run = run;
  state.live = live;
  $('#replay-video').classList.add('hidden');
  $('#replay-video').removeAttribute('src');
  $('#screen').classList.remove('hidden');
  if (live) {
    $('#screen').removeAttribute('src');
    $('#screen-empty').classList.remove('hidden');
  } else {
    // Show the last screenshot of a finished run.
    const last = [...run.tests].reverse().find((t) => t.screenshot);
    if (last) {
      $('#screen').src = `/api/runs/${run.id}/${last.screenshot}`;
      $('#screen-empty').classList.add('hidden');
    } else {
      $('#screen').removeAttribute('src');
      $('#screen-empty').classList.remove('hidden');
    }
  }
  render();
}

function render() {
  renderControls();
  const run = state.run;
  if (!run) return;
  const running = ACTIVE.includes(run.status);
  $('#run-status').textContent = run.status;
  $('#run-status').className = `pill ${run.status}`;
  $('#spinner').classList.toggle('hidden', !running || run.status === 'paused');
  const elapsed = running && run.startedAt ? ` · ${dur(Date.now() - new Date(run.startedAt).getTime())}` : '';
  $('#activity-text').textContent = running ? `${run.activity || run.status}${elapsed}` : run.error ? `Error: ${run.error}` : `Finished ${run.status} in ${dur(run.durationMs)}.`;
  $('#addr').textContent = run.currentUrl || run.url;
  renderTests(run);
  renderLog(run);
  renderFailures(run);
  renderErrors(run);
  renderResult(run);
}

function renderControls() {
  const run = state.run;
  const activeShown = run && state.live && ACTIVE.includes(run.status);
  $('#btn-run').disabled = !!state.activeRunId;
  $('#btn-pause').disabled = !activeShown;
  $('#btn-stop').disabled = !activeShown;
  const paused = run?.status === 'paused';
  if ($('#btn-pause').dataset.paused !== String(paused)) {
    $('#btn-pause').dataset.paused = String(paused);
    $('#btn-pause').innerHTML = paused
      ? '<svg class="ico" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>Resume'
      : '<svg class="ico" viewBox="0 0 16 16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>Pause';
  }
}

function renderTests(run) {
  $('#analysis').textContent = run.analysis ? `AI: ${run.analysis}` : '';
  $('#plan-count').textContent = run.tests.length ? `${run.tests.length} test${run.tests.length > 1 ? 's' : ''}` : '';
  if (!run.tests.length) {
    $('#tests').innerHTML = `<li class="empty">${ACTIVE.includes(run.status) ? 'The AI is reading the page and planning test cases…' : 'No test cases.'}</li>`;
    return;
  }
  $('#tests').innerHTML = run.tests
    .map((t, i) => {
      const open = state.open.has(i);
      const steps = (t.steps || [])
        .map((s) => `<li><span class="dot ${esc(s.status)}"></span><span>${esc(s.description)}${s.error ? ` <span class="err">— ${esc(s.error)}</span>` : ''}</span></li>`)
        .join('');
      return `<li class="test ${esc(t.status)}" data-i="${i}">
        <div class="test-head"><span class="dot ${esc(t.status)}"></span><span class="title">${i + 1}. ${esc(t.title)}</span><span class="pill ${esc(t.status)}">${esc(t.status)}</span></div>
        ${open ? `<div class="test-body">
          ${t.plan ? `<p><b>Steps:</b> ${esc(t.plan)}</p>` : ''}
          ${t.expected ? `<p><b>Expected:</b> ${esc(t.expected)}</p>` : ''}
          ${t.reason ? `<p><b>Result:</b> ${esc(t.reason)}${t.durationMs ? ` (${dur(t.durationMs)})` : ''}</p>` : ''}
          ${steps ? `<ul class="test-steps">${steps}</ul>` : ''}
        </div>` : ''}
      </li>`;
    })
    .join('');
}
$('#tests').addEventListener('click', (e) => {
  const li = e.target.closest('.test');
  if (!li || !e.target.closest('.test-head')) return;
  const i = Number(li.dataset.i);
  state.open.has(i) ? state.open.delete(i) : state.open.add(i);
  render();
});

function timeline(run) {
  const items = run.log.map((l) => ({ t: l.t, cls: l.level, text: l.text }));
  run.tests.forEach((t) =>
    (t.steps || []).forEach((s) => {
      if (s.status !== 'running') items.push({ t: s.startedAt + 1, cls: `step ${s.status}`, text: `${s.description}${s.note && !s.description.includes(s.note) ? `  [${s.note}]` : ''}${s.error ? ` — ${s.error}` : ''}${s.durationMs != null ? `  (${dur(s.durationMs)})` : ''}` });
    })
  );
  return items.sort((a, b) => a.t - b.t);
}

function renderLog(run) {
  const box = $('#pane-log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const t0 = new Date(run.startedAt || Date.now()).getTime();
  $('#log').innerHTML = timeline(run)
    .map((l) => `<li class="${esc(l.cls)}"><span class="ts">+${((l.t - t0) / 1000).toFixed(1)}s</span><span class="msg">${esc(l.text)}</span></li>`)
    .join('') || '<li><span></span><span class="msg muted">No events yet.</span></li>';
  if (atBottom || state.live) box.scrollTop = box.scrollHeight;
}

function renderFailures(run) {
  const failed = run.tests.map((t, i) => ({ t, i })).filter(({ t }) => t.status === 'failed');
  $('#cnt-fail').textContent = failed.length || '';
  $('#failures').innerHTML = failed.length
    ? failed
        .map(({ t, i }) => {
          const ex = t.explanation;
          return `<div class="fail-item"><h3>${i + 1}. ${esc(t.title)}</h3>
          <div class="small">${esc(t.reason)}</div>
          ${ex ? `<div class="explain"><b>${esc(ex.summary)}</b> <span class="pill">${esc(ex.category)}</span><p>${esc(ex.details)}</p><p><b>Suggestion:</b> ${esc(ex.suggestion)}</p></div>` : state.live ? '<p class="muted small">AI analysis pending…</p>' : ''}
          ${t.screenshot ? `<a href="/api/runs/${esc(run.id)}/${esc(t.screenshot)}" target="_blank"><img src="/api/runs/${esc(run.id)}/${esc(t.screenshot)}" alt="Screenshot at failure" loading="lazy"></a>` : ''}
        </div>`;
        })
        .join('')
    : '<p class="muted">No failures.</p>';
}

function renderErrors(run) {
  $('#cnt-console').textContent = run.consoleErrors.length || '';
  $('#cnt-network').textContent = run.networkErrors.length || '';
  $('#console').innerHTML = run.consoleErrors.map((c) => `<tr><td>${esc(c.type)}</td><td>${esc(c.text)}${c.url ? `<div class="muted small">${esc(c.url)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No console errors.</td></tr>';
  $('#network').innerHTML = run.networkErrors.map((n) => `<tr><td>${esc(n.status || n.failure)}</td><td>${esc(n.method)}</td><td class="url">${esc(n.url)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No failed requests.</td></tr>';
}

function renderResult(run) {
  const done = !ACTIVE.includes(run.status);
  $('#result-card').classList.toggle('hidden', !done);
  if (!done) return;
  const s = run.summary || { passed: 0, failed: 0, skipped: 0 };
  $('#result-status').textContent = run.status;
  $('#result-status').className = `pill ${run.status}`;
  $('#r-pass').textContent = s.passed;
  $('#r-fail').textContent = s.failed;
  $('#r-skip').textContent = s.skipped;
  $('#r-dur').textContent = dur(run.durationMs);
  const a = run.artifacts || {};
  const f = (name) => `/api/runs/${run.id}/files/${name}`;
  $('#artifacts').innerHTML = [
    a.report && `<a class="btn small" href="${f('report.html')}" target="_blank">Open report</a><a class="btn small" href="${f('report.html')}?download=1">⬇ Report</a>`,
    a.video && `<button class="btn small" id="btn-video">Watch video</button><a class="btn small" href="${f('video.webm')}?download=1">⬇ Video</a>`,
    a.trace && `<a class="btn small" href="${f('trace.zip')}?download=1" title="Open with: npx playwright show-trace trace.zip, or drop it on trace.playwright.dev">⬇ Trace</a>`,
  ].filter(Boolean).join('');
  $('#btn-video')?.addEventListener('click', () => {
    const v = $('#replay-video');
    v.src = f('video.webm');
    v.classList.remove('hidden');
    $('#screen').classList.add('hidden');
    $('#screen-empty').classList.add('hidden');
    v.play().catch(() => {});
  });
  const hasRecording = run.tests.some((t) => (t.recorded || []).length > 1);
  $('#btn-replay').classList.toggle('hidden', run.mode !== 'ai');
  $('#btn-replay').disabled = !hasRecording || !!state.activeRunId;
  $('#btn-save-script').disabled = run.mode === 'ai' ? !hasRecording : true;
  $('#btn-rerun').disabled = !!state.activeRunId;
}

// ------------------------------------------------------------------ run controls
$('#run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#form-error').textContent = '';
  try {
    const body = state.mode === 'ai' ? { mode: 'ai', url: $('#in-url').value.trim(), goal: $('#in-goal').value.trim() } : { mode: 'script', scriptId: $('#in-script').value };
    await api('/api/runs', { method: 'POST', body });
  } catch (err) {
    $('#form-error').textContent = err.message;
  }
});
$('#btn-pause').addEventListener('click', () => state.run && api(`/api/runs/${state.run.id}/${state.run.status === 'paused' ? 'resume' : 'pause'}`, { method: 'POST' }).catch((e) => toast(e.message)));
$('#btn-stop').addEventListener('click', () => state.run && api(`/api/runs/${state.run.id}/stop`, { method: 'POST' }).catch((e) => toast(e.message)));

async function rerun(id, replay) {
  try {
    await api(`/api/runs/${id}/rerun`, { method: 'POST', body: { replay } });
    setView('run');
  } catch (err) {
    toast(err.message);
  }
}
$('#btn-rerun').addEventListener('click', () => state.run && rerun(state.run.id, false));
$('#btn-replay').addEventListener('click', () => state.run && rerun(state.run.id, true));
$('#btn-save-script').addEventListener('click', async () => {
  if (!state.run) return;
  const name = prompt('Script name', `${new URL(state.run.url).hostname}: ${state.run.goal}`.slice(0, 100));
  if (name === null) return;
  try {
    const s = await api(`/api/runs/${state.run.id}/save-script`, { method: 'POST', body: { name } });
    toast(`Saved script "${s.name}"`);
    state.script = s;
    setView('scripts');
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ history
async function loadHistory() {
  const runs = await api('/api/runs');
  $('#history').innerHTML = runs.length
    ? runs
        .map((r) => {
          const s = r.summary || {};
          return `<tr data-id="${esc(r.id)}">
          <td>${esc(new Date(r.startedAt).toLocaleString())}</td>
          <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
          <td><div>${esc(r.mode === 'script' ? `Script: ${r.scriptName}` : `AI: ${r.goal}`)}</div><div class="muted small">${esc(r.url)}</div></td>
          <td>${s.total != null ? `<span class="c-pass">${s.passed} passed</span> · <span class="c-fail">${s.failed} failed</span>${s.skipped ? ` · <span class="c-skip">${s.skipped} skipped</span>` : ''}` : '–'}</td>
          <td>${dur(r.durationMs)}</td>
          <td class="small">${esc(r.mode === 'ai' ? r.model : '—')}</td>
          <td class="actions">
            <button class="btn small" data-act="open">Open</button>
            <button class="btn small" data-act="rerun" title="${r.mode === 'ai' ? 'Run the goal again with the AI' : 'Run the script again'}">↻ Re-run</button>
            ${r.mode === 'ai' ? '<button class="btn small" data-act="replay" title="Replay recorded steps without AI">Replay</button>' : ''}
            <a class="btn small" href="/api/runs/${esc(r.id)}/files/report.html" target="_blank">Report</a>
            <button class="btn small danger" data-act="delete" title="Delete run">Delete</button>
          </td></tr>`;
        })
        .join('')
    : '<tr><td colspan="7" class="muted">No runs yet.</td></tr>';
}
$('#btn-refresh-history').addEventListener('click', loadHistory);
$('#history').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const id = e.target.closest('tr')?.dataset.id;
  if (!act || !id) return;
  if (act === 'open') {
    const run = await api(`/api/runs/${id}`);
    state.open = new Set(run.tests.map((_, i) => i).filter((i) => run.tests[i].status === 'failed'));
    showRun(run, id === state.activeRunId);
    setView('run');
  } else if (act === 'rerun' || act === 'replay') rerun(id, act === 'replay');
  else if (act === 'delete' && confirm('Delete this run and its artifacts?')) {
    await api(`/api/runs/${id}`, { method: 'DELETE' }).catch((err) => toast(err.message));
    loadHistory();
  }
});

// ------------------------------------------------------------------ scripts
const editable = (s) => ({ name: s.name, url: s.url, ...(s.goal ? { goal: s.goal } : {}), tests: s.tests });
const TEMPLATE = {
  name: 'New script',
  url: 'https://example.com/',
  tests: [{ title: 'Home page shows heading', steps: [{ action: 'goto', value: 'https://example.com/' }, { action: 'assert_text', value: 'Example Domain' }] }],
};

async function loadScripts() {
  state.scripts = await api('/api/scripts');
  if (state.script) state.script = state.scripts.find((s) => s.id === state.script.id) || state.script;
  $('#script-list').innerHTML = state.scripts.map((s) => `<li data-id="${esc(s.id)}" class="${state.script?.id === s.id ? 'active' : ''}"><b>${esc(s.name)}</b><span>${s.tests.length} test(s) · ${esc(s.url)}</span></li>`).join('') || '<li class="muted">No scripts yet. Save one from an AI run or click + New.</li>';
  const sel = $('#in-script');
  const prev = sel.value;
  sel.innerHTML = state.scripts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') || '<option value="">No saved scripts</option>';
  if (prev && state.scripts.some((s) => s.id === prev)) sel.value = prev;
  updateScriptHint();
  if (!state.script && state.scripts.length) state.script = state.scripts[0];
  openScript(state.script);
}
function updateScriptHint() {
  const s = state.scripts.find((x) => x.id === $('#in-script').value);
  $('#script-hint').textContent = s ? `${s.url} · ${s.tests.length} test(s), ${s.tests.reduce((n, t) => n + t.steps.length, 0)} steps. Replays without the AI; the AI only explains failures.` : '';
}
$('#in-script').addEventListener('change', updateScriptHint);

function openScript(s) {
  state.script = s;
  $$('#script-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === s?.id));
  $('#script-title').textContent = s?.id ? s.name : 'New script';
  $('#script-json').value = JSON.stringify(editable(s || TEMPLATE), null, 2);
  $('#btn-script-export').href = s?.id ? `/api/scripts/${s.id}/export` : '#';
  $('#btn-script-export').classList.toggle('hidden', !s?.id);
  $('#btn-script-delete').classList.toggle('hidden', !s?.id);
  $('#script-error').textContent = '';
}
$('#script-list').addEventListener('click', (e) => {
  const id = e.target.closest('li')?.dataset.id;
  if (id) openScript(state.scripts.find((s) => s.id === id));
});
$('#btn-new-script').addEventListener('click', () => openScript({ ...TEMPLATE }));

async function saveScript() {
  $('#script-error').textContent = '';
  let body;
  try {
    body = JSON.parse($('#script-json').value);
  } catch (err) {
    $('#script-error').textContent = `Invalid JSON: ${err.message}`;
    throw err;
  }
  try {
    const s = state.script?.id ? await api(`/api/scripts/${state.script.id}`, { method: 'PUT', body }) : await api('/api/scripts', { method: 'POST', body });
    state.script = s;
    await loadScripts();
    return s;
  } catch (err) {
    $('#script-error').textContent = err.message;
    throw err;
  }
}
$('#btn-script-save').addEventListener('click', () => saveScript().then((s) => toast(`Saved "${s.name}"`)).catch(() => {}));
$('#btn-script-run').addEventListener('click', async () => {
  try {
    const s = await saveScript();
    await api('/api/runs', { method: 'POST', body: { mode: 'script', scriptId: s.id } });
    setView('run');
  } catch (err) {
    if (err.message && !$('#script-error').textContent) toast(err.message);
  }
});
$('#btn-script-delete').addEventListener('click', async () => {
  if (!state.script?.id || !confirm(`Delete script "${state.script.name}"?`)) return;
  await api(`/api/scripts/${state.script.id}`, { method: 'DELETE' });
  state.script = null;
  loadScripts();
});

// ------------------------------------------------------------------ status & settings
const SUGGESTED = [
  ['qwen3-vl:2b-instruct', 'smallest vision + tools model; low-RAM CPUs'],
  ['qwen3-vl:4b-instruct', 'default for CPU-only machines (≥8 GB RAM)'],
  ['qwen3-vl:8b-instruct', 'GPUs with ≥8 GB VRAM'],
  ['qwen3-vl:30b-a3b-instruct', 'GPUs with ≥24 GB VRAM (fast MoE)'],
  ['qwen2.5:7b', 'text-only, strong JSON/tool use'],
];
$('#suggest').innerHTML = SUGGESTED.map(([m, d]) => `<li><code data-m="${m}">${m}</code> — ${d}</li>`).join('');
$('#suggest').addEventListener('click', (e) => e.target.dataset.m && ($('#pull-name').value = e.target.dataset.m));

async function loadStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    const model = s.settings.model;
    if (!s.ollama.ok) setChip('#chip-ollama', 'err', `Ollama offline`, s.ollama.error);
    else if (!s.modelReady) setChip('#chip-ollama', 'warn', `${model} (downloading…)`, 'Model is being pulled');
    else setChip('#chip-ollama', 'ok', model, `Ollama ${s.ollama.version} at ${s.ollama.url}`);
    $('#s-ollama').textContent = s.ollama.ok ? `v${s.ollama.version} at ${s.ollama.url}` : `offline (${s.ollama.error}) at ${s.ollama.url}`;
    $('#s-hw').textContent = s.hardware;
    $('#s-reason').textContent = s.modelReason || 'Set via OLLAMA_MODEL / Settings.';
    $('#s-browser').textContent = s.browser;
    const names = s.ollama.models.map((m) => m.name).filter((n) => !/embed/.test(n));
    const opts = (cur, allowEmpty) => [...(allowEmpty ? [''] : []), ...new Set([...(cur ? [cur] : []), ...names])].map((n) => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${n ? esc(n) + (names.includes(n) ? '' : ' (not installed)') : '— none (text only) —'}</option>`).join('');
    if (document.activeElement?.closest('#settings-form') == null) {
      $('#s-model').innerHTML = opts(model);
      $('#s-vision').innerHTML = opts(s.settings.visionModel, true);
      $('#s-maxtests').value = s.settings.maxTests;
      $('#s-maxsteps').value = s.settings.maxStepsPerTest;
    }
    $('#installed').innerHTML = s.ollama.models.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.params || '')}</td><td>${(m.size / 1e9).toFixed(1)} GB</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>';
    Object.entries(s.pulls || {}).forEach(([m, st]) => renderPull(m, st));
    if (!state.activeRunId && s.activeRun) {
      state.activeRunId = s.activeRun.id;
      showRun(s.activeRun, true);
    }
  } catch (err) {
    setChip('#chip-ollama', 'err', 'Server unreachable', err.message);
  }
}

function renderPull(model, st) {
  let el = $(`#pulls [data-m="${CSS.escape(model)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.m = model;
    $('#pulls').append(el);
  }
  el.innerHTML = `<div><b>${esc(model)}</b> — ${esc(st.status === 'pulling' ? st.detail : st.status === 'ready' ? 'installed ✓' : `error: ${st.detail}`)}${st.pct != null && st.status === 'pulling' ? ` ${st.pct}%` : ''}</div>${st.status === 'pulling' ? `<div class="progress"><i style="width:${st.pct || 0}%"></i></div>` : ''}`;
  if (st.status === 'ready') loadStatus();
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', { method: 'POST', body: { model: $('#s-model').value, visionModel: $('#s-vision').value, maxTests: $('#s-maxtests').value, maxStepsPerTest: $('#s-maxsteps').value } });
    $('#settings-saved').textContent = 'Saved ✓ (missing models are pulled automatically)';
    setTimeout(() => ($('#settings-saved').textContent = ''), 4000);
    loadStatus();
  } catch (err) {
    toast(err.message);
  }
});
$('#pull-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#pull-name').value.trim();
  if (!name) return;
  try {
    await api('/api/models/pull', { method: 'POST', body: { name } });
    renderPull(name, { status: 'pulling', detail: 'starting', pct: 0 });
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ boot
setInterval(() => state.live && scheduleRender(), 1000); // keeps the elapsed timer moving
setInterval(loadStatus, 15000);
connect();
loadStatus();
loadScripts();
let initialView = 'run';
try { initialView = localStorage.getItem('qa.view') || 'run'; } catch { /* storage unavailable */ }
setView(initialView);
