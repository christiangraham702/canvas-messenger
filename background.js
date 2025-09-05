// --- CSRF cache schema in storage.local ---
// {
//   csrfHeader: { value: "<X-CSRF-Token>", seenAt: 1690000000000 } | undefined,
//   csrfCookie: { value: "<_csrf_token cookie>", seenAt: 1690000000000 } | undefined
// }

const API_URL_FILTER = { urls: ["https://*.instructure.com/*"] };

// Prefer tokens from request headers (X-CSRF-Token) because that's what Canvas UI actually uses.
// We also track the most recent _csrf_token seen in Set-Cookie response headers as a fallback.

// Capture outgoing request header (works for REST or GraphQL).
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Only care about /api/* calls (REST or graphql) for noise reduction
    if (!/\/api\//.test(details.url)) return;

    let found = null;
    for (const h of details.requestHeaders || []) {
      if (h.name.toLowerCase() === "x-csrf-token" && h.value) {
        found = h.value;
        break;
      }
    }
    if (found) {
      chrome.storage.local.set({
        csrfHeader: { value: found, seenAt: Date.now() },
      });
    }
  },
  API_URL_FILTER,
  ["requestHeaders"],
);

// Capture response Set-Cookie for _csrf_token (rotates frequently).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders || [];
    for (const h of headers) {
      if (
        h.name.toLowerCase() === "set-cookie" && typeof h.value === "string"
      ) {
        // There can be multiple Set-Cookie headers in a single callback; each is handled
        const match = h.value.match(/(?:^|;\s*)_csrf_token=([^;]+)/i);
        if (match && match[1]) {
          try {
            const raw = match[1];
            // Values are often URL-escaped
            const unescaped = decodeURIComponent(raw);
            chrome.storage.local.set({
              csrfCookie: { value: unescaped, seenAt: Date.now() },
            });
          } catch {
            chrome.storage.local.set({
              csrfCookie: { value: match[1], seenAt: Date.now() },
            });
          }
        }
      }
    }
  },
  API_URL_FILTER,
  ["responseHeaders"],
);

// Expose a small API to content/popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_LATEST_CSRF") {
    chrome.storage.local.get(["csrfHeader", "csrfCookie"], (data) => {
      // Prefer header value (what UI actually used), else cookie
      const chosen = (data.csrfHeader && data.csrfHeader.value) ||
        (data.csrfCookie && data.csrfCookie.value) ||
        null;

      sendResponse({
        ok: true,
        csrf: chosen || null,
        sources: {
          header: data.csrfHeader || null,
          cookie: data.csrfCookie || null,
        },
      });
    });
    return true; // async
  }

  if (msg?.type === "CLEAR_CSRF_CACHE") {
    chrome.storage.local.remove(["csrfHeader", "csrfCookie"], () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
