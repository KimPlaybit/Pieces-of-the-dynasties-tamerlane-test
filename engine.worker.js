// The game's background thread: a dedicated Web Worker running its own copy of the .NET runtime, booted
// from the same _framework files the page uses. The page posts {id, op, payload}; the worker answers
// {id, result} or {id, error}. Ops map onto [JSExport] methods of ChessHeroes.Web.Worker.WorkerApi.
import { dotnet } from './_framework/dotnet.js';

let api = null;

const ready = (async () => {
    const runtime = await dotnet
        .withConfigSrc('blazor.boot.json')
        .create();
    const exports = await runtime.getAssemblyExports('PiecesOfTheDynasties.Web.dll');
    api = exports.ChessHeroes.Web.Worker.WorkerApi;
})();

// Jobs run one at a time, in arrival order: each is a synchronous call into the runtime, and a
// queue keeps a second message from starting while the first is still awaiting the runtime's boot.
let queue = Promise.resolve();

self.onmessage = (e) => {
    const { id, op, payload } = e.data;
    queue = queue.then(async () => {
        try {
            await ready;
            const fn = api[op];
            if (typeof fn !== 'function') throw new Error('unknown worker op ' + op);
            const result = fn(payload);
            self.postMessage({ id, result });
        } catch (err) {
            self.postMessage({ id, error: String(err && err.stack || err) });
        }
    });
};
