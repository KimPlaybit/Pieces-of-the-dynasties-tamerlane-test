// The loading screen's three stages, each owning a slice of one bar:
//   0-30%   the .NET runtime + game code (Blazor reports it through --blazor-load-percentage)
//   30-95%  the game's startup art (the `monogame-preload` events from MonoGame.Framework.WebGL)
//   95-100% starting the game (GameHost calls chLoader.stage / chLoader.done)
(function () {
    const fill = () => document.getElementById('loading-fill');
    const stageEl = () => document.getElementById('loading-stage');
    const detailEl = () => document.getElementById('loading-detail');
    let phase = 'runtime';

    function set(fraction) {
        const el = fill();
        if (el) el.style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + '%';
    }
    const mb = b => (b / 1048576).toFixed(0);

    // Stage 1: Blazor writes its own download progress into a CSS variable on <html>.
    const watch = setInterval(() => {
        if (phase !== 'runtime') { clearInterval(watch); return; }
        const v = getComputedStyle(document.documentElement).getPropertyValue('--blazor-load-percentage');
        const pct = parseFloat(v);
        if (!isNaN(pct)) set(0.3 * pct / 100);
    }, 100);

    // Stage 2: the art preload.
    window.addEventListener('monogame-preload', e => {
        const { loaded, total, done, count } = e.detail;
        if (phase === 'runtime') {
            phase = 'art';
            stageEl().textContent = 'Loading the game…';
        }
        set(0.3 + 0.65 * (total > 0 ? loaded / total : done / Math.max(1, count)));
        detailEl().textContent = total > 0 ? `${mb(loaded)} / ${mb(total)} MB` : '';
    });

    window.chLoader = {
        stage(text, fraction) {
            phase = 'start';
            stageEl().textContent = text;
            detailEl().textContent = '';
            if (fraction !== undefined) set(fraction);
        },
        done() {
            set(1);
            const el = document.getElementById('loading');
            if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 600); }
        },
        fail(message) {
            phase = 'failed';
            stageEl().textContent = 'The game could not start.';
            detailEl().textContent = message || '';
        },
    };
})();
