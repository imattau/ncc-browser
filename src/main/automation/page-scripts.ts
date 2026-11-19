/** Scripts injected into the page's main world. Each is an expression returning JSON. */

/**
 * Shared by every script below: climb from an element, through any same-origin iframes
 * that contain it, to the top document's viewport, summing each ancestor frame's own
 * on-screen offset. getBoundingClientRect() is always relative to the immediate document,
 * so a nested element's raw rect is useless for clicking without this.
 */
const TOP_RECT_HELPER = `function __nccTopRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left; y += fr.top;
      win = win.frameElement.ownerDocument.defaultView;
    }
    return { left: x, top: y, width: r.width, height: r.height };
  }`

/** Number every interactive, visible element and return a compact description. */
export const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  ${TOP_RECT_HELPER}
  if (!window.__nccAuto) {
    Object.defineProperty(window, '__nccAuto', { value: { seq: 0, refs: new Map() }, enumerable: false });
  }
  const state = window.__nccAuto;
  state.refs.clear();
  state.seq = 0;
  const out = [];
  let total = 0;
  function sameOriginFrameDocs(doc) {
    const docs = [];
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (d) docs.push(d);
      } catch { /* cross-origin: skip silently */ }
    }
    return docs;
  }
  function collect(doc, depth) {
    if (depth > 6) return;
    for (const el of doc.querySelectorAll(SELECTOR)) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
      total++;
      if (out.length >= 250) continue;
      const ref = 'e' + (++state.seq);
      state.refs.set(ref, new WeakRef(el));
      const top = doc === document ? r : __nccTopRect(el);
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        type: el.type || undefined,
        name,
        value: el.matches('input,textarea,select') && el.type !== 'password' ? String(el.value).slice(0, 100) : undefined,
        href: el.href ? String(el.href).slice(0, 200) : undefined,
        inViewport: top.top + top.height > 0 && top.left + top.width > 0 && top.top < innerHeight && top.left < innerWidth
      });
    }
    for (const frameDoc of sameOriginFrameDocs(doc)) collect(frameDoc, depth + 1);
  }
  collect(document, 0);
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    elements: out,
    truncated: out.length < total,
    total
  };
})()`

/** Scroll a numbered element to the middle of the viewport and return its centre. */
export function resolveRefScript(ref: string): string {
  return `(() => {
    ${TOP_RECT_HELPER}
    const entry = window.__nccAuto && window.__nccAuto.refs.get(${JSON.stringify(ref)});
    const el = entry && entry.deref();
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = __nccTopRect(el);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`
}

/** Focus a numbered element, optionally selecting its text so typing replaces it. */
export function focusRefScript(ref: string, clear: boolean): string {
  return `(() => {
    const entry = window.__nccAuto && window.__nccAuto.refs.get(${JSON.stringify(ref)});
    const el = entry && entry.deref();
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      if (typeof el.select === 'function') el.select();
      else document.execCommand('selectAll');
    }
    return true;
  })()`
}

/** Set a <select> element's value by option value or visible text, and fire input/change. */
export function selectOptionScript(ref: string, value: string): string {
  return `(() => {
    const entry = window.__nccAuto && window.__nccAuto.refs.get(${JSON.stringify(ref)});
    const el = entry && entry.deref();
    if (!el || !el.isConnected) return { ok: false, reason: 'gone' };
    if (el.tagName !== 'SELECT') return { ok: false, reason: 'not-a-select' };
    const target = ${JSON.stringify(value)};
    let option = Array.from(el.options).find((o) => o.value === target);
    if (!option) option = Array.from(el.options).find((o) => o.textContent.trim() === target);
    if (!option) return { ok: false, reason: 'no-such-option' };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value, label: option.textContent.trim() };
  })()`
}

/** True once an element matching the selector exists in the top document. */
export function waitSelectorScript(selector: string): string {
  return `(() => { try { return document.querySelector(${JSON.stringify(selector)}) !== null; } catch { return false; } })()`
}

/** True once the page's visible text contains the given substring. */
export function waitTextScript(needle: string): string {
  return `(() => (document.body ? document.body.innerText : '').includes(${JSON.stringify(needle)}))()`
}

export const PAGE_TEXT_SCRIPT = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body ? document.body.innerText : '').slice(0, 60000)
}))()`
