// popup.js (module)
import { claimCourse, getCourseSends, markSent, releaseClaim } from "./db.js";

// --- Message templates (exactly your 14 lines) ---
const TEMPLATES = [
  "Hey, I’m sharing the group chat link to the whole class—here it is:",
  "Hi all, Here’s the group chat for our class:",
  "Hey everyone, Just sharing the group chat link. Join here:",
  "Hi guys, This is the group chat link for our class:",
  "Hey all, Here’s the link to our class group chat:",
  "Hey, Just passing along the group chat link to the class:",
  "Hey everyone, Here’s the group chat for our class:",
  "Hey everyone, This is the link to the class group chat:",
  "Hi all, Sharing the group chat link for our class:",
  "Hey, Here’s the chat link for our class:",
  "Hey, I’m sharing the group chat link with everyone:",
  "Hi everyone, Here’s the chat link for the class:",
  "Hey all, This is the class group chat link:",
  "Hi guys, I found the class chat, here is the link:",
];

const selectedCourseIds = new Set();

const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const sendSelectedBtn = document.getElementById("sendSelectedBtn");
const doNotCloseEl = document.getElementById("doNotClose");

function setProgress(current, total) {
  const pct = total ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = pct + "%";
  progressLabel.textContent = `${pct}% (${current}/${total})`;
}

function showProgress(show) {
  progressWrap.style.display = show ? "block" : "none";
  doNotCloseEl.style.display = show ? "block" : "none";
  if (!show) setProgress(0, 0);
}

// Populate the <select> on load
const templateSelectEl = document.getElementById("templateSelect");
document.addEventListener("DOMContentLoaded", () => {
  if (templateSelectEl && !templateSelectEl.options.length) {
    TEMPLATES.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = t;
      templateSelectEl.appendChild(opt);
    });
    templateSelectEl.selectedIndex = 0; // default first
  }
});

function normalizeCourseCode(code) {
  return (code || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function toTermKey(label) {
  return (label || "")
    .trim().toLowerCase()
    .replace(/spring\s*'?([0-9]{2})\b/g, "spring 20$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getTermLabel(c) {
  return c?.enrollment_term?.name || c?.term?.name || "";
}

// Ask content.js for sections of a course
async function loadSectionsFromContent(tabId, courseId) {
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "FETCH_SECTIONS",
    courseId,
  });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to fetch sections");
  return resp.sections || [];
}

// For one course, compute how many sections remain unsent this term
async function computeCourseAvailability(tab, course) {
  const canvasHost = new URL(tab.url).host;
  const termLabel = getTermLabel(course) || "Spring 2023";
  const termKey = toTermKey(termLabel);

  // 1) Get sections from Canvas
  const sections = await loadSectionsFromContent(tab.id, course.id);

  // 2) Read all sends for this course+term from Supabase
  const rows = await getCourseSends({
    canvasDomain: canvasHost,
    courseId: course.id,
    termKey,
  });

  // 3) Build a set of claimed section ids (normed; note: our DB stores 0 when NULL)
  const claimed = new Set(
    rows.map((r) => (r.section_id === null ? 0 : Number(r.section_id))),
  );

  // 4) Count remaining
  const allSectionIds = sections.length
    ? sections.map((s) => Number(s.id))
    : [0]; // if no sections returned, treat as single 0 "course-wide" unit
  const remainingSections = allSectionIds.filter((secId) =>
    !claimed.has(secId)
  );

  return {
    courseId: course.id,
    courseName: course.name || "",
    courseCode: course.course_code || "",
    termLabel,
    termKey,
    totalSections: allSectionIds.length,
    availableSections: remainingSections.length,
  };
}

async function refreshCsrfStatus() {
  const box = document.getElementById("csrfStatus");
  const resp = await chrome.runtime.sendMessage({ type: "GET_LATEST_CSRF" });
  if (!resp?.ok) {
    box.textContent = "Unable to read CSRF cache.";
    return;
  }
  const h = resp.sources.header, c = resp.sources.cookie;
  const lines = [];
  lines.push(
    `Header token: ${h?.value ? "present" : "—"} ${
      h?.seenAt ? `(seen ${fmtTime(h.seenAt)})` : ""
    }`,
  );
  lines.push(
    `Cookie token: ${c?.value ? "present" : "—"} ${
      c?.seenAt ? `(seen ${fmtTime(c.seenAt)})` : ""
    }`,
  );
  lines.push(`\nChosen for sends: ${resp.csrf ? "present" : "—"}`);
  box.textContent = lines.join("\n");
}
document.getElementById("refreshCsrf")?.addEventListener(
  "click",
  refreshCsrfStatus,
);
document.getElementById("clearCsrf")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_CSRF_CACHE" });
  await refreshCsrfStatus();
  alert("Cleared cached CSRF tokens.");
});
document.addEventListener("DOMContentLoaded", refreshCsrfStatus);

const introSection = document.getElementById("introSection");
const coursesSection = document.getElementById("coursesSection");
const introFindBtn = document.getElementById("introFindBtn");
const termFilterEl = document.getElementById("termFilter");
const fetchBtn = document.getElementById("fetchBtn");

// Default the term
document.addEventListener("DOMContentLoaded", () => {
  if (termFilterEl && !termFilterEl.value) termFilterEl.value = "Ongoing Term";
});

function renderCourses(courses) {
  const results = document.getElementById("results");
  results.innerHTML = "";
  if (!courses?.length) {
    results.innerHTML = "<p><em>No courses matched this term.</em></p>";
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "courses-list";

  courses.forEach((c) => {
    const term = getTermLabel(c) || "—";
    const li = document.createElement("li");
    li.className = "course-li";

    li.innerHTML = `
      <div class="course-card" data-courseid="${c.id}">
        <div class="course-main">
          <div class="course-title" title="${c.name || "(unnamed course)"}">
            ${c.name || "(unnamed course)"}
          </div>
          <div class="course-sub">
            ${c.course_code || "—"} · Term: ${term}
          </div>
          <div id="avail-${c.id}" class="course-status">Checking availability…</div>
        </div>
        <div style="text-align:right;">
          <input
            type="checkbox"
            class="course-check"
            id="ck-${c.id}"
            data-courseid="${c.id}"
            disabled
          />
        </div>
      </div>
    `;

    ul.appendChild(li);
  });

  results.appendChild(ul);

  // Make the whole card toggle the checkbox (except clicking directly on inputs/buttons)
  results.querySelectorAll(".course-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("input,button,a,select,textarea")) return;
      const id = Number(card.dataset.courseid);
      const ck = document.getElementById(`ck-${id}`);
      if (!ck || ck.disabled) return;
      ck.checked = !ck.checked;
      if (ck.checked) selectedCourseIds.add(id);
      else selectedCourseIds.delete(id);
    });
  });

  // Track checkbox selection changes
  results.querySelectorAll(".course-check").forEach((ck) => {
    ck.addEventListener("change", () => {
      const id = Number(ck.dataset.courseid);
      if (ck.checked) selectedCourseIds.add(id);
      else selectedCourseIds.delete(id);
    });
  });
}

introFindBtn?.addEventListener("click", () => {
  introSection.classList.add("hidden");
  coursesSection.classList.remove("hidden");
  fetchAndRenderCoursesForTerm("Fall 2025");
});

// ========= send to everyone =============
async function collectRemainingSectionIds(tab, course) {
  const resp = await chrome.tabs.sendMessage(tab.id, {
    type: "FETCH_SECTIONS",
    courseId: course.id,
  });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to fetch sections");
  const sections = resp.sections || [];
  const sectionIds = sections.length ? sections.map((s) => Number(s.id)) : [0];

  const canvasHost = new URL(tab.url).host;
  const termLabel = getTermLabel(course);
  const termKey = toTermKey(termLabel);
  const rows = await getCourseSends({
    canvasDomain: canvasHost,
    courseId: course.id,
    termKey,
  });
  const claimed = new Set(
    rows.map((r) => r.section_id === null ? 0 : Number(r.section_id)),
  );

  return {
    sectionIds: sectionIds.filter((id) => !claimed.has(id)),
    canvasHost,
    termKey,
    termLabel,
  };
}

async function handleSendLinkForCourse(course, statusEl) {
  const tab =
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const host = new URL(tab.url).host;
  const termLabel = getTermLabel(course);
  const termKey = toTermKey(termLabel);
  const linkUrl = `https://app.courselynx.com/join/${host.split(".")[0]}/${
    normalizeCourseCode(course.course_code)
  }`;
  const subject = "Join the CourseLynx group chat";
  templateIdx = Number(templateSelectEl?.value ?? 0);
  const intro = TEMPLATES[Number.isFinite(templateIdx) ? templateIdx : 0];

  const body = `${intro}\n${linkUrl}`;

  statusEl.textContent = "Checking remaining sections…";
  const { sectionIds, canvasHost } = await collectRemainingSectionIds(
    tab,
    course,
  );
  if (!sectionIds.length) {
    statusEl.textContent = "Already sent for all sections.";
    return;
  }

  // Claim all unclaimed sections up-front (one by one; collect successful claims)
  statusEl.textContent = `Claiming ${sectionIds.length} section(s)…`;
  const claims = [];
  for (const sid of sectionIds) {
    try {
      const claim = await claimCourse({
        canvasDomain: canvasHost,
        courseId: course.id,
        courseCode: course.course_code || null,
        courseName: course.name || null,
        sectionId: sid === 0 ? null : sid,
        sectionName: null,
        termKey,
        termLabel,
        linkUrl,
        sender: null,
      });
      if (claim && !claim.already_exists) {
        claims.push({ sectionId: sid, claimId: claim.id });
      }
    } catch (e) {
      // someone else may have raced us; ignore
    }
  }
  if (!claims.length) {
    statusEl.textContent = "Nothing to send — all sections claimed.";
    return;
  }

  // CSRF
  const csrfResp = await chrome.runtime.sendMessage({
    type: "GET_LATEST_CSRF",
  });
  if (!csrfResp?.csrf) {
    throw new Error(
      "Missing CSRF. Send one message in Canvas Inbox UI to prime, then try again.",
    );
  }
  const csrfToken = csrfResp.csrf;

  // Send once to all course students
  statusEl.textContent = "Fetching students & sending (chunked)…";
  const sendResp = await chrome.tabs.sendMessage(tab.id, {
    type: "SEND_LINK_TO_COURSE",
    courseId: course.id,
    subject,
    body,
    csrfToken,
  });
  if (!sendResp?.ok) {
    // release all claims if sending failed
    for (const c of claims) {
      try {
        await releaseClaim({ id: c.claimId });
      } catch {}
    }
    throw new Error(sendResp?.error || "Send failed");
  }

  // Mark each claimed section as sent
  const meta = {
    link_url: linkUrl,
    recipients: sendResp.totalRecipients,
    chunks: sendResp.chunks,
  };
  statusEl.textContent = `Marking ${claims.length} section(s) as sent…`;
  for (const c of claims) {
    await markSent({
      id: c.claimId,
      metadata: { ...meta, section_id: c.sectionId === 0 ? null : c.sectionId },
    });
    await new Promise((r) => setTimeout(r, 50)); // tiny spacing
  }

  statusEl.textContent =
    `Done: sent ${sendResp.totalRecipients} message(s) across ${sendResp.chunks} chunk(s).`;
}

const lastCourses = []; // cache in popup to attach buttons
const availabilityByCourseId = new Map();

async function fetchAndRenderCoursesForTerm(termText = "Fall 2025") {
  const status = document.getElementById("status");
  status.textContent = `Requesting courses and filtering by "${termText}"…`;

  try {
    const tab =
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab || !/^https:\/\/.*\.instructure\.com\//.test(tab.url || "")) {
      status.innerHTML =
        `<span class="error">Open this on a Canvas page (https://*.instructure.com/...)</span>`;
      return;
    }

    // ask content for filtered courses (reuse your existing message handler)
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FETCH_COURSES_FILTERED",
      termFilter: termText,
    });
    if (!resp?.ok) {
      status.innerHTML = `<span class="error">Failed: ${
        resp?.error || "unknown error"
      }</span>`;
      return;
    }

    // cache + render
    lastCourses.length = 0;
    lastCourses.push(...resp.courses);
    renderCourses(resp.courses);
    status.textContent =
      `Showing ${resp.courses.length} course(s) for "${termText}".`;

    // now compute availability per course (your existing loop)
    for (const course of resp.courses) {
      try {
        const avail = await computeCourseAvailability(tab, course);
        availabilityByCourseId.set(course.id, avail);

        const label = document.getElementById(`avail-${course.id}`);
        const ck = document.getElementById(`ck-${course.id}`);

        if (avail.availableSections > 0) {
          if (label) {
            label.textContent =
              `Available: ${avail.availableSections} of ${avail.totalSections} section(s)`;
          }
          if (ck) {
            ck.disabled = false;
            ck.checked = true;
            selectedCourseIds.add(course.id);
          }
        } else {
          if (label) {
            label.textContent = `Already sent for all sections this term`;
          }
          if (ck) {
            ck.checked = false;
            ck.disabled = true;
            selectedCourseIds.delete(course.id);
          }
        }
      } catch (e) {
        const label = document.getElementById(`avail-${course.id}`);
        if (label) {
          label.innerHTML = `<span class="error">Availability error: ${
            String(e).slice(0, 120)
          }</span>`;
        }
      }
    }
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span class="error">${String(err)}</span>`;
  }
}

sendSelectedBtn?.addEventListener("click", async () => {
  const ids = Array.from(selectedCourseIds);
  if (!ids.length) {
    alert("Select at least one course with availability.");
    return;
  }

  // Lock UI
  sendSelectedBtn.setAttribute("disabled", "true");
  fetchBtn?.setAttribute("disabled", "true");
  showProgress(true);
  setProgress(0, ids.length);

  let done = 0;

  try {
    for (const courseId of ids) {
      const course = lastCourses.find((c) => c.id === courseId);
      if (!course) {
        done++;
        setProgress(done, ids.length);
        continue;
      }

      const statusEl = document.getElementById(`avail-${course.id}`);
      const rowBtn = document.querySelector(
        `.btn-send[data-courseid="${course.id}"]`,
      );
      const ck = document.getElementById(`ck-${course.id}`);

      // Disable row controls during send
      rowBtn?.setAttribute("disabled", "true");
      ck?.setAttribute("disabled", "true");

      try {
        await handleSendLinkForCourse(course, statusEl);
        // After success, unselect + disable
        ck && (ck.checked = false);
        selectedCourseIds.delete(course.id);
      } catch (e) {
        statusEl && (statusEl.innerHTML = `<span class="error">${String(e)}`);
        // Leave checkbox unchecked so user can retry later
      }

      done++;
      setProgress(done, ids.length);
      // small pause between courses
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    showProgress(false);
    sendSelectedBtn.removeAttribute("disabled");
    fetchBtn?.removeAttribute("disabled");
  }
});
