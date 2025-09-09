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

// Normalize term labels for fuzzy matching
function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/spring\s*'?([0-9]{2})\b/g, "spring 20$1") // spring '23 => spring 2023
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// to make sure correct semester
function isTermMatch(course, wantedLabel) {
  const w = norm(wantedLabel);
  const termName = norm(
    course?.enrollment_term?.name || course?.term?.name || "",
  );
  const courseName = norm(course?.name || "");
  if (!w) return true;
  if (termName.includes(w)) return true;
  if (courseName.includes(w)) return true;
  if (w === "spring 2023") {
    const start = course.start_at ? new Date(course.start_at) : null;
    const end = course.end_at ? new Date(course.end_at) : null;
    if (start && start.getFullYear() === 2023 && start.getMonth() <= 5) {
      return true;
    }
    if (end && end.getFullYear() === 2023 && end.getMonth() <= 6) return true;
  }
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

// Main: send to ALL students in a course (chunked ≤100)
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
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    progressCb?.(
      `Sending chunk ${i + 1}/${batches.length} (${batch.length} recipients)…`,
    );

    // Try up to 3 attempts per chunk (postConversation already has CSRF refresh + inner retries)
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

    results.push({ chunk: i + 1, size: batch.length });
    await sleep(300); // small spacing
  }
  return { totalRecipients: ids.length, chunks: batches.length, results };
}

// -------- router --------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!/^https:\/\/.*\.instructure\.com$/.test(location.origin)) {
        sendResponse({ ok: false, error: "Not on a Canvas origin." });
        return;
      }

      if (msg.type === "FETCH_COURSES_FILTERED") {
        const courses = await fetchMyCoursesFiltered(
          msg.termFilter || "Spring 2023",
        );
        sendResponse({ ok: true, courses });
        return;
      }
      if (msg?.type === "PING") {
        sendResponse({ ok: true });
        return; // no async work
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
