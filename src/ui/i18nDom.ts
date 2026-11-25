import { getLang, tr } from '../core/i18n';

/**
 * Translates the page in place and keeps translating whatever the app renders later
 * (tables, toasts, log lines). Originals are remembered so switching back to English
 * restores them exactly.
 */
const ATTRS = ['title', 'placeholder', 'aria-label'];
const SKIP = 'script, style, textarea, code, .bot-log, .ts';
const texts = new WeakMap<Text, { en: string; shown: string }>();
const attrs = new WeakMap<Element, Record<string, { en: string; shown: string }>>();
const seenText = new Set<WeakRef<Text>>();
const seenAttr = new Set<WeakRef<Element>>();

function translateText(node: Text): void {
  const data = node.data;
  const rec = texts.get(node);
  if (rec && rec.shown === data) return;
  const trimmed = data.trim();
  if (!trimmed || !/[A-Za-z]{2}/.test(trimmed)) return;
  if (node.parentElement?.closest(SKIP)) return;
  const out = tr(trimmed);
  if (out === trimmed) return;
  const shown = data.replace(trimmed, out);
  texts.set(node, { en: data, shown });
  seenText.add(new WeakRef(node));
  node.data = shown;
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const map = attrs.get(el) ?? {};
    if (map[a]?.shown === v) continue;
    const out = tr(v);
    if (out === v) continue;
    map[a] = { en: v, shown: out };
    attrs.set(el, map);
    seenAttr.add(new WeakRef(el));
    el.setAttribute(a, out);
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root as Element);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
  }
}

/** Starts translating `root` and everything added to it later. */
export function startTranslation(root: HTMLElement = document.body): void {
  if (getLang() === 'nl') walk(root);
  new MutationObserver((records) => {
    if (getLang() !== 'nl') return;
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target as Text);
      else if (r.type === 'attributes') translateAttrs(r.target as Element);
      else r.addedNodes.forEach(walk);
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Re-applies the current language to the whole page. */
export function applyLang(root: HTMLElement = document.body): void {
  document.documentElement.lang = getLang();
  if (getLang() === 'nl') {
    walk(root);
    return;
  }
  for (const ref of seenText) {
    const n = ref.deref();
    const rec = n && texts.get(n);
    if (n && rec && n.data === rec.shown) n.data = rec.en;
    if (!n) seenText.delete(ref);
  }
  for (const ref of seenAttr) {
    const el = ref.deref();
    const map = el && attrs.get(el);
    if (el && map) for (const [a, rec] of Object.entries(map)) if (el.getAttribute(a) === rec.shown) el.setAttribute(a, rec.en);
    if (!el) seenAttr.delete(ref);
  }
}
