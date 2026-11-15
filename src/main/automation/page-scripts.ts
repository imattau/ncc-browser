/** Scripts injected into the page's main world. Each is an expression returning JSON. */

/** Number every interactive, visible element and return a compact description. */
export const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a[href],button,input,select,textarea,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  if (!window.__nccAuto) {
    Object.defineProperty(window, '__nccAuto', { value: { seq: 0, refs: new Map() }, enumerable: false });
  }
  const state = window.__nccAuto;
  state.refs.clear();
  state.seq = 0;
  const out = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++state.seq);
    state.refs.set(ref, new WeakRef(el));
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      type: el.type || undefined,
      name,
      value: el.matches('input,textarea,select') && el.type !== 'password' ? String(el.value).slice(0, 100) : undefined,
      href: el.href ? String(el.href).slice(0, 200) : undefined,
      inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
    });
    if (out.length >= 250) break;
  }
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, elements: out };
})()`

/** Scroll a numbered element to the middle of the viewport and return its centre. */
export function resolveRefScript(ref: string): string {
  return `(() => {
    const entry = window.__nccAuto && window.__nccAuto.refs.get(${JSON.stringify(ref)});
    const el = entry && entry.deref();
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
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

export const PAGE_TEXT_SCRIPT = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body ? document.body.innerText : '').slice(0, 60000)
}))()`
