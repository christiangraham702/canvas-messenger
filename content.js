// -------- utils --------
function getCourseIdFromPath() {
  const m = location.pathname.match(/\/courses\/(\d+)/);
  if (!m) throw new Error("Open this on a Canvas course page (/courses/<id>).");
  return m[1];
}

// Add this helper
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

async function getLatestCsrfFromBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LATEST_CSRF" }, (resp) => {
      resolve(resp?.csrf || null);
    });
  });
}

// Normalize term labels for fuzzy matching
function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/spring\s*'?([0-9]{2})\b/g, "spring 20$1") // spring '23 => spring 2023
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
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

// -------- read-only (now with term filter) --------
async function fetchMyCoursesFiltered(termFilter) {
  // include[]=term helps ensure term info comes back
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
// For searching and seding to one person (testing)
// -------- recipient search (by name within current course) --------
async function searchOneRecipient(courseId, fullName) {
  const url = new URL(`${location.origin}/api/v1/search/recipients`);
  url.searchParams.set("search", fullName.trim());
  url.searchParams.set("context", `course_${courseId}`);
  url.searchParams.append("types[]", "user");
  url.searchParams.set("per_page", "20");

  const res = await fetch(url.toString(), { credentials: "include" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`search/recipients ${res.status}: ${txt.slice(0, 300)}`);
  }
  const raw = await res.json();

  const users = raw
    .map((r) => ({
      id: Number.isInteger(r?.id)
        ? r.id
        : (Number.isInteger(r?.user_id) ? r.user_id : null),
      name: r?.full_name || r?.name || "",
      common_courses: r?.common_courses || {},
    }))
    .filter((u) => Number.isInteger(u.id) && u.name);

  if (users.length === 0) return { chosen: null, candidates: [] };
  if (users.length === 1) return { chosen: users[0], candidates: users };

  const t = fullName.trim().toLowerCase();
  const exactByName = users.filter((u) => u.name.toLowerCase() === t);
  if (exactByName.length === 1) {
    return { chosen: exactByName[0], candidates: users };
  }

  return { chosen: null, candidates: users.slice(0, 10) };
}

// -------- send (FormData + recipients[] + shared context_code; uses sniffed CSRF) --------
async function sendOneWithSession({ userId, subject, body, contextCode }) {
  if (!body?.trim()) throw new Error("Message body is required");

  let csrf = await getLatestCsrfFromBackground();
  if (!csrf) {
    throw new Error(
      "CSRF not captured yet. Send one message in Canvas Inbox UI, or navigate around to let the token get captured.",
    );
  }

  const fd = new FormData();
  fd.append("recipients[]", String(userId));
  if (subject) fd.append("subject", subject);
  fd.append("body", body);
  fd.append("group_conversation", "false");
  fd.append("bulk_message", "false");
  if (contextCode) fd.append("context_code", contextCode);

  const url = `${location.origin}/api/v1/conversations`;

  let res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Accept": "application/json", "X-CSRF-Token": csrf },
    body: fd,
  });

  if (res.status === 422) {
    const fresh = await getLatestCsrfFromBackground();
    if (fresh && fresh !== csrf) {
      csrf = fresh;
      res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Accept": "application/json", "X-CSRF-Token": csrf },
        body: fd,
      });
    }
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /conversations ${res.status} — ${txt.slice(0, 800)}`);
  }
  return true;
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

      if (msg.type === "SEND_ONE_VIA_CANVAS") {
        const currentCourseId = getCourseIdFromPath();
        const { recipientTerm, subject, body } = msg;

        const { chosen, candidates } = await searchOneRecipient(
          currentCourseId,
          recipientTerm,
        );
        if (!chosen) {
          sendResponse({
            ok: false,
            error: candidates?.length
              ? "Ambiguous name; refine it."
              : "No matching user found.",
            candidates: candidates || [],
          });
          return;
        }

        const shared = Object.keys(chosen.common_courses || {}); // e.g., ["500008"]
        const contextCode = shared.length
          ? `course_${
            shared.includes(String(currentCourseId))
              ? currentCourseId
              : shared[0]
          }`
          : null;

        await sendOneWithSession({
          userId: chosen.id,
          subject,
          body,
          contextCode,
        });
        sendResponse({ ok: true, userId: chosen.id });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
