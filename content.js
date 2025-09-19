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
      await fetch(`${location.origin}/api/v1/users/self`, {
        method: "HEAD",
        credentials: "include",
        cache: "no-store",
      });
    } catch {}
  }, 20000);
}
startKeepAlive();

// -------- misc utils / constants --------
const MAX_PER_REQUEST = 90; // keep well under Canvas ~100 cap

function uniqueInts(arr) {
  return Array.from(new Set(arr.map(Number).filter(Number.isFinite)));
}

async function fetchCurrentUserProfile() {
  const url = `${location.origin}/api/v1/users/self/profile`;
  const res = await fetchWithRetry(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch self profile: ${res.status}`);
  return res.json();
}

function isCanvasOrigin() {
  const { host, protocol } = location;
  if (protocol !== "https:") return false;
  if (host.endsWith(".instructure.com")) return true;
  if (/^(canvas|learn|webcourses|bruinlearn)\./i.test(host)) return true;
  // (Add other branded prefixes here if needed)
  return false;
}

// -------- term parsing (robust: "2025 Fall 1", "FA2025", etc.) --------
function normalizeSeasonToken(s) {
  if (!s) return null;
  s = s.toLowerCase();
  if (/(fall|fa|autumn)/.test(s)) return "fall";
  if (/(spring|sp)/.test(s)) return "spring";
  if (/(winter|wi)/.test(s)) return "winter";
  if (/(summer|su|sm)/.test(s)) return "summer";
  return null;
}

function parseSeasonYear(label) {
  if (!label) return { season: null, year: null };
  const raw = String(label).trim().toLowerCase();

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

  const seasonMatch = raw.match(
    /\b(fall|autumn|spring|winter|summer|fa|sp|su|sm|wi)\b/,
  );
  const yearMatch = raw.match(/\b(20\d{2}|19\d{2})\b/);
  const season = normalizeSeasonToken(seasonMatch && seasonMatch[1]);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  return { season: season || null, year: year || null };
}

function isTermMatch(course, wantedLabel) {
  const want = parseSeasonYear(wantedLabel);
  if (!want.season || !want.year) return true;

  const termStr = course?.enrollment_term?.name || course?.term?.name ||
    course?.name || "";
  const have = parseSeasonYear(termStr);

  if (have.season && have.year) {
    return have.season === want.season && have.year === want.year;
  }

  // Fallback by dates if present
  const start = course.start_at ? new Date(course.start_at) : null;
  const end = course.end_at ? new Date(course.end_at) : null;
  if (start && start.getFullYear() === want.year) {
    const m = start.getMonth();
    if (want.season === "spring") return m >= 0 && m <= 5;
    if (want.season === "summer") return m >= 4 && m <= 8;
    if (want.season === "fall") return m >= 7 && m <= 11;
    if (want.season === "winter") return m === 11 || m <= 1;
  }
  if (end && end.getFullYear() === want.year) {
    const m = end.getMonth();
    if (want.season === "spring") return m >= 0 && m <= 6;
    if (want.season === "summer") return m >= 4 && m <= 9;
    if (want.season === "fall") return m >= 8 && m <= 11;
    if (want.season === "winter") return m === 11 || m <= 1;
  }
  return false;
}

// -------- sections / courses --------
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

// ======== messaging helpers ==========

// Ask background for freshest CSRF
async function getLatestCsrfFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LATEST_CSRF" }, (resp) => {
      resolve(resp?.csrf || null);
    });
  });
}

// Course users (students, active only) -> unique user IDs (exclude self + test student)
async function fetchStudentUserIdsForCourse(courseId) {
  const base = `${location.origin}/api/v1/courses/${courseId}/users` +
    `?enrollment_type[]=student&enrollment_state[]=active&per_page=100`;

  const me = await fetchCurrentUserProfile().catch(() => null);
  const myId = me?.id ? Number(me.id) : null;

  const rows = await withRetries(async () => {
    return await canvasGETAll(base);
  }, { retries: 2, baseDelay: 800 });

  const ids = rows
    .filter((u) => {
      const uid = Number(u.id);
      if (!Number.isFinite(uid)) return false;
      if (myId != null && uid === myId) return false;
      if (u.sis_user_id === "test_student") return false;
      if (typeof u.name === "string" && /test student/i.test(u.name)) {
        return false;
      }
      return true;
    })
    .map((u) => Number(u.id));

  return uniqueInts(ids);
}

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

// POST /conversations with hard guard for max recipients
async function postConversation(
  { courseId, recipientIds, subject, body, csrfToken },
  timeoutMs = 45000,
) {
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
    throw new Error("No recipients in chunk.");
  }
  if (recipientIds.length > MAX_PER_REQUEST) {
    throw new Error(
      `Refusing to POST >${MAX_PER_REQUEST} recipients in one request.`,
    );
  }

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
        retries: 0, // we handle logic below
      },
    );
    return res.json();
  };

  // Try with given token, then refresh CSRF, then back off and try again
  let attempt = 0, lastErr;
  while (attempt < 3) {
    try {
      if (attempt === 0) return await doPost(csrfToken);
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

// Send 1 chunk (≤ MAX_PER_REQUEST) as individual messages
async function sendConversationChunk(
  { courseId, recipientIds, subject, body, csrfToken },
) {
  if (recipientIds.length > MAX_PER_REQUEST) {
    console.warn("Chunk too large, trimming:", recipientIds.length);
    recipientIds = recipientIds.slice(0, MAX_PER_REQUEST);
  }
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
  let ids = await fetchStudentUserIdsForCourse(courseId);
  ids = uniqueInts(ids);

  if (!ids.length) return { totalRecipients: 0, chunks: 0, results: [] };

  // 2) Chunk & send with retries per chunk
  const batches = chunk(ids, MAX_PER_REQUEST);
  const results = [];

  // Notify popup of our plan
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

    // Notify popup chunk finished
    try {
      chrome.runtime.sendMessage({
        type: "SEND_CHUNK_DONE",
        courseId,
        chunk: i + 1,
        totalChunks: batches.length,
      });
    } catch {}

    results.push({ chunk: i + 1, size: batch.length });
    await sleep(300); // spacing
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

      if (msg?.type === "PING") {
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "FETCH_SELF") {
        const profile = await fetchCurrentUserProfile();
        sendResponse(profile);
        return;
      }

      if (msg.type === "FETCH_COURSES_FILTERED") {
        const courses = await fetchMyCoursesFiltered(
          msg.termFilter || "Fall 2025",
        );
        sendResponse({ ok: true, courses });
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
