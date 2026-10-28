// The page's handle on the engine worker (engine.worker.js). Imported by Platform/EngineWorker.cs, which
// starts the worker booting at once so its runtime is warm by the time the first job needs it.
// call(op, payload) posts one request and resolves with the worker's answer.
const worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;

worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error !== undefined) entry.reject(new Error(error));
    else entry.resolve(result);
};

worker.onerror = (e) => {
    // A worker that failed to start fails every request still waiting; the game then does the work
    // on the page itself (see BattleManager.TryCollectBackgroundMove).
    for (const entry of pending.values()) entry.reject(new Error('engine worker error: ' + e.message));
    pending.clear();
};

export function call(op, payload) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, payload });
    });
}
