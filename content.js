// -------- utils --------

// get all sections for a course
async function fetchSections(courseId) {
  const url =
    `${location.origin}/api/v1/courses/${courseId}/sections?per_page=100`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`sections ${res.status} — ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.map((s) => ({ id: s.id, name: s.name || `Section ${s.id}` }));
}

async function fetchAllCanvas(url, acc = []) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Canvas API error ${res.status} — ${txt.slice(0, 200)}`);
  }
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

  async function doPost(csrf) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${location.origin}/api/v1/conversations`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
        body: fd,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(
          `POST /conversations ${res.status}: ${txt.slice(0, 500)}`,
        );
        err.status = res.status;
        throw err;
      }
      return res.json();
    } finally {
      clearTimeout(t);
    }
  }

  try {
    return await doPost(csrfToken);
  } catch (e) {
    if (e?.status === 422) {
      // get freshest CSRF from background once
      const fresh = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "GET_LATEST_CSRF" },
          (resp) => resolve(resp?.csrf || null),
        );
      });
      if (fresh && fresh !== csrfToken) return await doPost(fresh);
    }
    throw e;
  }
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
  if (!w) return true; // no filter => everything
  // direct includes in term name or course name
  if (termName.includes(w)) return true;
  if (courseName.includes(w)) return true;
  // handle common alt orders like "2023 spring"
  if (w === "spring 2023") {
    if (
      termName.includes("2023 spring") || courseName.includes("2023 spring")
    ) return true;
    // as a fallback, use dates if present (Jan–Jun 2023)
    const start = course.start_at ? new Date(course.start_at) : null;
    const end = course.end_at ? new Date(course.end_at) : null;
    if (start && start.getFullYear() === 2023 && start.getMonth() <= 5) {
      return true; // Jan(0)–Jun(5)
    }
    if (end && end.getFullYear() === 2023 && end.getMonth() <= 6) return true;
  }
  return false;
}

async function fetchMyCoursesFiltered(termFilter) {
  // include[]=term helps ensure semester info comes back
  const base =
    `${location.origin}/api/v1/courses?enrollment_state=active&per_page=100&include[]=term`;
  const all = await fetchAllCanvas(base);
  const mapped = all.map((c) => ({
    id: c.id,
    name: c.name,
    course_code: c.course_code,
    term: c.term, // sometimes present
    enrollment_term: c.enrollment_term, // sometimes present
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(next, { credentials: "include", signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`GET ${next} -> ${res.status} ${txt.slice(0, 200)}`);
    }
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
  const rows = await canvasGETAll(base);
  // rows are Users; ensure 'id' exists, dedupe
  return Array.from(new Set(rows.map((u) => u.id).filter(Boolean)));
}

// Send 1 chunk (≤100) as **individual messages** (not a group thread)
async function sendConversationChunk(
  { courseId, recipientIds, subject, body, csrfToken },
) {
  const fd = new FormData();
  for (const id of recipientIds) fd.append("recipients[]", String(id));
  if (subject) fd.append("subject", subject);
  fd.append("body", body);
  fd.append("context_code", `course_${courseId}`);
  fd.append("group_conversation", "false"); // send individually
  fd.append("bulk_message", "true"); // create separate private messages

  const res = await fetch(`${location.origin}/api/v1/conversations`, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken }, // from your background CSRF cache
    body: fd,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /conversations ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json(); // Canvas returns an array; when async mode it's empty
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

  // 2) Chunk & send
  const batches = chunk(ids, 100);
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    progressCb?.(
      `Sending chunk ${i + 1}/${batches.length} (${batch.length} recipients)…`,
    );
    await postConversation({
      courseId,
      recipientIds: batch,
      subject,
      body,
      csrfToken,
    });
    results.push({ chunk: i + 1, size: batch.length });
    await new Promise((r) => setTimeout(r, 300)); // small spacing
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

      if (msg.type === "FETCH_COURSES") {
        // kept for backwards compatibility (no filter)
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
            }), // optional live progress to popup
        );
        sendResponse({ ok: true, ...out });
        return;
      }

      if (msg.type === "SEND_LINK_TO_SECTIONS") {
        const { courseId, sectionIds, subject, body, csrfToken } = msg;

        const results = [];
        for (let i = 0; i < sectionIds.length; i++) {
          const sid = sectionIds[i];
          const r = await sendLinkToOneTarget({
            courseId,
            sectionId: sid,
            subject,
            body,
            csrfToken,
          });
          results.push({ sectionId: sid, ...r });
        }
        sendResponse({ ok: true, results });
        return;
      }

      // ... your other handlers ...
    } catch (e) {
      console.error("content.js error", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
