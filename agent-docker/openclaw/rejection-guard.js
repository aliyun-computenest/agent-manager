// rejection-guard.js — Prevents ArmsTrace plugin async errors from crashing the gateway.
// Registered via NODE_OPTIONS=--require so it loads before any plugin code.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  console.error(`[ArmsTrace][WARN] Swallowed unhandled rejection: ${msg}`);
});
