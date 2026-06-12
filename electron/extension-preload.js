/**
 * Preload for extension popup windows.
 * contextIsolation: false → shares the same world as the page,
 * so we can patch missing chrome.* APIs before the extension scripts run.
 */

function patchChromeAPIs() {
  try {
    if (!window.chrome) window.chrome = {};
    const c = window.chrome;

    // chrome.extension shims
    if (!c.extension) c.extension = {};
    if (!c.extension.isAllowedFileSchemeAccess)
      c.extension.isAllowedFileSchemeAccess = cb => cb && cb(false);
    if (!c.extension.isAllowedIncognitoAccess)
      c.extension.isAllowedIncognitoAccess = cb => cb && cb(false);

    // chrome.management shims (avoid crash when extension checks its own id)
    if (!c.management) c.management = {};
    if (!c.management.getSelf)
      c.management.getSelf = cb => cb && cb(null);
    if (!c.management.get)
      c.management.get = (id, cb) => {
        cb && cb(null);
        if (c.runtime && c.runtime.lastError === undefined)
          c.runtime.lastError = { message: 'Extension not found: ' + id };
        setTimeout(() => { if (c.runtime) delete c.runtime.lastError; }, 0);
      };

    // chrome.identity shims
    if (!c.identity) c.identity = {};
    if (!c.identity.getAuthToken)
      c.identity.getAuthToken = (_, cb) => cb && cb(null);
    if (!c.identity.getProfileUserInfo)
      c.identity.getProfileUserInfo = (_, cb) => cb && cb({ email: '', id: '' });
    if (!c.identity.launchWebAuthFlow)
      c.identity.launchWebAuthFlow = (_, cb) => cb && cb(null);

  } catch (e) {
    console.warn('[extension-preload]', e);
  }
}

// Patch immediately and again after DOM is ready
patchChromeAPIs();
document.addEventListener('DOMContentLoaded', patchChromeAPIs);
