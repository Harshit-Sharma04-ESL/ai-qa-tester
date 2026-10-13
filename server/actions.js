// Executes one test step against a Playwright page. Shared by AI runs and saved-script replays.
//
// Step format (also the saved-script format):
//   { action, target?: { ref?, css?, role?, name?, label?, placeholder?, text? }, value?, note? }

export const INTERACTIONS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'scroll', 'wait', 'back'];
export const ASSERTIONS = ['assert_text', 'assert_no_text', 'assert_url', 'assert_visible', 'assert_title'];
export const ACTIONS = [...INTERACTIONS, ...ASSERTIONS];
const NEEDS_TARGET = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'assert_visible'];

const esc = (s) => String(s).replace(/"/g, '\\"');

/** Locator for a target: live ref during AI runs, otherwise the first candidate strategy that matches. */
export async function resolveTarget(page, target) {
  if (!target) return null;
  if (target.ref) {
    const loc = page.locator(`[data-qa-ref="${esc(target.ref)}"]`);
    if (await loc.count()) return loc.first();
  }
  const candidates = [];
  if (target.css) candidates.push(() => page.locator(target.css));
  if (target.role && target.name) candidates.push(() => page.getByRole(target.role, { name: target.name, exact: true }));
  if (target.label) candidates.push(() => page.getByLabel(target.label, { exact: true }));
  if (target.placeholder) candidates.push(() => page.getByPlaceholder(target.placeholder, { exact: true }));
  if (target.text) candidates.push(() => page.getByText(target.text, { exact: true }));
  if (target.role && target.name) candidates.push(() => page.getByRole(target.role, { name: target.name }));
  let fallback = null;
  for (const make of candidates) {
    const loc = make();
    let n = 0;
    try {
      n = await loc.count();
    } catch { /* invalid selector */ }
    if (n === 1) return loc;
    if (n > 1 && !fallback) fallback = loc.first();
  }
  if (fallback) return fallback;
  // Nothing yet: wait briefly on the primary strategy (element may still be rendering).
  return candidates.length ? candidates[0]().first() : null;
}

/** Wait (bounded) for the page to settle after an interaction. */
export async function settle(page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 1500 });
  } catch { /* busy pages never go idle; that's fine */ }
}

async function poll(fn, timeout) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => false);
    if (last) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function describeStep(step) {
  const t = step.target;
  const who = t ? t.name || t.label || t.placeholder || t.text || t.css || t.ref : '';
  const v = step.value !== undefined && step.value !== '' ? ` "${step.action === 'fill' && /pass/i.test(who + (t?.css || '')) ? '••••' : step.value}"` : '';
  return `${step.action}${who ? ` ${who}` : ''}${v}`;
}

/** Run a single step. Throws with a readable message on failure. */
export async function runStep(page, step, { timeout = 8000, baseUrl } = {}) {
  const { action } = step;
  const value = step.value ?? '';
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}"`);
  if (NEEDS_TARGET.includes(action) && !step.target) throw new Error(`Action "${action}" needs a target element`);
  const loc = step.target ? await resolveTarget(page, step.target) : null;
  if (step.target && !loc) throw new Error('Target element not found on the page');

  switch (action) {
    case 'goto': {
      const url = new URL(value || baseUrl, page.url() !== 'about:blank' ? page.url() : baseUrl).toString();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    }
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded' });
      break;
    case 'click':
      await loc.click({ timeout });
      break;
    case 'fill':
      await loc.fill(String(value), { timeout });
      break;
    case 'select':
      await loc.selectOption({ label: value }, { timeout }).catch(() => loc.selectOption(value, { timeout }));
      break;
    case 'check':
      await loc.check({ timeout });
      break;
    case 'uncheck':
      await loc.uncheck({ timeout });
      break;
    case 'hover':
      await loc.hover({ timeout });
      break;
    case 'press':
      if (loc) await loc.press(value || 'Enter', { timeout });
      else await page.keyboard.press(value || 'Enter');
      break;
    case 'scroll':
      if (loc) await loc.scrollIntoViewIfNeeded({ timeout });
      else await page.mouse.wheel(0, /up/i.test(value) ? -600 : 600);
      break;
    case 'wait':
      await page.waitForTimeout(Math.min(Number(value) || 1000, 10_000));
      break;
    case 'assert_text': {
      const ok = await poll(async () => norm(await page.locator('body').innerText()).includes(norm(value)), timeout);
      if (!ok) throw new Error(`Expected page to contain text "${value}"`);
      return { assertion: true };
    }
    case 'assert_no_text': {
      await page.waitForTimeout(500);
      const has = norm(await page.locator('body').innerText()).includes(norm(value));
      if (has) throw new Error(`Expected page NOT to contain text "${value}"`);
      return { assertion: true };
    }
    case 'assert_url': {
      const ok = await poll(async () => norm(page.url()).includes(norm(value)), timeout);
      if (!ok) throw new Error(`Expected URL to contain "${value}" but it is "${page.url()}"`);
      return { assertion: true };
    }
    case 'assert_title': {
      const ok = await poll(async () => norm(await page.title()).includes(norm(value)), timeout);
      if (!ok) throw new Error(`Expected title to contain "${value}" but it is "${await page.title()}"`);
      return { assertion: true };
    }
    case 'assert_visible': {
      const ok = await poll(() => loc.isVisible(), timeout);
      if (!ok) throw new Error('Expected element to be visible');
      return { assertion: true };
    }
  }
  if (action !== 'wait') await settle(page);
  return { assertion: false };
}
