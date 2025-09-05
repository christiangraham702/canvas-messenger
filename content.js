// ------------- utils -------------
function getCourseIdFromPath() {
  const m = location.pathname.match(/\/courses\/(\d+)/);
  if (!m) throw new Error("Open this on a Canvas course page (/courses/<id>).");
  return m[1];
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

// ------------- read-only -------------
async function fetchMyCourses() {
  const base =
    `${location.origin}/api/v1/courses?enrollment_state=active&per_page=100`;
  const all = await fetchAllCanvas(base);
  return all.map((c) => ({
    id: c.id,
    name: c.name,
    course_code: c.course_code,
    term: c.term,
    enrollment_term: c.enrollment_term,
  }));
}

// ------------- recipient search (by name within current course) -------------
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

// ------------- send (FormData + recipients[] + shared context_code) -------------
async function sendOneWithSession({ userId, subject, body, contextCode }) {
  if (!body?.trim()) throw new Error("Message body is required");

  // 1) Get the most recent CSRF from background cache (prefers header token, else cookie token)
  let csrf = await getLatestCsrfFromBackground();
  if (!csrf) {
    throw new Error(
      "CSRF not captured yet. Send one message in Canvas Inbox UI, or navigate around to let the token get captured.",
    );
  }

  // Build form body
  const fd = new FormData();
  fd.append("recipients[]", String(userId)); // IMPORTANT: recipients[]
  if (subject) fd.append("subject", subject);
  fd.append("body", body);
  fd.append("group_conversation", "false");
  fd.append("bulk_message", "false");
  if (contextCode) fd.append("context_code", contextCode);

  const url = `${location.origin}/api/v1/conversations`;

  // 2) Try once with the cached token
  let res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: fd,
  });

  // 3) If it rotated and we got a 422, re-fetch latest token and retry once
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

// ------------- message router -------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "FETCH_COURSES") {
        if (!/^https:\/\/.*\.instructure\.com$/.test(location.origin)) {
          sendResponse({ ok: false, error: "Not on a Canvas origin." });
          return;
        }
        const courses = await fetchMyCourses();
        sendResponse({ ok: true, courses });
        return;
      }

      if (msg.type === "SEND_ONE_VIA_CANVAS") {
        if (!/^https:\/\/.*\.instructure\.com$/.test(location.origin)) {
          sendResponse({ ok: false, error: "Not on a Canvas origin." });
          return;
        }

        const currentCourseId = getCourseIdFromPath();
        const { recipientTerm, subject, body } = msg;

        // 1) Find recipient by name within this course
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

        // 2) Compute a valid shared context_code
        const shared = Object.keys(chosen.common_courses || {}); // e.g., ["500008"]
        const contextCode = shared.length
          ? `course_${
            shared.includes(String(currentCourseId))
              ? currentCourseId
              : shared[0]
          }`
          : null;

        // 3) Send the message
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

  return true; // keep the channel open for async work above
});
