// Self-contained HTML report (screenshots embedded as data URIs so the file works offline).
import fs from 'node:fs';
import path from 'node:path';

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dur = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

function img(dir, rel) {
  try {
    const b64 = fs.readFileSync(path.join(dir, rel)).toString('base64');
    return `<img src="data:image/png;base64,${b64}" alt="screenshot">`;
  } catch {
    return '';
  }
}

export function renderReport(run, dir) {
  const s = run.summary || {};
  const tests = run.tests
    .map((t, i) => {
      const steps = t.steps
        .map((st, j) => `<tr class="${h(st.status)}"><td>${j + 1}</td><td>${h(st.description)}</td><td><span class="pill ${h(st.status)}">${h(st.status)}</span></td><td>${dur(st.durationMs)}</td><td>${h(st.error || '')}</td></tr>`)
        .join('');
      const thoughts = (t.thoughts || []).map((th) => `<li><b>Turn ${th.turn}</b> (${h(th.verdict)}): ${h(th.thought)}${th.reason ? ` — <i>${h(th.reason)}</i>` : ''}</li>`).join('');
      const ex = t.explanation;
      return `<section class="test ${h(t.status)}">
  <h3><span class="pill ${h(t.status)}">${h(t.status)}</span> ${i + 1}. ${h(t.title)} <small>${dur(t.durationMs)}</small></h3>
  ${t.plan ? `<p><b>Steps:</b> ${h(t.plan)}</p>` : ''}
  ${t.expected ? `<p><b>Expected:</b> ${h(t.expected)}</p>` : ''}
  ${t.reason ? `<p><b>Result:</b> ${h(t.reason)}</p>` : ''}
  ${ex ? `<div class="explain"><b>Why it failed (${h(ex.category)}):</b> ${h(ex.summary)}<p>${h(ex.details)}</p><p><b>Suggestion:</b> ${h(ex.suggestion)}</p></div>` : ''}
  ${steps ? `<table><thead><tr><th>#</th><th>Step</th><th>Status</th><th>Time</th><th>Error</th></tr></thead><tbody>${steps}</tbody></table>` : '<p class="muted">No steps executed.</p>'}
  ${thoughts ? `<details><summary>AI reasoning (${t.thoughts.length} turns)</summary><ul>${thoughts}</ul></details>` : ''}
  ${t.screenshot ? `<figure>${img(dir, t.screenshot)}<figcaption>${t.status === 'failed' ? 'Screenshot at failure' : 'Final state'}</figcaption></figure>` : ''}
</section>`;
    })
    .join('\n');

  const cons = (run.consoleErrors || []).map((c) => `<tr><td>${h(c.type)}</td><td>${h(c.text)}</td><td>${h(c.url || '')}</td></tr>`).join('');
  const net = (run.networkErrors || []).map((n) => `<tr><td>${h(n.status || n.failure)}</td><td>${h(n.method)}</td><td class="url">${h(n.url)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test Report ${h(run.id)}</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--fg:#1d2330;--muted:#667085;--line:#e4e7ec;--pass:#0f7b4a;--passbg:#e3f6ec;--fail:#b42318;--failbg:#fde8e7;--skip:#7a5a00;--skipbg:#fdf3d7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b24;--fg:#e6e8ee;--muted:#98a2b3;--line:#2a3140;--pass:#5fd39a;--passbg:#12301f;--fail:#ff8a80;--failbg:#3a1614;--skip:#f2c94c;--skipbg:#33290d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:22px}h3{margin:0 0 8px;font-size:16px}h3 small{color:var(--muted);font-weight:400}
.meta{color:var(--muted);margin-bottom:16px;word-break:break-all}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.tile b{display:block;font-size:24px}
section.test,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
section.test.failed{border-left:4px solid var(--fail)}section.test.passed{border-left:4px solid var(--pass)}section.test.skipped{border-left:4px solid var(--skip)}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;text-transform:uppercase}
.pill.passed{background:var(--passbg);color:var(--pass)}.pill.failed{background:var(--failbg);color:var(--fail)}.pill.skipped,.pill.stopped{background:var(--skipbg);color:var(--skip)}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.url{word-break:break-all}.explain{background:var(--failbg);border-radius:8px;padding:10px 12px;margin:8px 0}.explain p{margin:6px 0 0}
figure{margin:12px 0 0}figure img{max-width:100%;border:1px solid var(--line);border-radius:8px}figcaption{color:var(--muted);font-size:12px}
.muted{color:var(--muted)}details{margin-top:8px}
</style></head><body><main>
<h1><span class="pill ${h(run.status)}">${h(run.status)}</span> Test report</h1>
<div class="meta">${h(run.mode === 'script' ? `Script: ${run.scriptName}` : `Goal: ${run.goal}`)}<br>URL: ${h(run.url)}<br>Run ${h(run.id)} · ${h(new Date(run.startedAt).toLocaleString())} · model ${h(run.model || 'n/a')}</div>
<div class="tiles">
<div class="tile">Total<b>${s.total ?? 0}</b></div><div class="tile">Passed<b style="color:var(--pass)">${s.passed ?? 0}</b></div>
<div class="tile">Failed<b style="color:var(--fail)">${s.failed ?? 0}</b></div><div class="tile">Skipped<b style="color:var(--skip)">${s.skipped ?? 0}</b></div>
<div class="tile">Duration<b>${dur(run.durationMs)}</b></div></div>
${run.analysis ? `<div class="card"><b>AI page analysis:</b> ${h(run.analysis)}</div>` : ''}
${run.error ? `<div class="card explain"><b>Run error:</b> ${h(run.error)}</div>` : ''}
${tests}
<div class="card"><h3>Console errors (${(run.consoleErrors || []).length})</h3>${cons ? `<table><thead><tr><th>Type</th><th>Message</th><th>Source</th></tr></thead><tbody>${cons}</tbody></table>` : '<p class="muted">None.</p>'}</div>
<div class="card"><h3>Network errors (${(run.networkErrors || []).length})</h3>${net ? `<table><thead><tr><th>Status</th><th>Method</th><th>URL</th></tr></thead><tbody>${net}</tbody></table>` : '<p class="muted">None.</p>'}</div>
<p class="muted">Video and Playwright trace for this run are available from the dashboard. Open a trace with <code>npx playwright show-trace trace.zip</code> or at trace.playwright.dev.</p>
</main></body></html>`;
}
