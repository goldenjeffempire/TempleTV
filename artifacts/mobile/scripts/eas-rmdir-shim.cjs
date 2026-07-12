/**
 * Replit sandbox workaround for EAS CLI 14.x dotslash rmdir restriction.
 *
 * EAS CLI's makeProjectTarballAsync() creates a shallow-clone temp dir, then
 * in a `finally` block calls fs-extra.remove() on it. That dir contains a
 * .cache/dotslash/ subdirectory with a locked binary that Replit's sandbox
 * prevents rmdir from deleting (EACCES).
 *
 * This shim patches fs.rm, fs.rmdir, fs.promises.rm, and fs.promises.rmdir
 * so that EACCES failures on paths containing "dotslash" or "eas-cli-nodejs"
 * are silently swallowed rather than propagated to the caller.
 */
const fs = require('fs');
const path = require('path');

function isEasCliPath(p) {
  if (!p || typeof p !== 'string') return false;
  return p.includes('dotslash') || p.includes('eas-cli-nodejs') || p.includes('shallow-clone');
}

function swallowEacces(original) {
  return function patchedFn(...args) {
    // Last arg may be callback (sync-style wrapped in async)
    const lastArg = args[args.length - 1];
    const targetPath = args[0];
    if (typeof lastArg === 'function' && isEasCliPath(targetPath)) {
      const origCb = lastArg;
      args[args.length - 1] = function (err) {
        if (err && err.code === 'EACCES') return origCb(null);
        return origCb(err);
      };
    }
    return original.apply(this, args);
  };
}

function swallowEaccesPromise(original) {
  return async function patchedPromise(...args) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      if (err && err.code === 'EACCES' && isEasCliPath(args[0])) return;
      throw err;
    }
  };
}

fs.rm = swallowEacces(fs.rm);
fs.rmdir = swallowEacces(fs.rmdir);
fs.promises.rm = swallowEaccesPromise(fs.promises.rm);
fs.promises.rmdir = swallowEaccesPromise(fs.promises.rmdir);
