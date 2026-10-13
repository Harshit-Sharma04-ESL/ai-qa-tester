// The AI QA engineer: plans test cases from a goal, decides browser actions turn by turn,
// and explains failures in plain language. All LLM calls use JSON-schema constrained output.
import { chatJSON } from './ollama.js';
import { takeSnapshot, formatSnapshot } from './snapshot.js';
import { ACTIONS, ASSERTIONS, INTERACTIONS, runStep, describeStep } from './actions.js';
import config from './config.js';

const str = { type: 'string' };

// ---------------------------------------------------------------- planning
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    analysis: str,
    tests: {
      type: 'array',
      items: { type: 'object', properties: { title: str, steps: str, expected: str }, required: ['title', 'steps', 'expected'] },
    },
  },
  required: ['analysis', 'tests'],
};

const PLAN_SYSTEM = `You are a senior QA automation engineer. Design end-to-end test cases for a web page.
Reply with JSON: {"analysis": one sentence about what the page does, "tests": [{"title", "steps", "expected"}]}.
Rules:
- Cover exactly what the goal asks for (happy path first, then negative/edge cases only if the goal asks for them).
- Every test starts from the start URL in a fresh, logged-out session. A user journey (e.g. log in, add to cart, check the badge) is ONE test that contains all of its steps; never split it into several tests. Repeat prerequisite steps such as logging in inside every test that needs them.
- "steps": one short line describing the user actions in order, with concrete test data (use demo credentials shown on the page when present). Name elements by their visible label, never by ref ids like e1.
- "expected": the observable result to verify (a message, a page, a URL). Do not invent exact message wording you cannot see on the page; describe the outcome instead (e.g. "an error message about the password is shown").
- Keep it focused: at most {MAX} tests.`;

export async function planTests(run, page, goal) {
  const snap = await takeSnapshot(page, { maxElements: config.maxElements, maxText: config.maxTextChars + 300 });
  const max = run.settings.maxTests;
  const { data, stats } = await chatJSON({
    model: run.settings.model,
    system: PLAN_SYSTEM.replace('{MAX}', max),
    user: `Goal: ${goal}\n\nStart page:\n${formatSnapshot(snap)}`,
    schema: PLAN_SCHEMA,
    signal: run.signal,
  });
  const tests = (data.tests || [])
    .filter((t) => t && t.title)
    .slice(0, max)
    .map((t) => ({ title: String(t.title).slice(0, 120), plan: String(t.steps || ''), expected: String(t.expected || '') }));
  if (!tests.length) tests.push({ title: goal.slice(0, 120), plan: goal, expected: 'The goal is achieved without errors' });
  return { analysis: data.analysis || '', tests, stats };
}

// ---------------------------------------------------------------- execution
const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    thought: str,
    actions: {
      type: 'array',
      items: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS }, ref: str, value: str }, required: ['action', 'ref', 'value'] },
    },
    verdict: { type: 'string', enum: ['continue', 'pass', 'fail'] },
    evidence: str,
    reason: str,
  },
  required: ['thought', 'actions', 'verdict', 'evidence', 'reason'],
};

const DECIDE_SYSTEM = `You are a senior QA automation engineer executing ONE test case in a real browser.
Each turn you get the test case, what you already did, and the current page. Reply with JSON:
{"thought": short reasoning, "actions": [up to 4 actions], "verdict": "continue" | "pass" | "fail", "evidence": exact text copied from the current page that proves the verdict (or ""), "reason": why}
Each action is {"action": name, "ref": element id like "e4" or "", "value": text or ""}.
Actions:
- fill(ref, value)  click(ref)  select(ref, value=option label)  check(ref)  uncheck(ref)  hover(ref)
- press(ref or "", value=key such as "Enter")  goto(value=url)  back()  scroll(value="down" or "up")  wait(value=milliseconds)
- assert_text(value=exact text that must be on the page)  assert_no_text(value)  assert_url(value=part of url)  assert_visible(ref)
Rules:
1. Only use refs from the CURRENT element list.
2. Batch the actions for one form, e.g. fill, fill, click. After an action that loads a new page the rest are skipped; you will see the new page next turn.
3. When the current page shows the expected result: verdict "pass" and put the exact proving text (e.g. a success or error message) in "evidence". You may add assert_* actions too.
4. verdict "fail" when the application clearly behaves differently from the expected result; quote what the page shows in "evidence" and explain in "reason".
5. Otherwise verdict "continue". Never give a verdict in the same turn as actions that change the page: look at the result first.
6. Use demo data shown on the page instead of inventing it.
7. Controls without a label are shown with the text next to them; pick the one next to the item the step is about. Do not click links that leave the app under test; if you ended up on the wrong page, use back() or goto(Start URL).
8. Judge "Expected" by its meaning, not its exact words: a different but equivalent message still passes. Decide as soon as the result is visible.
Example turn 1: {"thought":"Fill in the form and submit","actions":[{"action":"fill","ref":"e2","value":"alice"},{"action":"fill","ref":"e3","value":"secret"},{"action":"click","ref":"e4","value":""}],"verdict":"continue","evidence":"","reason":""}
Example turn 2: {"thought":"The welcome message is shown","actions":[],"verdict":"pass","evidence":"Welcome back, alice!","reason":"Logged in as expected"}`;

const NEEDS_ELEMENT = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'assert_visible'];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Models often quote an element's accessible name (e.g. a cart link labelled "Cart, 1 items")
 * rather than body text. Check those by role + name, which also pins the quoted value;
 * everything else becomes a body-text assertion.
 */
function evidenceStep(snap, evidence) {
  const n = norm(evidence);
  const el = snap.elements.find((e) => norm(e.name) === n) || (n.length >= 4 && snap.elements.find((e) => norm(e.name).includes(n)));
  if (el && el.role !== 'generic') {
    return { action: 'assert_visible', value: '', target: { ref: el.ref, role: el.role, name: el.name }, note: `evidence: ${el.role} "${el.name}"` };
  }
  return { action: 'assert_text', value: evidence, note: 'evidence for the pass verdict' };
}

const normRef = (r) => {
  const m = String(r || '').match(/\d+/);
  return m ? `e${m[0]}` : '';
};

/**
 * Execute one planned test case with the AI deciding each turn.
 * Returns { status: 'passed'|'failed', reason }.
 */
export async function executeTest(run, test, startUrl) {
  const history = [];
  let assertionsPassed = 0;
  let consecutiveErrors = 0;
  let verifyFailures = 0;
  let unverifiedPasses = 0;
  let lastAssertError = '';

  for (let turn = 1; turn <= run.settings.maxStepsPerTest; turn++) {
    await run.checkpoint();
    const page = run.page;
    const snap = await takeSnapshot(page, { maxElements: config.maxElements, maxText: config.maxTextChars });
    const byRef = new Map(snap.elements.map((e) => [e.ref, e]));
    const user = [
      `Overall goal: ${run.goal}`,
      `Start URL: ${startUrl}`,
      `Test case: ${test.title}`,
      `Steps: ${test.plan}`,
      `Expected: ${test.expected}`,
      `Already done:\n${history.length ? history.slice(-10).join('\n') : '(nothing yet)'}`,
      `Turn ${turn} of ${run.settings.maxStepsPerTest}.`,
      `Current page:\n${formatSnapshot(snap)}`,
    ].join('\n\n');

    run.setActivity(`Thinking (turn ${turn})…`);
    const { data, stats } = await chatJSON({ model: run.settings.model, system: DECIDE_SYSTEM, user, schema: DECIDE_SCHEMA, signal: run.signal });
    await run.checkpoint();
    const verdict = data.verdict || 'continue';
    const actions = (data.actions || []).slice(0, 4);
    run.addThought(test, { turn, thought: data.thought, verdict, evidence: data.evidence, reason: data.reason, llm: stats });

    let interacted = false;
    let turnAssertFailed = false;
    let turnAssertPassed = 0;
    const urlAtStart = page.url();

    for (const [i, a] of actions.entries()) {
      await run.checkpoint();
      const isAssert = ASSERTIONS.includes(a.action);
      if (interacted && !isAssert && page.url() !== urlAtStart) {
        history.push(`- skipped ${actions.length - i} action(s): the page changed`);
        break;
      }
      const ref = normRef(a.ref);
      const el = ref ? byRef.get(ref) : null;
      const step = {
        action: a.action,
        value: a.value ?? '',
        ...(el ? { target: { ref, ...el.locator } } : {}),
        note: el ? `${el.role} "${el.name}"` : undefined,
      };
      if (NEEDS_ELEMENT.includes(a.action) && !el) {
        const msg = ref ? `Ref ${ref} is not in the current element list` : `"${a.action}" needs a ref from the element list`;
        run.addStep(test, { ...step, status: 'failed', error: msg, description: describeStep(step) });
        history.push(`- ${a.action} ${a.ref}: ERROR ${msg}`);
        consecutiveErrors++;
        continue;
      }
      const rec = run.addStep(test, { ...step, status: 'running', description: describeStep(step) });
      const t0 = Date.now();
      try {
        await runStep(page, step, { timeout: config.actionTimeoutMs, baseUrl: startUrl });
        run.finishStep(test, rec, { status: 'passed', durationMs: Date.now() - t0 });
        history.push(`- ${describeStep(step)}: ok`);
        if (isAssert) {
          assertionsPassed++;
          turnAssertPassed++;
        } else if (INTERACTIONS.includes(a.action) && !['wait', 'scroll', 'hover'].includes(a.action)) interacted = true;
        consecutiveErrors = 0;
      } catch (err) {
        const msg = err.message.split('\n')[0].slice(0, 200);
        run.finishStep(test, rec, { status: 'failed', error: msg, durationMs: Date.now() - t0 });
        history.push(`- ${describeStep(step)}: FAILED ${msg}`);
        consecutiveErrors++;
        if (isAssert) {
          turnAssertFailed = true;
          lastAssertError = msg;
        }
        if (!isAssert) break; // the page may not be in the state the rest of the batch expects
      }
    }

    // Trailing close-button glyphs ("Saved! ×") are page chrome, not part of the message.
    const evidence = String(data.evidence || '').trim().replace(/[\s×✕✖]+$/u, '');
    if (verdict !== 'continue' && interacted) {
      history.push('- NOTE: verdict ignored because the page changed this turn; look at the new page first.');
    } else if (verdict === 'fail') {
      return { status: 'failed', reason: `${data.reason || 'The application did not behave as expected.'}${evidence ? ` Page shows: "${evidence}"` : ''}` };
    } else if (verdict === 'pass') {
      let verified = turnAssertPassed > 0 && !turnAssertFailed;
      let problem = turnAssertFailed ? lastAssertError : '';
      if (!verified && !turnAssertFailed && evidence) {
        // Turn the model's evidence into a real assertion (recorded, so replays check it too).
        const step = evidenceStep(snap, evidence);
        const rec = run.addStep(test, { ...step, status: 'running', description: describeStep(step) });
        const t0 = Date.now();
        try {
          await runStep(page, step, { timeout: 3000 });
          run.finishStep(test, rec, { status: 'passed', durationMs: Date.now() - t0 });
          verified = true;
        } catch (err) {
          problem = err.message.split('\n')[0];
          run.finishStep(test, rec, { status: 'failed', error: problem, durationMs: Date.now() - t0 });
        }
      }
      if (verified) return { status: 'passed', reason: data.reason || 'Expected result verified.' };
      if (problem) {
        if (++verifyFailures >= 2) return { status: 'failed', reason: `The expected result could not be verified on the page: ${problem}` };
        history.push(`- NOTE: your pass verdict could not be verified (${problem}). Copy the evidence text exactly from the page.`);
      } else {
        if (assertionsPassed > 0) return { status: 'passed', reason: data.reason || 'Expected result verified.' };
        if (++unverifiedPasses >= 2) return { status: 'passed', reason: `${data.reason || 'Expected result observed'} (judged by the AI without quoting on-page evidence)` };
        history.push('- NOTE: put the exact text from the page that proves the result in "evidence".');
      }
    }
    if (consecutiveErrors >= 4) return { status: 'failed', reason: 'Too many consecutive action errors; the page could not be driven as planned.' };
  }
  return { status: 'failed', reason: `Not completed within ${run.settings.maxStepsPerTest} turns.` };
}

// ---------------------------------------------------------------- failure analysis
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: str,
    category: { type: 'string', enum: ['application bug', 'test data or test design', 'environment or network', 'unclear'] },
    details: str,
    suggestion: str,
  },
  required: ['summary', 'category', 'details', 'suggestion'],
};

export async function explainFailure(run, test, { screenshotB64, consoleErrors = [], networkErrors = [] } = {}) {
  const page = run.page;
  let pageInfo = '';
  try {
    pageInfo = formatSnapshot(await takeSnapshot(page, { maxElements: 15, maxText: 500 }));
  } catch { /* page may be gone */ }
  const steps = test.steps.map((s, i) => `${i + 1}. ${s.description} → ${s.status}${s.error ? ` (${s.error})` : ''}`).join('\n');
  const visionModel = run.settings.visionModel;
  const user = [
    `Test case: ${test.title}`,
    test.expected ? `Expected: ${test.expected}` : '',
    `Failure: ${test.reason}`,
    `Steps executed:\n${steps || '(none)'}`,
    consoleErrors.length ? `Browser console errors:\n${consoleErrors.slice(-5).map((c) => c.text).join('\n')}` : '',
    networkErrors.length ? `Network errors:\n${networkErrors.slice(-5).map((n) => `${n.status || n.failure} ${n.method} ${n.url}`).join('\n')}` : '',
    pageInfo ? `Page at the moment of failure:\n${pageInfo}` : '',
    visionModel && screenshotB64 ? 'A screenshot of the page at the moment of failure is attached.' : '',
  ].filter(Boolean).join('\n\n');
  const { data } = await chatJSON({
    model: visionModel && screenshotB64 ? visionModel : run.settings.model,
    system: `You are a senior QA engineer writing a failure analysis for a non-technical reader.
Explain in plain language what went wrong, whether it looks like a real application bug, a problem with the test itself (wrong data, wrong expectation, flaky locator), or an environment/network problem, and what to do next.
Be careful with the category:
- "application bug" only when the page clearly shows wrong behaviour (an unexpected error, missing or wrong data, the wrong page, a crash).
- If the expected outcome is actually visible on the page in a different form (e.g. as an element label, a different wording, a count shown on a badge), the assertion was wrong: "test data or test design".
- Timeouts, failed requests unrelated to the feature, or an unreachable site: "environment or network".
Reply with JSON: {"summary": one sentence, "category", "details": 2-3 sentences, "suggestion": one sentence}.`,
    user,
    images: visionModel && screenshotB64 ? [screenshotB64] : undefined,
    schema: EXPLAIN_SCHEMA,
    signal: run.signal,
  });
  return data;
}
