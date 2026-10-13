// Page "reading": extracts a compact, LLM-friendly view of the current page.
// Interactive elements get a ref (e1, e2, ...) stored in a data-qa-ref attribute so the
// agent can address them, plus locator candidates so recorded steps can be replayed later.

/* eslint-disable no-undef */
function inPageSnapshot({ maxElements, maxText }) {
  const clean = (s, n = 80) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // Same rule as Playwright: opacity is ignored, because custom-styled checkboxes/radios are
    // often transparent inputs drawn by their label and are still what the user clicks.
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['number'].includes(type)) return 'spinbutton';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const labelText = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    return '';
  };
  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const isField = ['input', 'textarea', 'select'].includes(tag);
    return clean(
      el.getAttribute('aria-label') ||
        labelText(el) ||
        (isField && el.type !== 'submit' && el.type !== 'button' ? '' : el.innerText) ||
        (tag === 'input' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '') ||
        el.getAttribute('title') ||
        el.querySelector?.('img[alt]')?.getAttribute('alt') ||
        (isField ? el.getAttribute('placeholder') : '') ||
        ''
    );
  };
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const cssPath = (el) => {
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id']) {
      const v = el.getAttribute(attr);
      if (v && unique(`[${attr}="${CSS.escape(v)}"]`)) return `[${attr}="${CSS.escape(v)}"]`;
    }
    if (el.id && !/\d{4,}|^[:_]|[:]/.test(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const nm = el.getAttribute('name');
    if (nm && unique(`${tag}[name="${CSS.escape(nm)}"]`)) return `${tag}[name="${CSS.escape(nm)}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/\d{4,}|[:]/.test(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  document.querySelectorAll('[data-qa-ref]').forEach((e) => e.removeAttribute('data-qa-ref'));
  const selector = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]', '[contenteditable=true]', '[onclick]',
  ].join(',');
  let all = [...document.querySelectorAll(selector)].filter(visible);
  // Prefer what the user can currently see, then the rest of the page.
  all = [...all.filter(inViewport), ...all.filter((e) => !inViewport(e))].slice(0, maxElements);
  all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const elements = all.map((el, i) => {
    const ref = `e${i + 1}`;
    el.setAttribute('data-qa-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    const name = nameOf(el);
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const item = { ref, role, name, tag };
    if (type && !['text', 'submit', 'button'].includes(type)) item.type = type;
    if (el.getAttribute('placeholder')) item.placeholder = clean(el.getAttribute('placeholder'), 40);
    if (['input', 'textarea'].includes(tag) && el.value && !['password', 'checkbox', 'radio'].includes(type)) item.value = clean(el.value, 40);
    if (type === 'password' && el.value) item.value = '••••';
    if (tag === 'select') item.options = [...el.options].slice(0, 8).map((o) => clean(o.text, 25));
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    if (tag === 'a' && el.getAttribute('href')) item.href = el.getAttribute('href').slice(0, 60);
    item.locator = {
      css: cssPath(el),
      role: role !== 'generic' ? role : undefined,
      name: name || undefined,
      label: labelText(el) || el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      text: !['input', 'textarea', 'select'].includes(tag) ? clean(el.innerText, 60) || undefined : undefined,
    };
    return item;
  });

  // Unnamed or identically named controls (e.g. one "Toggle Todo" checkbox per item) are only
  // identifiable by the text around them, so attach the nearest container text.
  const seen = {};
  for (const e of elements) seen[`${e.role}|${e.name}`] = (seen[`${e.role}|${e.name}`] || 0) + 1;
  elements.forEach((e, i) => {
    if (e.name && seen[`${e.role}|${e.name}`] < 2) return;
    let p = all[i].parentElement;
    for (let depth = 0; p && p !== document.body && depth < 4; depth++, p = p.parentElement) {
      const t = clean(p.innerText, 60);
      if (t && t !== e.name) {
        e.context = t;
        break;
      }
    }
  });

  const alertSel = '[role=alert],[role=status],[aria-live],.error,.alert,.flash,.notification,.toast,[class*="error"],[class*="message"],[class*="invalid"]';
  const alerts = [...new Set([...document.querySelectorAll(alertSel)].filter(visible).map((e) => clean(e.innerText, 160)).filter(Boolean))].slice(0, 5);
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => clean(h.innerText, 60)).filter(Boolean).slice(0, 6);
  return {
    url: location.href,
    title: document.title,
    headings,
    alerts,
    elements,
    text: clean(document.body?.innerText || '', maxText),
  };
}

export async function takeSnapshot(page, { maxElements = 40, maxText = 700 } = {}) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  } catch { /* keep going with whatever is there */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(inPageSnapshot, { maxElements, maxText });
    } catch (err) {
      // Navigation mid-evaluate destroys the context; wait and retry.
      if (attempt === 2) throw err;
      await page.waitForTimeout(700);
    }
  }
}

/** Render a snapshot as compact text for the LLM prompt. */
export function formatSnapshot(s) {
  const lines = [`URL: ${s.url}`, `Title: ${s.title}`];
  if (s.headings.length) lines.push(`Headings: ${s.headings.join(' | ')}`);
  if (s.alerts.length) lines.push(`Messages on page: ${s.alerts.map((a) => `"${a}"`).join(' | ')}`);
  lines.push('Interactive elements:');
  for (const e of s.elements) {
    let l = `[${e.ref}] ${e.role} "${e.name}"`;
    if (e.context) l += ` next to "${e.context}"`;
    if (e.type) l += ` type=${e.type}`;
    if (e.placeholder && e.placeholder !== e.name) l += ` placeholder="${e.placeholder}"`;
    if (e.value) l += ` value="${e.value}"`;
    if (e.options) l += ` options=[${e.options.join(', ')}]`;
    if (e.checked) l += ' checked';
    if (e.disabled) l += ' disabled';
    lines.push(l);
  }
  if (!s.elements.length) lines.push('(none)');
  lines.push(`Visible text: ${s.text}`);
  return lines.join('\n');
}
