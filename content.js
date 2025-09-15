// ========= content.js =========

// -------- Retry / keep-alive helpers --------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetry(err) {
  const s = err?.status;
  if (err?.name === "AbortError") return true; // timeout -> retry
  if (s == null) return true; // network error
  if ([429, 500, 502, 503, 504].includes(s)) return true; // rate/5xx
  return false;
}

async function withRetries(
  fn,
  { retries = 2, baseDelay = 800, factor = 2, jitter = 0.25 } = {},
) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (!shouldRetry(e) || attempt === retries) break;
      attempt++;
      const delay = Math.round(
        baseDelay * Math.pow(factor, attempt - 1) *
          (1 + (Math.random() * 2 - 1) * jitter),
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function fetchWithRetry(
  url,
  { timeoutMs = 45000, retries = 2, ...options } = {},
) {
  return withRetries(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(
          `HTTP ${res.status} ${url} — ${txt.slice(0, 200)}`,
        );
        err.status = res.status;
        throw err;
      }
      return res;
    } finally {
      clearTimeout(t);
    }
  }, { retries });
}

// Keep both the page and the extension service worker awake during long runs
let _keepAliveTimer = null;
function startKeepAlive() {
  if (_keepAliveTimer) return;
  _keepAliveTimer = setInterval(async () => {
    try {
      chrome.runtime.sendMessage({ type: "PING" }, () => {});
    } catch {}
    try {
      // cheap HEAD to a tiny endpoint; adjust if your school blocks HEAD
      await fetch(`${location.origin}/api/v1/users/self`, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
      });
    } catch {}
  }, 20000);
}
startKeepAlive();

// -------- utils --------

async function fetchCurrentUserProfile() {
  const url = `${location.origin}/api/v1/users/self/profile`;
  const res = await fetchWithRetry(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to fetch self profile: ${res.status}`);
  }
  return res.json();
}

function isCanvasOrigin() {
  const { host, protocol } = location;
  if (protocol !== "https:") return false;
  if (host.endsWith(".instructure.com")) return true;
  if (/^(canvas|learn|webcourses|bruinlearn)\./i.test(host)) return true;
  return false;
}

// get all sections for a course
async function fetchSections(courseId) {
  const url =
    `${location.origin}/api/v1/courses/${courseId}/sections?per_page=100`;
  const res = await fetchWithRetry(url, { credentials: "include" });
  const data = await res.json();
  return data.map((s) => ({ id: s.id, name: s.name || `Section ${s.id}` }));
}

async function fetchAllCanvas(url, acc = []) {
  const res = await fetchWithRetry(url, { credentials: "include" });
  const data = await res.json();
  acc.push(...data);
  const link = res.headers.get("Link") || "";
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  return next ? fetchAllCanvas(next[1], acc) : acc;
}

// Ask background for freshest CSRF
async function getLatestCsrfFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LATEST_CSRF" }, (resp) => {
      resolve(resp?.csrf || null);
    });
  });
}

async function postConversation(
  { courseId, recipientIds, subject, body, csrfToken },
  timeoutMs = 45000,
) {
  const fd = new FormData();
  recipientIds.forEach((id) => fd.append("recipients[]", String(id)));
  if (subject) fd.append("subject", subject);
  fd.append("body", body);
  fd.append("context_code", `course_${courseId}`);
  fd.append("group_conversation", "false"); // send individually
  fd.append("bulk_message", "true"); // separate DMs per recipient

  const doPost = async (csrf) => {
    const res = await fetchWithRetry(
      `${location.origin}/api/v1/conversations`,
      {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
        body: fd,
        timeoutMs,
        retries: 0, // we handle logic below so we can swap CSRF if needed
      },
    );
    return res.json();
  };

  // Try with the provided token, then refresh CSRF once if 422, plus 2 general retries for 429/5xx/timeouts.
  let attempt = 0;
  let lastErr;

  while (attempt < 3) {
    try {
      if (attempt === 0) return await doPost(csrfToken);
      if (attempt === 1) {
        // 2nd attempt: try with latest CSRF
        const fresh = await getLatestCsrfFromBackground();
        return await doPost(fresh || csrfToken);
      }
      // 3rd attempt: backoff + try again with whatever latest token we have
      const fresh = await getLatestCsrfFromBackground();
      return await doPost(fresh || csrfToken);
    } catch (e) {
      lastErr = e;
      if (!shouldRetry(e) && e?.status !== 422) break;
      await sleep(600 * Math.pow(2, attempt)); // 600ms, 1200ms
      attempt++;
    }
  }
  throw lastErr;
}

// Map many season variants to a canonical token
function normalizeSeasonToken(s) {
  if (!s) return null;
  s = s.toLowerCase();
  // common aliases/abbreviations
  if (/(fall|fa|autumn)/.test(s)) return "fall";
  if (/(spring|sp)/.test(s)) return "spring";
  if (/(winter|wi)/.test(s)) return "winter";
  if (/(summer|su|sm)/.test(s)) return "summer";
  // some schools use A/B/C for summer, but we still treat as "summer"
  return null;
}

// Extract { season, year } from a free-form label like:
// "Fall 2025", "2025 Fall 1", "Term: 2025FA", "FA 2025", "2025SU B"
function parseSeasonYear(label) {
  if (!label) return { season: null, year: null };

  const raw = String(label).trim().toLowerCase();

  // Try compact codes like "2025fa" / "fa2025"
  let m = raw.match(/\b(20\d{2}|19\d{2})(?:\s*[-_ ]?)?(fa|sp|su|sm|wi)\b/);
  if (m) {
    const year = parseInt(m[1], 10);
    const season = normalizeSeasonToken(m[2]);
    if (season && year) return { season, year };
  }
  m = raw.match(/\b(fa|sp|su|sm|wi)(?:\s*[-_ ]?)?(20\d{2}|19\d{2})\b/);
  if (m) {
    const season = normalizeSeasonToken(m[1]);
    const year = parseInt(m[2], 10);
    if (season && year) return { season, year };
  }

  // Generic “word + year” in any order, e.g. "2025 fall 1", "fall 2025 main"
  // Capture first season word we recognize and a 4-digit year
  const seasonMatch = raw.match(
    /\b(fall|autumn|spring|winter|summer|fa|sp|su|sm|wi)\b/,
  );
  const yearMatch = raw.match(/\b(20\d{2}|19\d{2})\b/);

  const season = normalizeSeasonToken(seasonMatch && seasonMatch[1]);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  return { season: season || null, year: year || null };
}

// Decide if a course belongs to the requested term.
// - wantedLabel is what you pass from popup (e.g., "Fall 2025")
// - We check the course's term label if present; fall back to course name/date windows.
function isTermMatch(course, wantedLabel) {
  // Parse the desired season/year
  const want = parseSeasonYear(wantedLabel);
  if (!want.season || !want.year) {
    // If the filter couldn't be parsed, treat as "no filter"
    return true;
  }

  // Try enrollment term name first (or course name as a backup)
  const termStr = course?.enrollment_term?.name || course?.term?.name ||
    course?.name || "";
  const have = parseSeasonYear(termStr);

  // If both parsed cleanly, require exact season + year match
  if (have.season && have.year) {
    return (have.season === want.season) && (have.year === want.year);
  }

  // Fallback heuristic: use dates if available (windows by season)
  // This helps when schools hide season in names but have start/end times.
  const start = course.start_at ? new Date(course.start_at) : null;
  const end = course.end_at ? new Date(course.end_at) : null;
  if (start) {
    const y = start.getFullYear();
    if (y === want.year) {
      const m = start.getMonth(); // 0=Jan
      switch (want.season) {
        case "spring":
          return m >= 0 && m <= 5; // Jan–Jun
        case "summer":
          return m >= 4 && m <= 8; // May–Sep (covers A/B/C)
        case "fall":
          return m >= 7 && m <= 11; // Aug–Dec; FSU's "Fall 1/2" start ~Aug
        case "winter":
          return m === 11 || m <= 1; // Dec–Feb
      }
    }
  }
  if (end) {
    const y = end.getFullYear();
    if (y === want.year) {
      const m = end.getMonth();
      switch (want.season) {
        case "spring":
          return m >= 0 && m <= 6; // end by July
        case "summer":
          return m >= 4 && m <= 9; // end by Oct
        case "fall":
          return m >= 8 && m <= 11; // end Sept–Dec
        case "winter":
          return m === 11 || m <= 1; // Dec–Feb
      }
    }
  }

  // If we can't prove it's the requested term, exclude it.
  return false;
}

async function fetchMyCoursesFiltered(termFilter) {
  const base =
    `${location.origin}/api/v1/courses?enrollment_state=active&per_page=100&include[]=term`;
  const all = await fetchAllCanvas(base);
  const mapped = all.map((c) => ({
    id: c.id,
    name: c.name,
    course_code: c.course_code,
    term: c.term,
    enrollment_term: c.enrollment_term,
    start_at: c.start_at,
    end_at: c.end_at,
  }));
  return mapped.filter((c) => isTermMatch(c, termFilter));
}

// ======== Send link to everyone ==========

// Small paginator for Canvas REST (follows Link headers)
async function canvasGETAll(url, timeoutMs = 30000) {
  const out = [];
  let next = url;

  while (next) {
    const res = await fetchWithRetry(next, {
      credentials: "include",
      timeoutMs,
    });
    const page = await res.json();
    out.push(...page);

    const link = res.headers.get("Link") || res.headers.get("link");
    const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

// Course users (students, active only) -> unique user IDs
async function fetchStudentUserIdsForCourse(courseId) {
  const base = `${location.origin}/api/v1/courses/${courseId}/users` +
    `?enrollment_type[]=student&enrollment_state[]=active&per_page=100`;

  // Extra robustness: wrap the whole pagination in retries
  return withRetries(async () => {
    const rows = await canvasGETAll(base);
    return Array.from(new Set(rows.map((u) => u.id).filter(Boolean)));
  }, { retries: 2, baseDelay: 800 });
}

// Send 1 chunk (≤100) as **individual messages** (not a group thread)
async function sendConversationChunk(
  { courseId, recipientIds, subject, body, csrfToken },
) {
  return postConversation({ courseId, recipientIds, subject, body, csrfToken });
}

// Chunk an array into arrays of size n
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function sendLinkToCourseStudents(
  { courseId, subject, body, csrfToken },
  progressCb,
) {
  // 1) Resolve recipients
  progressCb?.(`Fetching course students…`);
  const ids = await fetchStudentUserIdsForCourse(courseId);

  if (!ids.length) return { totalRecipients: 0, chunks: 0, results: [] };

  // 2) Chunk & send with retries per chunk
  const batches = chunk(ids, 100);
  const results = [];

  // 🔔 Tell popup our plan for this course
  try {
    chrome.runtime.sendMessage({
      type: "SEND_PLAN",
      courseId,
      totalRecipients: ids.length,
      totalChunks: batches.length,
    });
  } catch {}

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const human = `${i + 1}/${batches.length}`;
    progressCb?.(`Sending chunk ${human} (${batch.length} recipients)…`);

    // Try up to 3 attempts per chunk (CSRF refresh built into postConversation)
    await withRetries(
      () =>
        sendConversationChunk({
          courseId,
          recipientIds: batch,
          subject,
          body,
          csrfToken,
        }),
      { retries: 2, baseDelay: 800 },
    );

    // 🔔 Tell popup a chunk finished
    try {
      chrome.runtime.sendMessage({
        type: "SEND_CHUNK_DONE",
        courseId,
        chunk: i + 1,
        totalChunks: batches.length,
      });
    } catch {}

    results.push({ chunk: i + 1, size: batch.length });
    await sleep(300); // small spacing
  }

  return { totalRecipients: ids.length, chunks: batches.length, results };
}

// -------- router --------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!isCanvasOrigin()) {
        sendResponse({ ok: false, error: "Not on a Canvas origin." });
        return;
      }

      if (msg.type === "FETCH_COURSES_FILTERED") {
        const courses = await fetchMyCoursesFiltered(
          msg.termFilter || "Fall 2025",
        );
        sendResponse({ ok: true, courses });
        return;
      }
      if (msg?.type === "PING") {
        sendResponse({ ok: true });
        return; // no async work
      }
      if (msg.type === "FETCH_SELF") {
        const profile = await fetchCurrentUserProfile();
        sendResponse(profile);
        return;
      }

      if (msg.type === "FETCH_COURSES") {
        const courses = await fetchMyCoursesFiltered("");
        sendResponse({ ok: true, courses });
        return;
      }

      if (msg.type === "FETCH_SECTIONS") {
        const sections = await fetchSections(msg.courseId);
        sendResponse({ ok: true, sections });
        return;
      }

      if (msg.type === "SEND_LINK_TO_COURSE") {
        const { courseId, subject, body, csrfToken } = msg;
        const out = await sendLinkToCourseStudents(
          { courseId, subject, body, csrfToken },
          (note) =>
            chrome.runtime.sendMessage({
              type: "SEND_PROGRESS",
              courseId,
              note,
            }),
        );
        sendResponse({ ok: true, ...out });
        return;
      }

      if (msg.type === "SEND_LINK_TO_SECTIONS") {
        const { courseId, sectionIds, subject, body, csrfToken } = msg;
        const results = [];
        for (let i = 0; i < sectionIds.length; i++) {
          const sid = sectionIds[i];
          // (If you still use per-section sends; not used in the current flow)
          const one = await sendLinkToCourseStudents(
            { courseId, subject, body, csrfToken },
            (note) =>
              chrome.runtime.sendMessage({
                type: "SEND_PROGRESS",
                courseId,
                sectionId: sid,
                note,
              }),
          );
          results.push({ sectionId: sid, ...one });
        }
        sendResponse({ ok: true, results });
        return;
      }
    } catch (e) {
      console.error("content.js error", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
