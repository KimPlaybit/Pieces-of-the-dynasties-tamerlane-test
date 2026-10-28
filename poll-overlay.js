// The faction poll, laid over the game as an HTML panel with the poll in an iframe (see
// ChessHeroes.Core/Demo/FactionPoll.cs for when the game asks). The canvas can't host a web page,
// so the panel is plain DOM on top of it; while it is open it takes every click and key, and the
// game underneath simply waits.

const VOTED_KEY = 'tamerlanePollVoted';

// The panel's styles travel with this module rather than living in app.css: a browser still holding
// an older app.css would otherwise show the panel unstyled, in the page flow under the game.
const STYLES = `
#poll-overlay {
    position: fixed; inset: 0; z-index: 20;
    display: none; align-items: center; justify-content: center;
    background: rgba(4, 3, 2, 0.72);
}
#poll-overlay.open { display: flex; }
.poll-panel {
    box-sizing: border-box;
    width: min(600px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-x: hidden; overflow-y: auto;
    padding: 24px 24px 20px;
    background: linear-gradient(#1b1712, #0d0b08);
    border: 2px solid #7a6334; border-radius: 8px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
    font-family: Georgia, "Times New Roman", serif; color: #d8c79f; text-align: center;
}
.poll-title { color: #e2c27a; font-size: clamp(20px, 4vw, 28px); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 14px; }
.poll-note { font-size: 15px; line-height: 1.5; margin: 0 0 10px; }
.poll-frame-wrap { position: relative; margin: 14px 0 18px; }
.poll-frame { box-sizing: border-box; display: block; width: 100%; height: min(440px, 55vh); border: 1px solid #5a4a2a; border-radius: 6px; background: #fff; }
/* Sits over the poll page's top-left corner, where its header logo is — the page is another site's,
   so the logo can't be hidden from here, but our own button can cover it. */
.poll-reload {
    position: absolute; top: 6px; left: 8px;
    font: inherit; font-size: 14px; color: #f0e2bd; cursor: pointer;
    padding: 7px 14px; min-height: 36px;
    background: linear-gradient(#3a2f1c, #231c10); border: 1px solid #a8884a; border-radius: 6px;
}
.poll-reload:hover, .poll-reload:focus-visible { background: linear-gradient(#5a4726, #352a17); color: #ffe7a6; outline: none; }
.poll-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.poll-button {
    font: inherit; font-size: 16px; color: #f0e2bd; cursor: pointer;
    padding: 9px 20px; min-width: 160px;
    background: linear-gradient(#3a2f1c, #231c10); border: 1px solid #a8884a; border-radius: 6px;
}
.poll-button:hover, .poll-button:focus-visible { background: linear-gradient(#5a4726, #352a17); color: #ffe7a6; outline: none; }
`;

let overlay = null;
let frame = null;

function hasVoted() {
    try { return localStorage.getItem(VOTED_KEY) === '1'; } catch { return false; }
}

function markVoted() {
    try { localStorage.setItem(VOTED_KEY, '1'); } catch { }
}

function build(url) {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'poll-overlay';
    overlay.innerHTML = `
        <div class="poll-panel" role="dialog" aria-modal="true" aria-labelledby="poll-title">
            <div class="poll-title" id="poll-title">Should Tamerlane be added?</div>
            <p class="poll-note">
                This faction is not authentic Tamerlane chess. Played as written, Tamerlane chess
                would just be a better chess faction, so this army takes its pieces and builds a
                faction of its own around them.
            </p>
            <p class="poll-note">Should it be added to the game as a playable faction, or skipped?</p>
            <div class="poll-frame-wrap">
                <iframe class="poll-frame" title="Tamerlane faction poll"></iframe>
                <button type="button" class="poll-reload" data-action="reload">&#x21bb; Reload poll</button>
            </div>
            <div class="poll-actions">
                <button type="button" class="poll-button" data-action="voted">I've voted</button>
                <button type="button" class="poll-button" data-action="close">Back to the game</button>
            </div>
        </div>`;
    frame = overlay.querySelector('.poll-frame');
    frame.dataset.src = url;

    // Only the buttons (and Escape) close it, never a click on the dimmed backdrop: the game opens
    // the panel on the mouse PRESS, so the release that follows lands on the backdrop at once.
    overlay.addEventListener('click', e => {
        const action = e.target.dataset && e.target.dataset.action;
        if (action === 'reload') frame.setAttribute('src', frame.dataset.src); // re-setting src reloads it
        else if (action === 'voted') { markVoted(); hide(); }
        else if (action === 'close') hide();
    });
    document.body.appendChild(overlay);
}

function hide() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.getElementById('canvas')?.focus({ preventScroll: true });
}

// The game's own key handlers sit on window; while the panel is open, Escape closes it and no key
// reaches the game underneath.
window.addEventListener('keydown', e => {
    if (!overlay || !overlay.classList.contains('open')) return;
    if (e.key === 'Escape') hide();
    e.stopImmediatePropagation();
}, { capture: true });

/** Opens the poll. `automatic` is the end-of-battle ask, skipped once the player has said they voted;
 *  the in-battle button always opens it. */
export function show(url, automatic) {
    if (automatic && hasVoted()) return;
    if (!overlay) build(url);
    // The poll page loads on first open, not with the game.
    if (!frame.src) frame.src = frame.dataset.src;
    overlay.classList.add('open');
    overlay.querySelector('[data-action="close"]').focus({ preventScroll: true });
}
