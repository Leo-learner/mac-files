// Structured logger — wraps console with timestamp, level, and optional request context

function formatTime() {
  return new Date().toISOString();
}

function formatPrefix(level, reqId, method, path) {
  let prefix = `[${formatTime()}] [${level}]`;
  if (reqId) prefix += ` [req=${reqId}]`;
  if (method && path) prefix += ` [${method} ${path}]`;
  return prefix;
}

function createRootLogger() {
  return {
    info(...args) { console.log(formatPrefix('INFO', '', '', ''), ...args); },
    warn(...args) { console.warn(formatPrefix('WARN', '', '', ''), ...args); },
    error(...args) { console.error(formatPrefix('ERROR', '', '', ''), ...args); },
  };
}

function createLogger(req) {
  const reqId = req.id || '';
  const method = req.method || '';
  const path = req.originalUrl || req.url || '';
  return {
    info(...args) { console.log(formatPrefix('INFO', reqId, method, path), ...args); },
    warn(...args) { console.warn(formatPrefix('WARN', reqId, method, path), ...args); },
    error(...args) { console.error(formatPrefix('ERROR', reqId, method, path), ...args); },
  };
}

module.exports = { createLogger, createRootLogger };
