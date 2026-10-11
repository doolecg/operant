// Pure part of the AI-action overlay: what to highlight, and the script that draws it inside the page.
// main/browser-overlay.ts runs these scripts in an Electron isolated world.
//
// Playwright's aria refs (e12) cannot be resolved from outside: @playwright/mcp keeps them in a private map of its
// injected script (InjectedScript._lastAriaSnapshotForQuery) in its own utility world, and writes no attribute on the
// element. So a ref is resolved by what the snapshot said about it, role and accessible name (parseSnapshotRefs), and
// matched in the page by the script below. A CSS selector and an explicit box are also accepted.

export interface RefHint {
  role: string
  name: string
}

export type OverlayTarget =
  | { kind: 'selector'; selector: string }
  | { kind: 'ref'; ref: string; role?: string; name?: string }
  | { kind: 'box'; x: number; y: number; w: number; h: number }

export interface OverlayRect {
  x: number
  y: number
  w: number
  h: number
}

// 'e12', or 'f1e12' for a frame's element.
export const isAriaRef = (s: string): boolean => /^(?:f\d+)?e\d+$/.test(s)

// Refs of a Playwright aria snapshot: `- button "Save" [ref=e12] [cursor=pointer]:` gives e12 -> button "Save".
export function parseSnapshotRefs(snapshot: string): Map<string, RefHint> {
  const out = new Map<string, RefHint>()
  const re = /^[ \t]*-[ \t]+([a-z][a-z-]*)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[^\n]*?\[ref=((?:f\d+)?e\d+)\]/gm
  for (let m = re.exec(snapshot); m; m = re.exec(snapshot)) {
    const [, role, name, ref] = m
    if (role && ref) out.set(ref, { role, name: (name ?? '').replace(/\\(.)/g, '$1') })
  }
  return out
}

// The tool call's target string (a ref or a selector) as something the page script can find. null = nothing to show.
export function toTarget(raw: string | undefined, hints?: ReadonlyMap<string, RefHint>): OverlayTarget | null {
  const s = raw?.trim()
  if (!s || s.length > 500) return null
  if (isAriaRef(s)) {
    const h = hints?.get(s)
    return { kind: 'ref', ref: s, role: h?.role, name: h?.name }
  }
  return { kind: 'selector', selector: s }
}

const clampMs = (ms: number): number => Math.max(300, Math.min(10_000, Math.round(Number.isFinite(ms) ? ms : 1500)))
const num = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0)

// Shared by both scripts: one host element per kind, a closed shadow root so page CSS cannot reach it, fixed and
// pointer-events none so layout and clicks are untouched. State lives on the isolated world's own global.
const HOST = `
var G = globalThis, S = G.__operantOverlay || (G.__operantOverlay = {});
function mount(kind) {
  var old = S[kind];
  if (old) { clearTimeout(old.timer); try { old.host.remove(); } catch (e) {} S[kind] = null; }
  var host = document.createElement('div');
  host.setAttribute('style', 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;');
  var root = host.attachShadow({ mode: 'closed' });
  (document.documentElement || document.body).appendChild(host);
  return { host: host, root: root, timer: 0 };
}
function expire(kind, rec, ms) {
  S[kind] = rec;
  rec.timer = setTimeout(function () { try { rec.host.remove(); } catch (e) {} if (S[kind] === rec) S[kind] = null; }, ms);
}
`

const ROLES = `
var ROLE_SEL = {
  button: 'button,[role=button],input[type=button],input[type=submit],input[type=reset],summary',
  link: 'a[href],[role=link]',
  textbox: 'input:not([type]),input[type=text],input[type=email],input[type=url],input[type=tel],input[type=password],input[type=number],textarea,[role=textbox],[contenteditable=""],[contenteditable=true]',
  searchbox: 'input[type=search],[role=searchbox]',
  checkbox: 'input[type=checkbox],[role=checkbox]',
  radio: 'input[type=radio],[role=radio]',
  combobox: 'select,[role=combobox],input[list]',
  listbox: 'select,[role=listbox]',
  option: 'option,[role=option]',
  slider: 'input[type=range],[role=slider]',
  switch: '[role=switch]',
  tab: '[role=tab]',
  menuitem: '[role^=menuitem]',
  img: 'img,[role=img]',
  heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
  listitem: 'li,[role=listitem]',
  row: 'tr,[role=row]',
  cell: 'td,[role=cell],[role=gridcell]'
};
function norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
function nameOf(el) {
  var v = el.getAttribute('aria-label');
  if (v) return v;
  var by = el.getAttribute('aria-labelledby');
  if (by) {
    var t = by.split(/\\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    if (norm(t)) return t;
  }
  if (el.labels && el.labels.length) return Array.prototype.map.call(el.labels, function (l) { return l.textContent; }).join(' ');
  return el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') ||
    ((el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) ? el.value : '') || el.textContent || '';
}
function seen(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
function byRole(role, name) {
  var sel = ROLE_SEL[role] || ('[role="' + String(role).replace(/"/g, '') + '"]');
  var all = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(seen);
  var want = norm(name);
  if (!want) return all.length === 1 ? all[0] : null;
  var exact = all.filter(function (e) { return norm(nameOf(e)) === want; });
  if (exact.length) return exact[0];
  var part = all.filter(function (e) { var n = norm(nameOf(e)); return n && (n.indexOf(want) === 0 || want.indexOf(n) === 0 || n.indexOf(want) >= 0); });
  return part[0] || null;
}
`

const RESOLVE = `
function rectOf(t) {
  if (t.kind === 'box') return { x: t.x, y: t.y, w: t.w, h: t.h };
  var el = null;
  try {
    if (t.kind === 'selector') el = document.querySelector(t.selector);
    else if (t.kind === 'ref' && t.role) el = byRole(t.role, t.name);
  } catch (e) { el = null; }
  if (!el) return null;
  var r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
`

// Draws a box with a label around the target for ms, and returns JSON {found, x, y, w, h} (viewport CSS px).
export function buildHighlightScript(target: OverlayTarget, label: string, ms: number): string {
  const spec = JSON.stringify({ t: target, label: label.slice(0, 80), ms: clampMs(ms) })
  return `(function (spec) {${HOST}${ROLES}${RESOLVE}
  var r = rectOf(spec.t);
  if (!r) return JSON.stringify({ found: false });
  var rec = mount('box');
  var box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;box-sizing:border-box;pointer-events:none;border:2px solid #7c6cff;border-radius:4px;background:rgba(124,108,255,0.14);box-shadow:0 0 0 1px rgba(255,255,255,0.7),0 2px 10px rgba(0,0,0,0.25);left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px;');
  rec.root.appendChild(box);
  if (spec.label) {
    var tag = document.createElement('div');
    tag.textContent = spec.label;
    var above = r.y > 24;
    tag.setAttribute('style', 'position:fixed;pointer-events:none;max-width:320px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:2px 6px;border-radius:4px;background:#5b4bdb;color:#fff;font:600 11px/16px system-ui,sans-serif;left:' + Math.max(0, r.x) + 'px;top:' + (above ? r.y - 22 : r.y + r.h + 4) + 'px;');
    rec.root.appendChild(tag);
  }
  try { box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 }); } catch (e) {}
  expire('box', rec, spec.ms);
  return JSON.stringify({ found: true, x: r.x, y: r.y, w: r.w, h: r.h });
})(${spec})`
}

// Moves an animated cursor dot to (x, y) viewport CSS px, from where it last was on this page, with a click pulse.
export function buildCursorScript(x: number, y: number, ms: number): string {
  const spec = JSON.stringify({ x: num(x), y: num(y), ms: clampMs(ms) })
  return `(function (spec) {${HOST}
  var prev = S.cursorAt;
  var rec = mount('cursor');
  var dot = document.createElement('div');
  var from = prev || { x: spec.x, y: spec.y };
  dot.setAttribute('style', 'position:fixed;left:-9px;top:-9px;width:18px;height:18px;box-sizing:border-box;pointer-events:none;border-radius:50%;background:rgba(124,108,255,0.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,0.4);transform:translate(' + from.x + 'px,' + from.y + 'px);');
  rec.root.appendChild(dot);
  S.cursorAt = { x: spec.x, y: spec.y };
  try {
    dot.animate([{ transform: 'translate(' + from.x + 'px,' + from.y + 'px)' }, { transform: 'translate(' + spec.x + 'px,' + spec.y + 'px)' }], { duration: prev ? 350 : 1, easing: 'ease-in-out', fill: 'forwards' });
    var ring = document.createElement('div');
    ring.setAttribute('style', 'position:fixed;left:-18px;top:-18px;width:36px;height:36px;box-sizing:border-box;pointer-events:none;border-radius:50%;border:2px solid #7c6cff;opacity:0;transform:translate(' + spec.x + 'px,' + spec.y + 'px);');
    rec.root.appendChild(ring);
    ring.animate([{ opacity: 0.9, transform: 'translate(' + spec.x + 'px,' + spec.y + 'px) scale(0.4)' }, { opacity: 0, transform: 'translate(' + spec.x + 'px,' + spec.y + 'px) scale(1.4)' }], { duration: 450, delay: prev ? 330 : 0, easing: 'ease-out' });
  } catch (e) {}
  expire('cursor', rec, spec.ms);
  return JSON.stringify({ ok: true });
})(${spec})`
}
