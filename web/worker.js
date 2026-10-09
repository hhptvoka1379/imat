/* The search runs here, off the main thread, so painting stays at 60fps even
 * while 18,000 rows are being re-scored. */
'use strict';
try {
  importScripts('engine.js', 'core.js');
} catch (e) {
  postMessage({ type: 'error', msg: 'engine.js failed to load: ' + e.message });
  throw e;
}
var core = self.IMATCore.create(self.IMATEngine, function (msg) { postMessage(msg); });
self.onmessage = function (ev) { core.handle(ev.data); };
