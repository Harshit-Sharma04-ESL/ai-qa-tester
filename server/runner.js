// A single test run: owns the browser, live screencast, step log, artifacts and persistence.
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import config from './config.js';
import { newId, runDir, saveRun } from './store.js';
import { runStep, settle, describeStep } from './actions.js';
import { planTests, executeTest, explainFailure } from './agent.js';
import { ensureModel, hasModel } from './ollama.js';
import { renderReport } from './report.js';

class StopError extends Error {
  constructor() {
    super('Stopped by user');
  }
}

async function launchBrowser() {
  if (!config.browserWs) return chromium.launch({ headless: true });
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      return await chromium.connect(config.browserWs, { timeout: 15_000 });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`Cannot reach browser service at ${config.browserWs}: ${lastErr?.message}`);
}

const cleanTarget = (t) => {
  if (!t) return undefined;
  const out = {};
  for (const k of ['css', 'role', 'name', 'label', 'placeholder', 'text']) if (t[k]) out[k] = t[k];
  return Object.keys(out).length ? out : undefined;
};

export class TestRun {
  /**
   * @param {object} p  { mode: 'ai'|'script', url, goal?, script?, settings, rerunOf? }
   * @param {(msg: object) => void} broadcast
   */
  constructor(p, broadcast) {
    this.id = newId('r');
    this.mode = p.mode;
    this.url = p.url;
    this.goal = p.goal || '';
    this.script = p.script || null;
    this.settings = p.settings;
    this.rerunOf = p.rerunOf || null;
    this.status = 'queued';
    this.activity = '';
    this.analysis = '';
    this.tests = [];
    this.consoleErrors = [];
    this.networkErrors = [];
    this.log = [];
    this.artifacts = {};
    this.paused = false;
    this.stopped = false;
    this.abort = new AbortController();
    this.signal = this.abort.signal;
    this.broadcast = broadcast;
    this.lastFrame = null;
    this.startedAt = new Date().toISOString(); // set before the "started" broadcast so live timestamps are relative to it
  }

  data() {
    const { id, mode, url, goal, status, activity, analysis, tests, consoleErrors, networkErrors, log, artifacts, startedAt, endedAt, durationMs, summary, error, rerunOf } = this;
    return {
      id, mode, url, goal, status, activity, analysis, tests, consoleErrors, networkErrors, log, artifacts, startedAt, endedAt, durationMs, summary, error, rerunOf,
      model: this.settings.model,
      currentUrl: this.currentUrl,
      scriptId: this.script?.id,
      scriptName: this.script?.name,
      settings: this.settings,
    };
  }

  emit(type, payload = {}) {
    this.broadcast({ type, runId: this.id, ...payload });
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', { status, activity: this.activity });
  }

  setActivity(text) {
    this.activity = text;
    this.emit('status', { status: this.status, activity: text });
  }

  logMsg(level, text) {
    const entry = { t: Date.now(), level, text };
    this.log.push(entry);
    this.emit('log', { entry });
  }

  // ------------------------------------------------------------ control
  async checkpoint() {
    if (this.stopped) throw new StopError();
    while (this.paused && !this.stopped) await new Promise((r) => (this._resume = r));
    if (this.stopped) throw new StopError();
  }

  pause() {
    if (this.paused || ['done', 'passed', 'failed', 'stopped', 'error'].includes(this.status)) return;
    this.paused = true;
    this.statusBeforePause = this.status;
    this.setStatus('paused');
    this.logMsg('info', 'Paused (takes effect after the current action)');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.setStatus(this.statusBeforePause || 'running');
    this.logMsg('info', '▶ Resumed');
    this._resume?.();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.logMsg('warn', 'Stop requested');
    this.abort.abort();
    this.paused = false;
    this._resume?.();
  }

  // ------------------------------------------------------------ step log hooks used by agent.js
  addThought(test, th) {
    test.thoughts.push(th);
    this.emit('thought', { testIndex: this.tests.indexOf(test), thought: th });
    const llm = th.llm ? ` (${(th.llm.ms / 1000).toFixed(1)}s)` : '';
    this.logMsg('ai', `${th.thought || '…'}${th.verdict !== 'continue' ? ` → verdict: ${th.verdict}` : ''}${llm}`);
  }

  addStep(test, step) {
    const rec = { ...step, startedAt: Date.now() };
    test.steps.push(rec);
    this.emit('step', { testIndex: this.tests.indexOf(test), stepIndex: test.steps.length - 1, step: rec });
    return rec;
  }

  finishStep(test, rec, patch) {
    Object.assign(rec, patch);
    this.emit('step', { testIndex: this.tests.indexOf(test), stepIndex: test.steps.indexOf(rec), step: rec });
  }

  // ------------------------------------------------------------ browser plumbing
  attachPage(page) {
    const cap = (list, item, kind) => {
      if (list.length >= 200) return;
      list.push({ t: Date.now(), ...item });
      this.emit(kind, { item });
    };
    page.on('console', (m) => {
      // "Failed to load resource" duplicates what the network listeners already record.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) cap(this.consoleErrors, { type: 'console.error', text: m.text().slice(0, 500), url: m.location()?.url }, 'console');
    });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || page !== this.page) return;
      this.currentUrl = f.url();
      this.emit('nav', { url: this.currentUrl });
    });
    page.on('pageerror', (e) => cap(this.consoleErrors, { type: 'uncaught exception', text: String(e.message).slice(0, 500) }, 'console'));
    page.on('requestfailed', (r) => {
      const failure = r.failure()?.errorText || 'failed';
      if (!/ERR_ABORTED/.test(failure)) cap(this.networkErrors, { method: r.method(), url: r.url().slice(0, 300), failure }, 'network');
    });
    page.on('response', (r) => {
      if (r.status() >= 400) cap(this.networkErrors, { method: r.request().method(), url: r.url().slice(0, 300), status: r.status() }, 'network');
    });
  }

  async startScreencast(page) {
    try {
      await this.cdp?.detach();
    } catch { /* old page gone */ }
    try {
      const cdp = await this.context.newCDPSession(page);
      this.cdp = cdp;
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        this.lastFrame = data;
        this.emit('frame', { data });
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: config.viewport.width, maxHeight: config.viewport.height, everyNthFrame: 1 });
    } catch (err) {
      this.logMsg('warn', `Live view unavailable: ${err.message}`);
    }
  }

  /** Fresh session for each test: no cookies/storage, back on the start URL. */
  async resetForTest(first) {
    if (first && this.page.url() === this.url) return; // context is brand new and already there
    // Extra tabs from the previous test are closed; the agent continues in the main tab.
    for (const p of this.context.pages()) if (p !== this.mainPage) await p.close().catch(() => {});
    if (this.page !== this.mainPage) {
      this.page = this.mainPage;
      await this.startScreencast(this.page);
    }
    await this.context.clearCookies();
    try {
      await this.page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
    } catch { /* storage may be blocked */ }
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(this.page);
  }

  // ------------------------------------------------------------ main flow
  async start() {
    const t0 = Date.now();
    this.dir = runDir(this.id);
    this.setStatus('starting');
    saveRun(this.data()); // visible in History while it runs
    this.logMsg('info', `Run ${this.id} started (${this.mode === 'ai' ? 'AI agent' : `script "${this.script?.name}"`}) → ${this.url}`);
    try {
      if (this.mode === 'ai') {
        this.setActivity(`Checking model ${this.settings.model}…`);
        await ensureModel(this.settings.model);
      }
      this.setActivity('Launching Chromium…');
      this.browser = await launchBrowser();
      this.context = await this.browser.newContext({
        viewport: config.viewport,
        recordVideo: { dir: path.join(this.dir, 'video-tmp'), size: config.viewport },
        ignoreHTTPSErrors: true,
      });
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      this.page = await this.context.newPage();
      this.mainPage = this.page;
      this.attachPage(this.page);
      this.context.on('page', async (p) => {
        // Follow popups / new tabs so the agent and live view stay on what the user would see.
        this.attachPage(p);
        this.page = p;
        this.logMsg('info', 'Switched to newly opened tab');
        await this.startScreencast(p);
      });
      await this.startScreencast(this.page);
      this.setActivity(`Opening ${this.url}`);
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(this.page);
      await this.checkpoint();

      if (this.mode === 'ai') await this.runAI();
      else await this.runScript();
    } catch (err) {
      if (this.stopped || err instanceof StopError || err.name === 'AbortError') {
        this.logMsg('warn', 'Run stopped by user');
      } else {
        this.error = err.message.split('\n')[0];
        this.logMsg('error', `Run error: ${this.error}`);
      }
    } finally {
      await this.finalize(t0);
    }
  }

  async runAI() {
    this.setStatus('planning');
    this.setActivity('Reading the page and planning test cases…');
    const plan = await planTests(this, this.page, this.goal);
    this.analysis = plan.analysis;
    this.tests = plan.tests.map((t) => ({ ...t, status: 'pending', steps: [], thoughts: [] }));
    this.logMsg('ai', `Planned ${this.tests.length} test case(s) in ${(plan.stats.ms / 1000).toFixed(1)}s: ${this.tests.map((t) => t.title).join(' · ')}`);
    this.emit('plan', { analysis: this.analysis, tests: this.tests });
    this.setStatus('running');
    saveRun(this.data());
    for (let i = 0; i < this.tests.length; i++) {
      await this.runTest(i, (test) => executeTest(this, test, this.url));
    }
  }

  async runScript() {
    this.tests = this.script.tests.map((t) => ({ title: t.title, plan: t.plan || '', expected: t.expected || '', status: 'pending', steps: [], thoughts: [], source: t.steps }));
    this.emit('plan', { analysis: '', tests: this.tests });
    this.setStatus('running');
    for (let i = 0; i < this.tests.length; i++) {
      await this.runTest(i, async (test) => {
        const steps = test.source;
        for (const [n, step] of steps.entries()) {
          if (n === 0 && step.action === 'goto' && (!step.value || step.value === this.url)) continue; // reset already loaded it
          await this.checkpoint();
          this.setActivity(`Step ${n + 1}/${steps.length}: ${describeStep(step)}`);
          const rec = this.addStep(test, { action: step.action, target: step.target, value: step.value, note: step.note, description: describeStep(step), status: 'running' });
          const st = Date.now();
          try {
            await runStep(this.page, step, { timeout: config.actionTimeoutMs, baseUrl: this.url });
            this.finishStep(test, rec, { status: 'passed', durationMs: Date.now() - st });
          } catch (err) {
            const msg = err.message.split('\n')[0].slice(0, 200);
            this.finishStep(test, rec, { status: 'failed', error: msg, durationMs: Date.now() - st });
            return { status: 'failed', reason: `Step ${n + 1} (${describeStep(step)}) failed: ${msg}` };
          }
        }
        return { status: 'passed', reason: 'All steps passed.' };
      });
    }
  }

  async runTest(i, fn) {
    const test = this.tests[i];
    await this.checkpoint();
    const t0 = Date.now();
    test.status = 'running';
    this.emit('test', { testIndex: i, test });
    this.logMsg('info', `▶ Test ${i + 1}/${this.tests.length}: ${test.title}`);
    let stopErr = null;
    try {
      this.setActivity(`Test ${i + 1}: resetting session`);
      await this.resetForTest(i === 0);
      const res = await fn(test);
      test.status = res.status;
      test.reason = res.reason;
    } catch (err) {
      if (this.stopped || err instanceof StopError || err.name === 'AbortError') {
        test.status = 'skipped';
        test.reason = 'Stopped by user';
        stopErr = new StopError();
      } else {
        test.status = 'failed';
        test.reason = `Error: ${err.message.split('\n')[0]}`;
      }
    }
    test.durationMs = Date.now() - t0;
    try {
      const rel = `screenshots/test-${i + 1}.png`;
      await this.page.screenshot({ path: path.join(this.dir, rel), timeout: 10_000 });
      test.screenshot = rel;
    } catch { /* page closed */ }

    // Steps that can be replayed later without the AI (failed step kept so replay reproduces the failure).
    const done = test.steps.filter((s) => s.status === 'passed' || (test.status === 'failed' && s === test.steps.at(-1) && s.status === 'failed'));
    test.recorded = [{ action: 'goto', value: this.url }, ...done.map((s) => ({ action: s.action, target: cleanTarget(s.target), value: s.value, note: s.note }))];

    this.logMsg({ passed: 'pass', failed: 'fail' }[test.status] || 'skip', `Test ${i + 1} ${test.status}: ${test.reason}`);
    this.emit('test', { testIndex: i, test });

    if (test.status === 'failed' && !this.stopped) await this.explain(test);
    saveRun(this.data());
    if (stopErr) throw stopErr;
  }

  async explain(test) {
    try {
      if (!(await hasModel(this.settings.model))) {
        this.logMsg('warn', 'AI failure analysis skipped: model not available');
        return;
      }
      this.setActivity('AI is analyzing the failure…');
      let screenshotB64;
      if (this.settings.visionModel && test.screenshot) screenshotB64 = fs.readFileSync(path.join(this.dir, test.screenshot)).toString('base64');
      test.explanation = await explainFailure(this, test, { screenshotB64, consoleErrors: this.consoleErrors, networkErrors: this.networkErrors });
      this.logMsg('ai', `Analysis: ${test.explanation.summary} [${test.explanation.category}] — ${test.explanation.suggestion}`);
      this.emit('test', { testIndex: this.tests.indexOf(test), test });
    } catch (err) {
      if (!this.stopped) this.logMsg('warn', `AI failure analysis failed: ${err.message}`);
    }
  }

  async finalize(t0) {
    this.setActivity('Saving video, trace and report…');
    for (const t of this.tests) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'skipped';
        t.reason = t.reason || (this.stopped ? 'Stopped by user' : 'Not run');
      }
    }
    try {
      await this.cdp?.send('Page.stopScreencast');
    } catch { /* ignore */ }
    if (this.context) {
      try {
        await this.context.tracing.stop({ path: path.join(this.dir, 'trace.zip') });
        this.artifacts.trace = 'trace.zip';
      } catch (err) {
        this.logMsg('warn', `Trace not saved: ${err.message}`);
      }
      const video = this.mainPage?.video();
      await this.context.close().catch(() => {});
      if (video) {
        try {
          await video.saveAs(path.join(this.dir, 'video.webm'));
          await video.delete().catch(() => {});
          this.artifacts.video = 'video.webm';
        } catch (err) {
          this.logMsg('warn', `Video not saved: ${err.message}`);
        }
      }
    }
    await this.browser?.close().catch(() => {});
    fs.rmSync(path.join(this.dir, 'video-tmp'), { recursive: true, force: true });

    const count = (s) => this.tests.filter((t) => t.status === s).length;
    this.summary = { total: this.tests.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped') };
    this.endedAt = new Date().toISOString();
    this.durationMs = Date.now() - t0;
    this.status = this.stopped ? 'stopped' : this.error && !this.tests.length ? 'error' : this.summary.failed || this.error ? 'failed' : 'passed';
    this.activity = '';
    try {
      fs.writeFileSync(path.join(this.dir, 'report.html'), renderReport(this.data(), this.dir));
      this.artifacts.report = 'report.html';
    } catch (err) {
      this.logMsg('error', `Report not written: ${err.message}`);
    }
    this.logMsg('info', `Finished: ${this.summary.passed} passed, ${this.summary.failed} failed, ${this.summary.skipped} skipped in ${(this.durationMs / 1000).toFixed(1)}s`);
    saveRun(this.data());
    this.emit('done', { run: this.data() });
  }
}
