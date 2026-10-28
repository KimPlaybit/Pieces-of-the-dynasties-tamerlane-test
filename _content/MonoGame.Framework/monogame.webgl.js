// MonoGame browser platform — the JavaScript half.
//
// This is what SDL2 + the OpenGL driver are on desktop: it owns the <canvas>, its WebGL2 context, the
// requestAnimationFrame loop and the DOM input events, and it executes the GL calls MonoGame's (stock,
// unmodified) OpenGL ES backend makes. The C# half is Platform/Graphics/WebGL2.cs; every export here is
// bound there with [JSImport], one function per GL entry point.
//
// GL object names: GL hands out integer names, WebGL hands out objects. Each kind of object lives in its
// own table and C# only ever sees the index, with 0 reserved for "none" exactly as in GL.
//
// Pointers: a C# IntPtr in WebAssembly is an offset into the runtime's linear memory, so a buffer/texture
// upload reads straight out of that memory through a typed view — no copy on the .NET side. Views are
// re-created per call because the memory's ArrayBuffer is replaced whenever the heap grows.

let gl = null;
let canvas = null;
let runtime = null;

function heap() { return runtime.localHeapViewU8(); }
function heapBytes(ptr, size) { return new Uint8Array(heap().buffer, ptr, size); }
function heapFloats(ptr, count) { return new Float32Array(heap().buffer, ptr, count); }
function heapInts(ptr, count) { return new Int32Array(heap().buffer, ptr, count); }

class Table {
    constructor() { this.items = [null]; this.free = []; }
    add(obj) {
        if (!obj) return 0;
        const id = this.free.length ? this.free.pop() : this.items.length;
        this.items[id] = obj;
        return id;
    }
    get(id) { return id > 0 ? this.items[id] : null; }
    remove(id) { if (id > 0 && this.items[id]) { this.items[id] = null; this.free.push(id); } }
}

const buffers = new Table();
const textures = new Table();
const framebuffers = new Table();
const renderbuffers = new Table();
const programs = new Table();
const shaders = new Table();
const uniforms = new Table();

// ---------------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------------

export function init(canvasId) {
    runtime = globalThis.getDotnetRuntime(0);
    canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error(`MonoGame: no <canvas id="${canvasId}">`);

    // preserveDrawingBuffer: the canvas always holds the last frame the game finished drawing. Without
    // it the browser may clear it after showing a frame, and a frame in which the game touches WebGL
    // without drawing (a texture upload while content loads — a frame whose draw MonoGame skipped)
    // then puts that cleared canvas on screen: Firefox does, as a black flash, the first time a game
    // starts and the first time a commander is selected (Chrome keeps the old picture).
    gl = canvas.getContext('webgl2', {
        alpha: false, depth: true, stencil: true, antialias: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('MonoGame: this browser has no WebGL2');

    // Extensions WebGL only switches on when asked.
    for (const name of ['EXT_texture_filter_anisotropic', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float',
                        'OES_texture_float_linear', 'WEBGL_compressed_texture_s3tc', 'EXT_texture_norm16'])
        gl.getExtension(name);

    hookInput();
    if (new URLSearchParams(location.search).has('perf')) enablePerf();
    raw = gl;
    gl = flushingGate(raw);
    return true;
}

// Every WebGL call outside the sprite queue goes through this gate, which first sends any queued sprite
// draws (see queueSpriteDraw), so the context always sees calls in the order MonoGame made them.
let raw = null;
function flushingGate(inner) {
    const fns = new Map();
    return new Proxy(inner, {
        get(t, p) {
            const cached = fns.get(p);
            if (cached) return cached;
            const v = t[p];
            if (typeof v !== 'function') { if (spriteQueue.length) flushSpriteQueue(); return v; }
            const fn = (...a) => { if (spriteQueue.length) flushSpriteQueue(); return v.apply(t, a); };
            fns.set(p, fn);
            return fn;
        }
    });
}

// ?perf: every 2 s, log frames, time inside the .NET tick, and WebGL calls per frame (by name).
const perf = { on: false, frames: 0, ticks: 0, tickMs: 0, maxMs: 0, calls: 0, glMs: 0, byName: {} };
function enablePerf() {
    perf.on = true;
    const real = gl;
    gl = new Proxy(real, {
        get(t, p) {
            const v = t[p];
            if (typeof v !== 'function') return v;
            return (...a) => { perf.calls++; perf.byName[p] = (perf.byName[p] || 0) + 1; const s0 = performance.now(); try { return v.apply(t, a); } finally { perf.glMs += performance.now() - s0; } };
        }
    });
    setInterval(() => {
        const f = Math.max(1, perf.frames), t = Math.max(1, perf.ticks);
        const top = Object.entries(perf.byName).sort((a, b) => b[1] - a[1]).slice(0, 8)
            .map(([n, c]) => `${n}=${Math.round(c / t)}`).join(' ');
        console.log(`[perf] fps=${(perf.frames / 2).toFixed(1)} ticks=${perf.ticks} tick=${(perf.tickMs / t).toFixed(1)}ms max=${perf.maxMs.toFixed(0)}ms inGL=${(perf.glMs / t).toFixed(1)}ms gl/tick=${Math.round(perf.calls / t)} | ${top}`);
        Object.assign(perf, { frames: 0, ticks: 0, tickMs: 0, maxMs: 0, calls: 0, glMs: 0, byName: {} });
    }, 2000);
}

let frameCallback = null;
export function startLoop(callback) {
    frameCallback = callback;
    const step = () => {
        const t0 = perf.on ? performance.now() : 0;
        const before = perf.calls;
        try { frameCallback(); flushSpriteQueue(); }
        finally {
            if (perf.on) {
                perf.frames++;
                const dt = performance.now() - t0;
                if (perf.calls !== before || dt > 1) { perf.ticks++; perf.tickMs += dt; perf.maxMs = Math.max(perf.maxMs, dt); }
            }
            requestAnimationFrame(step);
        }
    };
    requestAnimationFrame(step);
}

export function setCanvasSize(width, height) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    // The page's CSS sizes the canvas from this (see the host's #canvas rule).
    canvas.style.setProperty('--ar', String(width / height));
}
export function getCanvasClientWidth() { return Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)); }
export function getCanvasClientHeight() { return Math.round(canvas.clientHeight * (window.devicePixelRatio || 1)); }
export function getViewportWidth() { return Math.max(320, Math.floor(window.innerWidth)); }
export function getViewportHeight() { return Math.max(240, Math.floor(window.innerHeight)); }
export function setTitle(title) { document.title = title; }
export function setCursorVisible(visible) { canvas.style.cursor = visible ? 'default' : 'none'; }
// "Active" = the tab is on screen. Not document.hasFocus(): an embedded game (an itch.io iframe) has no
// focus until clicked, and a game that ignores input while inactive would then swallow that first click.
export function hasFocus() { return document.visibilityState === 'visible'; }
export function requestFullscreen() { canvas.requestFullscreen?.().catch(() => { }); }
export function exitFullscreen() { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); }
export function isFullscreen() { return !!document.fullscreenElement; }

// ---------------------------------------------------------------------------------------------------
// Title storage. MonoGame's ContentManager is synchronous, so a file it asks for mid-game is fetched
// with a synchronous XHR (which cannot return an ArrayBuffer on the main thread, hence the
// "x-user-defined" string trick: one char per byte, high byte garbage). Before the game starts, the
// page PRELOADS the files the game reads during startup asynchronously and in parallel — that is what
// the loading bar shows — so the start itself never touches the network.
// ---------------------------------------------------------------------------------------------------

// url -> { bytes, reads }: kept until it has been read `reads` times (the preload lists record how often
// the game reads each file — some are read by more than one loader), then dropped.
const preloaded = new Map();
// Files the game probes for but that don't exist (optional art variants). Listed by the preload lists so
// the answer is immediate: a synchronous request mid-frame is what the preload exists to avoid — Firefox
// can even repaint the half-drawn canvas while one is in flight (a black flash).
const missingFiles = new Set();
let pendingBytes = null;         // Uint8Array or x-user-defined string, collected by copyFile

const fetchStats = { count: 0, bytes: 0, ms: 0, urls: [], missing: [] };
globalThis.monogameFetchStats = fetchStats;

/**
 * Downloads `urls` into memory, `parallel` at a time, calling onProgress(loadedBytes, totalBytes,
 * filesDone, filesTotal). Sizes are taken from Content-Length as each response starts, so the byte
 * total firms up while the first wave is in flight. A file that fails is skipped — the game then
 * fetches it synchronously like any other, so a missing preload is slower, never broken.
 */
export async function preload(urls, onProgress, parallel = 6, knownSizes = null, readCounts = null) {
    let next = 0, done = 0, loaded = 0;
    const sizes = new Map(knownSizes ? urls.map(u => [u, knownSizes.get(u) || 0]) : []);
    const total = () => { let t = 0; for (const v of sizes.values()) t += v; return t; };
    const report = () => onProgress?.(loaded, Math.max(total(), loaded), done, urls.length);

    async function worker() {
        while (next < urls.length) {
            const url = urls[next++];
            try {
                const res = await fetch(url);
                if (!res.ok) continue;
                const len = Number(res.headers.get('Content-Length')) || 0;
                if (len) sizes.set(url, len);
                const reader = res.body.getReader();
                const chunks = []; let got = 0;
                for (;;) {
                    const { done: end, value } = await reader.read();
                    if (end) break;
                    chunks.push(value); got += value.length; loaded += value.length;
                    if (!len) sizes.set(url, got);
                    report();
                }
                const bytes = new Uint8Array(got);
                let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
                preloaded.set(url, { bytes, reads: readCounts?.get(url) || 1 });
            } catch { /* fetched synchronously later instead */ }
            finally { done++; report(); }
        }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, urls.length) }, worker));
}

/**
 * Preloads every file listed in the JSON array at `listUrl` (see preload) — entries are URLs, or
 * { url, size } so the byte total is known before the first response arrives. In the foreground the page
 * hears about it through a `monogame-preload` event on window — detail { loaded, total, done, count } —
 * which is all a loading bar needs; in the background it is silent. A missing list preloads nothing.
 */
export async function preloadList(listUrl, background) {
    const state = { loaded: 0, total: 0, finished: false };
    listProgress.set(listUrl, state);
    try {
        let entries = [];
        try { const res = await fetch(listUrl); if (res.ok) entries = await res.json(); } catch { }
        for (const e of entries) if (e && e.missing) missingFiles.add(e.url);
        entries = entries.filter(e => !(e && e.missing));
        const sizes = new Map(entries.map(e => typeof e === 'string' ? [e, 0] : [e.url, e.size || 0]));
        const reads = new Map(entries.filter(e => e && e.reads > 1).map(e => [e.url, e.reads]));
        const urls = [...sizes.keys()].filter(u => !preloaded.has(u));
        for (const u of urls) state.total += sizes.get(u);
        const onProgress = (loaded, total, done, count) => {
            state.loaded = loaded; state.total = total;
            if (!background)
                window.dispatchEvent(new CustomEvent('monogame-preload', { detail: { loaded, total, done, count } }));
        };
        await preload(urls, onProgress, background ? 4 : 6, sizes, reads);
    } finally {
        state.finished = true;
    }
}

// How far the list at `listUrl` has come, 0..1 — 1 once every file has arrived (or failed: those are
// fetched synchronously when read), 0 for a list that hasn't been started.
const listProgress = new Map();   // listUrl -> { loaded, total, finished }
export function preloadFraction(listUrl) {
    const s = listProgress.get(listUrl);
    if (!s) return 0;
    if (s.finished) return 1;
    return s.total > 0 ? Math.min(0.999, s.loaded / s.total) : 0;
}

// Returns the byte length, or -1 if the file isn't there. The bytes wait in pendingBytes until
// copyFile collects them into memory C# allocated for exactly that length.
export function fetchFile(url) {
    const t0 = performance.now();
    try {
        if (missingFiles.has(url)) return -1;
        const hit = preloaded.get(url);
        if (hit) {
            if (--hit.reads <= 0) preloaded.delete(url);
            pendingBytes = hit.bytes;
            return hit.bytes.length;
        }
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        try { xhr.send(null); } catch { return -1; }
        if (xhr.status !== 200 && xhr.status !== 0) { fetchStats.missing.push(url); return -1; }
        pendingBytes = xhr.responseText;
        fetchStats.bytes += pendingBytes.length;
        fetchStats.urls.push(url);
        return pendingBytes.length;
    } finally {
        fetchStats.count++;
        fetchStats.ms += performance.now() - t0;
    }
}

export function copyFile(ptr, length) {
    const view = heapBytes(ptr, length);
    const src = pendingBytes;
    if (src instanceof Uint8Array) view.set(src.subarray(0, length));
    else for (let i = 0; i < length; i++) view[i] = src.charCodeAt(i) & 0xff;
    pendingBytes = null;
}

// ---------------------------------------------------------------------------------------------------
// Input. DOM events land in plain state here; the platform polls it once per frame (BeforeUpdate),
// which is the same snapshot-per-frame model SDL's event pump gives MonoGame on desktop.
// ---------------------------------------------------------------------------------------------------

const mouse = { x: 0, y: 0, buttons: 0, wheel: 0, hwheel: 0 };
const keysDown = new Set();
// Presses latched until the next poll: a click (or key tap) shorter than one frame would otherwise go
// down and up between two snapshots and never be seen. Held for one poll, released on the next.
let latchedButtons = 0;
const latchedKeys = new Set();
// A finger (or pen) is a left button. It cannot hover, so a tap is played to the game over polls the way
// a mouse would do it: one poll with the pointer arriving unpressed (buttons that act only on a hovered
// press see the hover first), then pressed for as long as it is held — at least one poll — then released.
// Not the browser's emulated mouse events: iOS Safari (and some Android browsers) send those with
// buttons = 0, so a tap never registered as a press at all.
const touch = { state: 'none', held: false, at: -1e9 }; // state: none | arriving | pressed; at = last finger event
// The mouse events a browser emulates for a tap, which arrive right after it. Chrome drops them once the
// pointerdown is cancelled; iOS Safari sends them anyway (mousedown/mouseup with buttons = 0), and since
// mousedown latches from e.button that made every tap two clicks — a map tile previewed AND marched to,
// a portrait double-clicked. A real mouse is never used within a second of a finger, so mouse events in
// that window are the tap's echo and ignored.
const TOUCH_ECHO_MS = 1000;
const isTouchEcho = () => touch.held || performance.now() - touch.at < TOUCH_ECHO_MS;
const inputStats = window.monogameInputStats = { leftPresses: 0, lastButtons: 0 };
let textQueue = [];

// KeyboardEvent.code -> Microsoft.Xna.Framework.Input.Keys
const KEYS = {
    Backspace: 8, Tab: 9, Enter: 13, Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    PrintScreen: 44, Insert: 45, Delete: 46,
    MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
    Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100, Numpad5: 101, Numpad6: 102,
    Numpad7: 103, Numpad8: 104, Numpad9: 105, NumpadMultiply: 106, NumpadAdd: 107, NumpadComma: 108,
    NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13,
    NumLock: 144, ScrollLock: 145,
    ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165,
    Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
    BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
};
for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i < 10; i++) KEYS['Digit' + i] = 48 + i;
for (let i = 1; i <= 24; i++) KEYS['F' + i] = 111 + i;

// Keys the browser keeps: reload, devtools, browser fullscreen.
const BROWSER_KEYS = new Set(['F5', 'F11', 'F12']);

// MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) as MouseEvent.buttons bits.
const BUTTON_BITS = [1, 4, 2, 8, 16];

function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    mouse.x = Math.floor((e.clientX - r.left) * canvas.width / Math.max(1, r.width));
    mouse.y = Math.floor((e.clientY - r.top) * canvas.height / Math.max(1, r.height));
}

function hookInput() {
    canvas.tabIndex = 0;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    // The press is latched from e.button (which button went down), not only e.buttons (which are held):
    // iOS Safari sends its emulated mousedown with buttons = 0, so a press read from e.buttons alone
    // never existed — the pointer moved and nothing ever clicked.
    canvas.addEventListener('mousedown', e => { if (isTouchEcho()) { e.preventDefault(); return; } canvas.focus(); toCanvas(e); mouse.buttons = e.buttons; latchedButtons |= e.buttons | (BUTTON_BITS[e.button] ?? 0); e.preventDefault(); });
    window.addEventListener('mouseup', e => { if (isTouchEcho()) return; toCanvas(e); mouse.buttons = e.buttons; });
    window.addEventListener('mousemove', e => { if (isTouchEcho()) return; toCanvas(e); mouse.buttons = e.buttons; });
    // Touch and pen (see `touch`). preventDefault on pointerdown also stops the browser's emulated mouse
    // events for the tap, so a tap never counts twice; the canvas's CSS touch-action: none keeps the page
    // from scrolling or zooming under the finger.
    canvas.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        canvas.focus(); toCanvas(e); e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch { }
        touch.state = 'arriving'; touch.held = true; touch.at = performance.now();
    });
    canvas.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') toCanvas(e); });
    const touchUp = e => { if (e.pointerType === 'mouse') return; toCanvas(e); touch.held = false; touch.at = performance.now(); };
    canvas.addEventListener('pointerup', touchUp);
    canvas.addEventListener('pointercancel', touchUp);
    canvas.addEventListener('wheel', e => {
        // XNA: +120 per notch, positive = away from the user. DOM: positive deltaY = towards the user.
        const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        mouse.wheel -= Math.sign(e.deltaY) * 120 * Math.max(1, Math.round(Math.abs(e.deltaY * scale) / 100));
        mouse.hwheel += Math.sign(e.deltaX) * 120;
        e.preventDefault();
    }, { passive: false });

    window.addEventListener('keydown', e => {
        const k = KEYS[e.code];
        if (k !== undefined) { keysDown.add(k); latchedKeys.add(k); }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) textQueue.push(e.key.codePointAt(0), k ?? 0);
        else if (e.code === 'Backspace') textQueue.push(8, 8);
        else if (e.code === 'Enter' || e.code === 'NumpadEnter') textQueue.push(13, 13);
        else if (e.code === 'Tab') textQueue.push(9, 9);
        if (!BROWSER_KEYS.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => {
        const k = KEYS[e.code];
        if (k !== undefined) keysDown.delete(k);
        if (!BROWSER_KEYS.has(e.code)) e.preventDefault();
    });
    // A key released while the tab was away would otherwise stay down forever.
    window.addEventListener('blur', () => { keysDown.clear(); latchedKeys.clear(); mouse.buttons = 0; latchedButtons = 0; touch.state = 'none'; touch.held = false; });
}

// [x, y, buttons, wheel, hwheel]
export function pollMouse() {
    let touchButton = 0;
    if (touch.state === 'arriving') touch.state = 'pressed';
    else if (touch.state === 'pressed') { touchButton = 1; if (!touch.held) touch.state = 'none'; }
    const buttons = mouse.buttons | latchedButtons | touchButton;
    latchedButtons = 0;
    // Left-button presses exactly as the game sees them (released -> pressed between two polls): one
    // per click or tap, which is what this counts so a test can check it.
    if ((buttons & 1) && !(inputStats.lastButtons & 1)) inputStats.leftPresses++;
    inputStats.lastButtons = buttons;
    return [mouse.x, mouse.y, buttons, mouse.wheel, mouse.hwheel];
}
export function pollKeys() {
    const keys = new Set(keysDown);
    for (const k of latchedKeys) keys.add(k);
    latchedKeys.clear();
    return Array.from(keys);
}
// Pairs of [character, key] typed since the last poll.
export function pollText() { const q = textQueue; textQueue = []; return q; }

// ---------------------------------------------------------------------------------------------------
// GL. One export per entry point MonoGame's OpenGL.cs loads (see WebGL2.cs for the C# side).
// ---------------------------------------------------------------------------------------------------

// Caps WebGL knows. MonoGame also toggles desktop-only ones (GL_MULTISAMPLE, GL_FRAMEBUFFER_SRGB,
// GL_DEPTH_CLAMP, debug output); in WebGL those raise INVALID_ENUM, which MonoGame's debug build turns
// into an exception, so they are dropped here — they have no WebGL meaning to honour anyway.
const CAPS = new Set([0x0BE2 /*BLEND*/, 0x0B44 /*CULL_FACE*/, 0x0B71 /*DEPTH_TEST*/, 0x0BD0 /*DITHER*/,
    0x8037 /*POLYGON_OFFSET_FILL*/, 0x809E /*SAMPLE_ALPHA_TO_COVERAGE*/, 0x80A0 /*SAMPLE_COVERAGE*/,
    0x0C11 /*SCISSOR_TEST*/, 0x0B90 /*STENCIL_TEST*/, 0x8C89 /*RASTERIZER_DISCARD*/]);

export function enable(cap) { if (CAPS.has(cap)) gl.enable(cap); }
export function disable(cap) { if (CAPS.has(cap)) gl.disable(cap); }
export function getError() { return gl.getError(); }
// Deliberately nothing. The browser submits a frame's GL work itself when the frame ends, so these buy
// nothing in WebGL — and MonoGame calls glFinish after every texture upload, a needless sync point.
export function flush() { }
export function finish() { }

export function getParameterInt(pname) {
    const v = gl.getParameter(pname);
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v | 0;
    if (v.length !== undefined) return v[0] | 0;
    // An object binding (e.g. FRAMEBUFFER_BINDING): report its table name.
    return findName(v);
}
function findName(obj) {
    for (const t of [framebuffers, textures, buffers, renderbuffers, programs]) {
        const i = t.items.indexOf(obj);
        if (i > 0) return i;
    }
    return 0;
}
export function getExtensions() { return (gl.getSupportedExtensions() || []).join(' '); }
export function getRenderer() { return gl.getParameter(gl.RENDERER) || 'WebGL'; }
export function getVendor() { return gl.getParameter(gl.VENDOR) || 'Browser'; }

export function viewport(x, y, w, h) { gl.viewport(x, y, w, h); }
export function scissor(x, y, w, h) { gl.scissor(x, y, w, h); }
export function clear(mask) { gl.clear(mask); }
export function clearColor(r, g, b, a) { gl.clearColor(r, g, b, a); }
export function clearDepth(d) { gl.clearDepth(d); }
export function clearStencil(s) { gl.clearStencil(s); }
export function depthRange(n, f) { gl.depthRange(n, f); }
export function cullFace(mode) { gl.cullFace(mode); }
export function frontFace(mode) { gl.frontFace(mode); }
export function polygonOffset(factor, units) { gl.polygonOffset(factor, units); }
export function colorMask(r, g, b, a) { gl.colorMask(r, g, b, a); }
export function depthFunc(f) { gl.depthFunc(f); }
export function depthMask(m) { gl.depthMask(m); }
export function blendColor(r, g, b, a) { gl.blendColor(r, g, b, a); }
export function blendEquationSeparate(c, a) { gl.blendEquationSeparate(c, a); }
export function blendFuncSeparate(cs, cd, as, ad) { gl.blendFuncSeparate(cs, cd, as, ad); }
export function stencilFunc(f, r, m) { gl.stencilFunc(f, r, m); }
export function stencilFuncSeparate(face, f, r, m) { gl.stencilFuncSeparate(face, f, r, m); }
export function stencilOp(f, zf, zp) { gl.stencilOp(f, zf, zp); }
export function stencilOpSeparate(face, f, zf, zp) { gl.stencilOpSeparate(face, f, zf, zp); }
export function stencilMask(m) { gl.stencilMask(m); }

// Buffers
//
// Client-side vertex arrays. MonoGame's DrawUser[Indexed]Primitives — which SpriteBatch uses for every
// batch — unbinds the VBO and points glVertexAttribPointer straight at a pinned managed array, as desktop
// GL and GLES allow. WebGL forbids client arrays, so they are emulated here the way Emscripten's GLES2
// emulation does: the attribute pointers are remembered, and at draw time the vertices actually referenced
// are streamed from wasm memory into a scratch buffer and the attributes re-pointed into it.
//
// Every call into WebGL costs a trip through the browser, and a draw used to make about a dozen of them
// (bind scratch buffer, upload vertices, point three attributes, bind and upload indices, draw, then put
// both bindings back). So the bridge keeps its own copy of the state that matters and only calls WebGL
// when something actually changes:
//   * buffer bindings are lazy — MonoGame's bindBuffer just records what it wants bound, and the real
//     binding is made at the next call that depends on it (and skipped if it's already that buffer);
//   * client vertices stream into one large ring buffer with bufferSubData instead of reallocating a
//     buffer per draw (the ring is orphaned when it wraps, so the GPU never waits on it);
//   * client indices are only re-uploaded when they differ from the last upload — SpriteBatch sends the
//     same quad index list every time;
//   * the active texture unit and each unit's 2D texture are cached (see bindTexture).
const ARRAY_BUFFER = 0x8892, ELEMENT_ARRAY_BUFFER = 0x8893, STREAM_DRAW = 0x88E0;
let boundArray = 0, boundElement = 0;     // what MonoGame asked for (buffer ids; 0 = none/client memory)
let glArray = null, glElement = null;     // what is actually bound in WebGL
const clientAttribs = new Map();      // attribute index -> { size, type, normalized, stride, ptr }
let scratchIndices = null;
let lastIndices = null, lastIndexType = 0;   // copy of what scratchIndices holds

const VERTEX_RING_BYTES = 4 << 20;
let vertexRing = null, vertexRingSize = 0, vertexRingPos = 0;

// Both send the sprite queue first: its flush rebinds buffers, so the cache must be read after it.
function bindArrayGL(buffer) {
    if (spriteQueue.length) flushSpriteQueue();
    if (glArray !== buffer) { gl.bindBuffer(ARRAY_BUFFER, buffer); glArray = buffer; }
}
function bindElementGL(buffer) {
    if (spriteQueue.length) flushSpriteQueue();
    if (glElement !== buffer) { gl.bindBuffer(ELEMENT_ARRAY_BUFFER, buffer); glElement = buffer; }
}
// Makes WebGL's binding for `target` the one MonoGame last asked for, before a call that uses it.
function syncBinding(target) {
    if (target === ARRAY_BUFFER) bindArrayGL(buffers.get(boundArray));
    else if (target === ELEMENT_ARRAY_BUFFER) bindElementGL(buffers.get(boundElement));
}

export function genBuffer() { return buffers.add(gl.createBuffer()); }
export function deleteBuffer(id) {
    const b = buffers.get(id);
    if (b && glArray === b) glArray = null;          // deleting a bound buffer unbinds it
    if (b && glElement === b) glElement = null;
    gl.deleteBuffer(b); buffers.remove(id);
}
export function bindBuffer(target, id) {
    if (target === ARRAY_BUFFER) boundArray = id;
    else if (target === ELEMENT_ARRAY_BUFFER) boundElement = id;
    else gl.bindBuffer(target, buffers.get(id));
}

function typeSize(type) {
    switch (type) {
        case 0x1400: case 0x1401: return 1;                    // BYTE, UNSIGNED_BYTE
        case 0x1402: case 0x1403: case 0x140B: return 2;       // SHORT, UNSIGNED_SHORT, HALF_FLOAT
        default: return 4;                                      // FLOAT, INT, UNSIGNED_INT, packed
    }
}

// Streams the first `vertexCount` client vertices into the vertex ring and points the remembered
// attributes at them.
function bindClientVertices(vertexCount) {
    if (clientAttribs.size === 0) return;
    let base = Infinity, end = 0;
    for (const a of clientAttribs.values()) {
        const stride = a.stride || a.size * typeSize(a.type);
        base = Math.min(base, a.ptr);
        end = Math.max(end, a.ptr + (vertexCount - 1) * stride + a.size * typeSize(a.type));
    }
    const bytes = end - base;
    vertexRing ??= gl.createBuffer();
    bindArrayGL(vertexRing);
    if (bytes > vertexRingSize || vertexRingPos + bytes > vertexRingSize) {
        // Full (or too small): orphan it — WebGL hands back fresh storage, the GPU keeps the old.
        vertexRingSize = Math.max(VERTEX_RING_BYTES, bytes);
        gl.bufferData(ARRAY_BUFFER, vertexRingSize, STREAM_DRAW);
        vertexRingPos = 0;
    }
    const at = vertexRingPos;
    gl.bufferSubData(ARRAY_BUFFER, at, heapBytes(base, bytes));
    vertexRingPos = (at + bytes + 15) & ~15;
    for (const [i, a] of clientAttribs) gl.vertexAttribPointer(i, a.size, a.type, a.normalized, a.stride, at + a.ptr - base);
}

// Uploads client-memory indices into the scratch index buffer unless it already holds exactly these.
function bindClientIndices(indices, type) {
    scratchIndices ??= gl.createBuffer();
    bindElementGL(scratchIndices);
    const same = lastIndices && lastIndexType === type && indices.length <= lastIndices.length &&
        (() => { for (let i = 0; i < indices.length; i++) if (indices[i] !== lastIndices[i]) return false; return true; })();
    if (same) return;
    gl.bufferData(ELEMENT_ARRAY_BUFFER, indices, STREAM_DRAW);
    lastIndices = indices.slice();
    lastIndexType = type;
}

// ---------------------------------------------------------------------------------------------------
// The sprite queue. SpriteBatch draws every batch the same way: vertices in .NET memory, and the same
// quad index list (0,1,2, 1,3,2, 4,5,6, ...). Such draws aren't sent one by one: their vertices are
// copied into a staging area and only the texture and where its quads start are remembered. When
// anything else touches WebGL (a state change, a render-target switch, a texture upload — see the gate
// in init), when staging fills, and at the end of every frame, the queue goes out together: ONE vertex
// upload, the attribute pointers set ONCE, then per draw just its texture and the draw itself, with the
// indices taken from a prebuilt quad index buffer. That is 2 WebGL calls per sprite draw instead of 6.
// ---------------------------------------------------------------------------------------------------
const TRIANGLES = 0x0004, UNSIGNED_SHORT = 0x1403, UNSIGNED_INT = 0x1405;
const STAGING_BYTES = 4 << 20;
const staging = new Uint8Array(STAGING_BYTES);
let stagingPos = 0;
const spriteQueue = [];            // { texture, count, firstVertex }
let queueLayout = null;            // the attribute layout the queued vertices share
let queueStride = 0;
let quadPattern = null;            // the 6 indices of quad 0, as SpriteBatch sends them
let knownQuadPtr = 0, knownQuadCount = 0;
let quadIndexBuffer = null, quadIndexQuads = 0;
let spriteVertexBuffer = null;
let desiredTexture0 = null;        // what MonoGame last bound on unit 0 (bindTexture may defer it)

function clientLayout() {
    let base = Infinity, stride = 0;
    for (const a of clientAttribs.values()) { base = Math.min(base, a.ptr); stride = a.stride || stride; }
    let key = String(stride);
    for (const [i, a] of clientAttribs) key += `|${i}:${a.size}:${a.type}:${a.normalized ? 1 : 0}:${a.stride}:${a.ptr - base}`;
    return { base, stride, key };
}

// Whether `indices` (count of them) are SpriteBatch's quad list. Seen once in full per array; after
// that, the same array is recognised by its address and a few samples.
function isQuadList(indices, ptr, count) {
    if (count % 6 !== 0 || count === 0) return false;
    if (!quadPattern) {
        const p = Array.from(indices.subarray(0, 6));
        if (p.some(v => v > 3)) return false;
        quadPattern = p;
    }
    const at = q => { for (let k = 0; k < 6; k++) if (indices[q * 6 + k] !== q * 4 + quadPattern[k]) return false; return true; };
    const quads = count / 6;
    if (ptr === knownQuadPtr && count <= knownQuadCount) return at(0) && at(quads - 1) && at(quads >> 1);
    for (let q = 0; q < quads; q++) if (!at(q)) return false;
    knownQuadPtr = ptr; knownQuadCount = count;
    return true;
}

// Queues a client-memory draw if it is a plain sprite draw; returns false if it must go out as usual.
function queueSpriteDraw(mode, count, type, ptr) {
    if (mode !== TRIANGLES || type !== UNSIGNED_SHORT || boundArray !== 0 || boundElement !== 0) return false;
    if (clientAttribs.size === 0 || activeUnit !== TEXTURE0) return false;
    const indices = new Uint16Array(heap().buffer, ptr, count);
    if (!isQuadList(indices, ptr, count)) return false;

    const layout = clientLayout();
    if (!layout.stride) return false;
    const vertices = (count / 6) * 4;
    const bytes = vertices * layout.stride;
    if (bytes > STAGING_BYTES) return false;
    if (spriteQueue.length && layout.key !== queueLayout) flushSpriteQueue();
    // Each draw's vertices start on a quad boundary, so the shared index buffer can address them.
    let at = Math.ceil(stagingPos / (layout.stride * 4)) * layout.stride * 4;
    if (at + bytes > STAGING_BYTES) { flushSpriteQueue(); at = 0; }

    staging.set(heap().subarray(layout.base, layout.base + bytes), at);
    stagingPos = at + bytes;
    queueLayout = layout.key; queueStride = layout.stride;
    spriteQueue.push({ texture: desiredTexture0, count, firstVertex: at / layout.stride, attribs: [...clientAttribs], base: layout.base });
    return true;
}

function flushSpriteQueue() {
    if (spriteQueue.length === 0) return;
    const queue = spriteQueue.splice(0);
    const g = raw;

    spriteVertexBuffer ??= g.createBuffer();
    g.bindBuffer(ARRAY_BUFFER, spriteVertexBuffer); glArray = spriteVertexBuffer;
    g.bufferData(ARRAY_BUFFER, staging.subarray(0, stagingPos), STREAM_DRAW);
    const first = queue[0];
    for (const [i, a] of first.attribs) g.vertexAttribPointer(i, a.size, a.type, a.normalized, a.stride, a.ptr - first.base);

    const neededQuads = Math.ceil(stagingPos / (queueStride * 4)) + 1;
    quadIndexBuffer ??= g.createBuffer();
    g.bindBuffer(ELEMENT_ARRAY_BUFFER, quadIndexBuffer); glElement = quadIndexBuffer;
    if (neededQuads > quadIndexQuads) {
        quadIndexQuads = Math.max(neededQuads, quadIndexQuads * 2, 4096);
        const idx = new Uint32Array(quadIndexQuads * 6);
        for (let q = 0; q < quadIndexQuads; q++) for (let k = 0; k < 6; k++) idx[q * 6 + k] = q * 4 + quadPattern[k];
        g.bufferData(ELEMENT_ARRAY_BUFFER, idx, 0x88E4 /* STATIC_DRAW */);
    }

    for (const d of queue) {
        if (unitTextures[0] !== d.texture) { g.bindTexture(TEXTURE_2D, d.texture); unitTextures[0] = d.texture; }
        g.drawElements(TRIANGLES, d.count, UNSIGNED_INT, (d.firstVertex / 4) * 6 * 4);
    }
    stagingPos = 0;
    queueLayout = null;

    // Put unit 0 back to what MonoGame believes is bound.
    if (unitTextures[0] !== desiredTexture0) { g.bindTexture(TEXTURE_2D, desiredTexture0); unitTextures[0] = desiredTexture0; }
}

export function bufferData(target, size, ptr, usage) {
    syncBinding(target);
    if (target === ELEMENT_ARRAY_BUFFER && buffers.get(boundElement) === scratchIndices) lastIndices = null;
    if (ptr) gl.bufferData(target, heapBytes(ptr, size), usage);
    else gl.bufferData(target, size, usage);
}
export function bufferSubData(target, offset, size, ptr) {
    syncBinding(target);
    gl.bufferSubData(target, offset, heapBytes(ptr, size));
}

// Vertex input / draw
export function enableVertexAttribArray(i) { gl.enableVertexAttribArray(i); }
export function disableVertexAttribArray(i) { gl.disableVertexAttribArray(i); }
export function vertexAttribPointer(i, size, type, normalized, stride, offset) {
    if (boundArray === 0) {
        // `offset` is a pointer into wasm memory — a client-side array (see bindClientVertices).
        clientAttribs.set(i, { size, type, normalized, stride, ptr: offset });
        return;
    }
    clientAttribs.delete(i);
    syncBinding(ARRAY_BUFFER);
    gl.vertexAttribPointer(i, size, type, normalized, stride, offset);
}
export function vertexAttribDivisor(i, d) { gl.vertexAttribDivisor(i, d); }
export function drawArrays(mode, first, count) {
    if (boundArray === 0) bindClientVertices(first + count);
    gl.drawArrays(mode, first, count);
}
export function drawElements(mode, count, type, offset) {
    if (boundElement === 0 && queueSpriteDraw(mode, count, type, offset)) return;
    if (spriteQueue.length) flushSpriteQueue();
    if (boundElement === 0) {
        // `offset` is a pointer to the indices in wasm memory: upload them (if they changed), and find
        // how many vertices they reach so only those are streamed.
        const indices = type === 0x1405 ? new Uint32Array(heap().buffer, offset, count)
                      : type === 0x1403 ? new Uint16Array(heap().buffer, offset, count)
                      : new Uint8Array(heap().buffer, offset, count);
        if (boundArray === 0 && clientAttribs.size) {
            let max = 0;
            for (let i = 0; i < count; i++) if (indices[i] > max) max = indices[i];
            bindClientVertices(max + 1);
        }
        bindClientIndices(indices, type);
        offset = 0;
    } else {
        syncBinding(ELEMENT_ARRAY_BUFFER);
    }
    gl.drawElements(mode, count, type, offset);
}
export function drawElementsInstanced(mode, count, type, offset, instances) {
    syncBinding(ELEMENT_ARRAY_BUFFER);
    gl.drawElementsInstanced(mode, count, type, offset, instances);
}

// Textures
export function genTexture() { return textures.add(gl.createTexture()); }
// The active unit and each unit's 2D texture, so binding what is already bound costs nothing.
const TEXTURE0 = 0x84C0, TEXTURE_2D = 0x0DE1;
let activeUnit = TEXTURE0;
const unitTextures = [];
export function deleteTexture(id) {
    if (spriteQueue.length) flushSpriteQueue();
    const t = textures.get(id);
    if (desiredTexture0 === t) desiredTexture0 = null;
    for (let i = 0; i < unitTextures.length; i++) if (unitTextures[i] === t) unitTextures[i] = null;
    gl.deleteTexture(t); textures.remove(id);
}
export function bindTexture(target, id) {
    const t = textures.get(id);
    if (target === TEXTURE_2D && activeUnit === TEXTURE0) {
        desiredTexture0 = t;
        if (spriteQueue.length) return;          // the queued draws carry their own textures
    }
    if (target === TEXTURE_2D) {
        const unit = activeUnit - TEXTURE0;
        if (unitTextures[unit] === t) return;
        unitTextures[unit] = t;
    }
    gl.bindTexture(target, t);
}
export function activeTexture(unit) {
    if (unit === activeUnit) return;
    if (spriteQueue.length) flushSpriteQueue();
    gl.activeTexture(unit); activeUnit = unit;
}
export function texParameteri(target, pname, v) { gl.texParameteri(target, pname, v); }
export function texParameterf(target, pname, v) { gl.texParameterf(target, pname, v); }
export function pixelStorei(pname, v) {
    // GL_UNPACK_ROW_LENGTH etc. exist in WebGL2; only the two alignment parameters matter to MonoGame.
    gl.pixelStorei(pname, v);
}
export function generateMipmap(target) { gl.generateMipmap(target); }

// The pixel view WebGL wants depends on the GL pixel type.
function pixelView(type, ptr, byteLength) {
    if (!ptr) return null;
    switch (type) {
        case 0x1406: /* FLOAT */ return new Float32Array(heap().buffer, ptr, byteLength >> 2);
        case 0x1403: /* UNSIGNED_SHORT */
        case 0x8363: /* UNSIGNED_SHORT_5_6_5 */
        case 0x8033: /* UNSIGNED_SHORT_4_4_4_4 */
        case 0x8034: /* UNSIGNED_SHORT_5_5_5_1 */
        case 0x140B: /* HALF_FLOAT */ return new Uint16Array(heap().buffer, ptr, byteLength >> 1);
        case 0x1405: /* UNSIGNED_INT */
        case 0x8368: /* UNSIGNED_INT_2_10_10_10_REV */ return new Uint32Array(heap().buffer, ptr, byteLength >> 2);
        default: return heapBytes(ptr, byteLength);
    }
}
function bytesPerPixel(format, type) {
    const channels = { 0x1903: 1 /*RED*/, 0x1906: 1 /*ALPHA*/, 0x1909: 1 /*LUMINANCE*/, 0x190A: 2 /*LUMINANCE_ALPHA*/,
        0x8227: 2 /*RG*/, 0x1907: 3 /*RGB*/, 0x1908: 4 /*RGBA*/ }[format] ?? 4;
    switch (type) {
        case 0x1401: case 0x1400: return channels;            // UNSIGNED_BYTE / BYTE
        case 0x1403: case 0x1402: case 0x140B: return channels * 2;
        case 0x1406: case 0x1405: case 0x1404: return channels * 4;
        default: return 2;                                     // packed 16-bit formats
    }
}

// MonoGame's GLES path asks for unsized internal formats with sized-format types for float/half data;
// WebGL2 only accepts sized internal formats for those, so the format is promoted here.
function internalFormatFor(internal, format, type) {
    if (type === 0x1406 /*FLOAT*/) return { 0x1903: 0x822E, 0x8227: 0x8230, 0x1908: 0x8814 }[format] ?? internal;
    if (type === 0x140B /*HALF_FLOAT*/) return { 0x1903: 0x822D, 0x8227: 0x822F, 0x1908: 0x881A }[format] ?? internal;
    return internal;
}

export function texImage2D(target, level, internal, w, h, border, format, type, ptr) {
    gl.texImage2D(target, level, internalFormatFor(internal, format, type), w, h, border, format, type,
        pixelView(type, ptr, w * h * bytesPerPixel(format, type)));
}
export function texSubImage2D(target, level, x, y, w, h, format, type, ptr) {
    gl.texSubImage2D(target, level, x, y, w, h, format, type, pixelView(type, ptr, w * h * bytesPerPixel(format, type)));
}
export function compressedTexImage2D(target, level, internal, w, h, border, size, ptr) {
    gl.compressedTexImage2D(target, level, internal, w, h, border, heapBytes(ptr, size));
}
export function compressedTexSubImage2D(target, level, x, y, w, h, format, size, ptr) {
    gl.compressedTexSubImage2D(target, level, x, y, w, h, format, heapBytes(ptr, size));
}
export function texImage3D(target, level, internal, w, h, d, border, format, type, ptr) {
    gl.texImage3D(target, level, internalFormatFor(internal, format, type), w, h, d, border, format, type,
        pixelView(type, ptr, w * h * d * bytesPerPixel(format, type)));
}
export function texSubImage3D(target, level, x, y, z, w, h, d, format, type, ptr) {
    gl.texSubImage3D(target, level, x, y, z, w, h, d, format, type, pixelView(type, ptr, w * h * d * bytesPerPixel(format, type)));
}
export function readPixels(x, y, w, h, format, type, ptr) {
    gl.readPixels(x, y, w, h, format, type, pixelView(type, ptr, w * h * bytesPerPixel(format, type)));
}

// Framebuffers / renderbuffers
export function genFramebuffer() { return framebuffers.add(gl.createFramebuffer()); }
// MonoGame reads a texture back (Texture2D.GetData on GLES) by binding a temporary framebuffer and
// deleting it, without binding anything else afterwards: it relies on GL's rule that deleting the bound
// framebuffer puts drawing back on the screen. Done explicitly here — otherwise the rest of that frame
// can be drawn into nothing, leaving the cleared canvas on screen: in Firefox, a black flash the first
// time a game starts and the first time a commander is selected (when such readbacks happen).
export function deleteFramebuffer(id) {
    const fb = framebuffers.get(id);
    const wasBound = fb && gl.getParameter(gl.FRAMEBUFFER_BINDING) === fb;
    gl.deleteFramebuffer(fb); framebuffers.remove(id);
    if (wasBound) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
export function bindFramebuffer(target, id) { gl.bindFramebuffer(target, framebuffers.get(id)); }
export function framebufferTexture2D(target, attachment, textarget, tex, level) {
    gl.framebufferTexture2D(target, attachment, textarget, textures.get(tex), level);
}
export function framebufferRenderbuffer(target, attachment, rbtarget, rb) {
    gl.framebufferRenderbuffer(target, attachment, rbtarget, renderbuffers.get(rb));
}
export function checkFramebufferStatus(target) { return gl.checkFramebufferStatus(target); }
export function genRenderbuffer() { return renderbuffers.add(gl.createRenderbuffer()); }
export function deleteRenderbuffer(id) { gl.deleteRenderbuffer(renderbuffers.get(id)); renderbuffers.remove(id); }
export function bindRenderbuffer(target, id) { gl.bindRenderbuffer(target, renderbuffers.get(id)); }
export function renderbufferStorage(target, format, w, h) { gl.renderbufferStorage(target, format, w, h); }
export function renderbufferStorageMultisample(target, samples, format, w, h) {
    gl.renderbufferStorageMultisample(target, samples, format, w, h);
}
export function blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
    gl.blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
}
export function drawBuffers(list) { gl.drawBuffers(list); }
export function readBuffer(mode) { gl.readBuffer(mode); }
export function invalidateFramebuffer(target, list) { gl.invalidateFramebuffer(target, list); }

// Shaders / programs
export function createShader(type) { return shaders.add(gl.createShader(type)); }
export function deleteShader(id) { gl.deleteShader(shaders.get(id)); shaders.remove(id); }
export function isShader(id) { return !!shaders.get(id); }
export function shaderSource(id, source) { gl.shaderSource(shaders.get(id), source); }
export function compileShader(id) { gl.compileShader(shaders.get(id)); }
export function getShaderParameter(id, pname) {
    if (pname === 0x8B84 /*INFO_LOG_LENGTH*/) return (gl.getShaderInfoLog(shaders.get(id)) || '').length + 1;
    const v = gl.getShaderParameter(shaders.get(id), pname);
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0);
}
export function getShaderInfoLog(id) { return gl.getShaderInfoLog(shaders.get(id)) || ''; }

export function createProgram() { return programs.add(gl.createProgram()); }
export function deleteProgram(id) { gl.deleteProgram(programs.get(id)); programs.remove(id); }
export function isProgram(id) { return !!programs.get(id); }
export function attachShader(p, s) { gl.attachShader(programs.get(p), shaders.get(s)); }
export function detachShader(p, s) { gl.detachShader(programs.get(p), shaders.get(s)); }
export function linkProgram(p) { gl.linkProgram(programs.get(p)); }
export function useProgram(p) { gl.useProgram(programs.get(p)); }
export function getProgramParameter(p, pname) {
    if (pname === 0x8B84 /*INFO_LOG_LENGTH*/) return (gl.getProgramInfoLog(programs.get(p)) || '').length + 1;
    const v = gl.getProgramParameter(programs.get(p), pname);
    return typeof v === 'boolean' ? (v ? 1 : 0) : (v | 0);
}
export function getProgramInfoLog(p) { return gl.getProgramInfoLog(programs.get(p)) || ''; }
export function getAttribLocation(p, name) { return gl.getAttribLocation(programs.get(p), name); }
// GL returns -1 for "no such uniform"; MonoGame skips -1, so a null location must map to it.
export function getUniformLocation(p, name) {
    const loc = gl.getUniformLocation(programs.get(p), name);
    return loc ? uniforms.add(loc) : -1;
}
export function uniform1i(loc, v) { gl.uniform1i(uniforms.get(loc), v); }
export function uniform4fv(loc, count, ptr) { gl.uniform4fv(uniforms.get(loc), heapFloats(ptr, count * 4)); }

// ---------------------------------------------------------------------------------------------------
// Audio. Sound effects are Web Audio buffers (decoded once from the .xnb's PCM); songs are <audio>
// elements streaming the .ogg MonoGame's DesktopGL SongProcessor writes next to the .xnb. Browsers
// refuse to start audio before the first user gesture, so playback requested earlier (the menu music
// at boot) is remembered and started on the first click/keypress.
// ---------------------------------------------------------------------------------------------------

let audio = null;
const soundBuffers = new Table();
const voices = new Table();
const songs = new Table();
const wantsPlay = new Set();     // songs asked to play before the page was allowed to

function audioContext() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    return audio;
}

// The first user gesture unlocks audio: resumes the Web Audio context and starts every song that
// asked to play before the page was allowed to. Registered at load rather than when the first sound
// is created, so the menu music starts on the very first click.
function unlockAudio() {
    audio?.resume();
    for (const id of wantsPlay) {
        const s = songs.get(id);
        if (s && s.want) s.el.play().then(() => logSongs('play-unlocked', id)).catch(err => logSongs('unlock-failed (' + (err && err.name) + ')', id));
    }
    wantsPlay.clear();
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlockAudio, { capture: true });

// 8/16-bit little-endian interleaved PCM -> AudioBuffer.
export function createSoundBuffer(ptr, byteLength, bits, sampleRate, channels) {
    const ctx = audioContext();
    const bytesPerSample = bits >> 3;
    const frames = Math.floor(byteLength / (bytesPerSample * channels));
    if (frames <= 0) return 0;
    const buf = ctx.createBuffer(channels, frames, sampleRate);
    const src = heap();
    for (let c = 0; c < channels; c++) {
        const out = buf.getChannelData(c);
        if (bits === 16) {
            const view = new DataView(src.buffer, ptr, byteLength);
            for (let i = 0, o = c * 2; i < frames; i++, o += 2 * channels) out[i] = view.getInt16(o, true) / 32768;
        } else {
            for (let i = 0, o = ptr + c; i < frames; i++, o += channels) out[i] = (src[o] - 128) / 128;
        }
    }
    return soundBuffers.add(buf);
}
export function deleteSoundBuffer(id) { soundBuffers.remove(id); }

// Voices = SoundEffectInstances. XNA SoundState: 0 Playing, 1 Paused, 2 Stopped.
export function createVoice(bufferId) {
    const ctx = audioContext();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.connect(pan).connect(ctx.destination);
    return voices.add({ buffer: soundBuffers.get(bufferId), gain, pan, source: null, state: 2, loop: false, rate: 1, offset: 0, startedAt: 0 });
}
function startVoice(v, offset) {
    const ctx = audioContext();
    const s = ctx.createBufferSource();
    s.buffer = v.buffer; s.loop = v.loop; s.playbackRate.value = v.rate;
    s.connect(v.gain);
    s.onended = () => { if (v.source === s) { v.source = null; v.state = 2; v.offset = 0; } };
    v.source = s; v.state = 0; v.offset = offset; v.startedAt = ctx.currentTime;
    s.start(0, offset);
}
function haltVoice(v) {
    if (!v.source) return;
    const s = v.source; v.source = null;
    try { s.stop(); } catch { }
}
export function voicePlay(id) { const v = voices.get(id); if (!v || !v.buffer) return; haltVoice(v); startVoice(v, 0); }
export function voicePause(id) {
    const v = voices.get(id); if (!v || v.state !== 0) return;
    const played = (audioContext().currentTime - v.startedAt) * v.rate + v.offset;
    v.offset = v.buffer ? played % v.buffer.duration : 0;
    haltVoice(v); v.state = 1;
}
export function voiceResume(id) { const v = voices.get(id); if (v && v.state === 1) startVoice(v, v.offset); }
export function voiceStop(id) { const v = voices.get(id); if (!v) return; haltVoice(v); v.state = 2; v.offset = 0; }
export function voiceState(id) { return voices.get(id)?.state ?? 2; }
export function voiceVolume(id, value) { const v = voices.get(id); if (v) v.gain.gain.value = value; }
export function voicePan(id, value) { const v = voices.get(id); if (v) v.pan.pan.value = value; }
export function voicePitch(id, value) { const v = voices.get(id); if (v) { v.rate = Math.pow(2, value); if (v.source) v.source.playbackRate.value = v.rate; } }
export function voiceLoop(id, loop) { const v = voices.get(id); if (v) { v.loop = loop; if (v.source) v.source.loop = loop; } }
export function deleteVoice(id) {
    const v = voices.get(id); if (!v) return;
    haltVoice(v); v.gain.disconnect(); v.pan.disconnect(); voices.remove(id);
}

// Songs
// ?audiolog: log every song start/stop with how many songs are audibly playing at that moment.
const audioLog = new URLSearchParams(location.search).has('audiolog');
function logSongs(what, id) {
    if (!audioLog) return;
    const playing = songs.items.filter(s => s && !s.el.paused).map(s => s.url.split('/').pop());
    console.log(`[audio] ${what} #${id} ${songs.get(id)?.url.split('/').pop()} | playing now: ${playing.length} [${playing.join(', ')}]`);
}
// `want` is whether the game currently wants this song audible: set by play/resume, cleared by
// pause/stop. A play() promise can reject long after the call (AbortError when a pause interrupts it),
// so only a song that is still wanted AND was refused for lack of a user gesture (NotAllowedError) is
// queued for the unlock - anything else queued here would start playing on a later click alongside the
// real track, and its 'ended' would then tell MediaPlayer the real track had finished.
function startSong(id, s, what) {
    if (!s.ready) return; // starts when its bytes arrive (see createSong) if still wanted then
    s.el.play().then(() => logSongs(what, id)).catch(err => {
        if (s.want && err && err.name === 'NotAllowedError') wantsPlay.add(id);
        logSongs(what + '-refused (' + (err && err.name) + ')', id);
    });
}
// The whole .ogg is fetched once and played from a Blob URL rather than streamed from the server:
// an <audio> element streaming over HTTP issues Range requests whenever it seeks or resumes, and a
// server that answers those wrongly (the Blazor dev server returns the WHOLE file under a 206) hands
// the decoder misaligned bytes - the song cuts out and reports 'ended' early. In memory, it can't.
export function createSong(url, onEnded) {
    const el = new Audio();
    el.preload = 'auto';
    const s = { el, url, want: false, ready: false, start: 0 };
    const id = songs.add(s);
    fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(blob => {
        if (!songs.get(id)) return;
        el.src = URL.createObjectURL(blob);
        s.ready = true;
        if (s.want) { try { el.currentTime = s.start; } catch { } startSong(id, s, 'play'); }
    }).catch(err => logSongs('load-failed (' + err + ')', id));
    el.addEventListener('ended', () => {
        logSongs('ended (' + el.currentTime.toFixed(1) + 's of ' + el.duration.toFixed(1) + 's)', id);
        if (!el.loop && s.want) { s.want = false; onEnded(); }
    });
    el.addEventListener('error', () => logSongs('error (' + (el.error && el.error.code) + ')', id));
    return id;
}
export function songPlay(id, startSeconds, loop) {
    const s = songs.get(id); if (!s) return;
    s.want = true;
    s.start = startSeconds;
    s.el.loop = loop;
    if (s.ready) try { s.el.currentTime = startSeconds; } catch { }
    startSong(id, s, 'play');
}
export function songPause(id) { const s = songs.get(id); if (s) { s.want = false; wantsPlay.delete(id); s.el.pause(); } }
export function songResume(id) { const s = songs.get(id); if (s) { s.want = true; startSong(id, s, 'resume'); } }
export function songStop(id) { const s = songs.get(id); if (s) { s.want = false; wantsPlay.delete(id); s.el.pause(); try { s.el.currentTime = 0; } catch { } logSongs('stop', id); } }
export function songVolume(id, value) { const s = songs.get(id); if (s) s.el.volume = Math.max(0, Math.min(1, value)); }
export function songGetPosition(id) { return songs.get(id)?.el.currentTime ?? 0; }
export function songSetPosition(id, seconds) { const s = songs.get(id); if (s) try { s.el.currentTime = seconds; } catch { } }
export function deleteSong(id) { const s = songs.get(id); if (s) { s.want = false; wantsPlay.delete(id); s.el.pause(); const src = s.el.src; s.el.removeAttribute('src'); s.el.load(); if (src.startsWith('blob:')) URL.revokeObjectURL(src); songs.remove(id); } }
