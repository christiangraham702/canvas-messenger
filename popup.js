// popup.js (module)
import { claimCourse, getCourseSends, markSent, releaseClaim } from "./db.js";

/* =========================
   Message templates (14)
   ========================= */
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

/* =========================
   State & DOM refs
   ========================= */
const selectedCourseIds = new Set();
const lastCourses = []; // cache in popup to attach buttons
const availabilityByCourseId = new Map();

const coursesSection = document.getElementById("coursesSection");

const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const sendSelectedBtn = document.getElementById("sendSelectedBtn");
const doNotCloseEl = document.getElementById("doNotClose");

const templateSelectEl = document.getElementById("templateSelect"); // optional
const randomizeBtn = document.getElementById("randomizeBtn"); // optional
const previewBodyEl = document.getElementById("previewBody"); // single-line input

/* =========================
   Small utilities
   ========================= */
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

const SCHOOL_OVERRIDES = new Map([
  // explicit overrides you mentioned:
  ["usflearn", "usf"],
  ["bruinlearn", "ucla"], // bruinlearn.ucla.edu -> ucla
]);

function extractSchool(host) {
  if (!host) return "";

  // 1) *.instructure.com => take first label (with overrides)
  if (host.endsWith(".instructure.com")) {
    const first = host.split(".")[0];
    return SCHOOL_OVERRIDES.get(first) || first;
  }

  // 2) canvas/learn/webcourses/bruinlearn.school.tld => take 2nd label
  //    e.g., canvas.wisc.edu -> wisc, webcourses.ucf.edu -> ucf
  const m = host.match(/^(canvas|learn|webcourses|bruinlearn)\.([^.]+)/i);
  if (m) {
    const lbl = m[2].toLowerCase();
    // If the branded subdomain itself maps to an override, respect it.
    const branded = m[1].toLowerCase();
    const overrideKey = SCHOOL_OVERRIDES.get(branded);
    return overrideKey || lbl;
  }

  // 3) Otherwise: use first label as a fallback
  return host.split(".")[0].toLowerCase();
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

// check if on canvas
function isCanvasUrl(u) {
  try {
    const { host, protocol } = new URL(u);
    if (protocol !== "https:") return false;
    // 1) Standard Canvas cloud
    if (host.endsWith(".instructure.com")) return true;
    // 2) Common school-hosted Canvas domains
    //    canvas.wisc.edu, webcourses.ucf.edu, bruinlearn.ucla.edu, etc.
    if (/^(canvas|learn|webcourses|bruinlearn)\./i.test(host)) return true;
    // 3) Add other branded prefixes you encounter later (e.g., "lms.", "elearning.")
    // if (/^(lms|elearning)\./i.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/* =========================
   Get the right course code
   ========================= */
// ---- Term tokens to strip from course_code/name before parsing subject+number ----
const TERM_TOKENS_RE = new RegExp(
  [
    // Compact codes like 2025FA, 2025SP, FA2025, SP2025, AU2025 (FSU uses AU=Autumn/Fall)
    String.raw`\b(20\d{2})(?:\s*[-_ ]?)?(FA|SP|SU|SM|WI|AU)\b`,
    String.raw`\b(FA|SP|SU|SM|WI|AU)(?:\s*[-_ ]?)?(20\d{2})\b`,
    // Wordy forms like "Fall 2025", "2025 Fall", "2025 Fall 1", "Fall 2025 Main"
    String.raw`\b(20\d{2})\s*(fall|autumn|spring|summer|winter)\b`,
    String.raw`\b(fall|autumn|spring|summer|winter)\s*(20\d{2})\b`,
    // Standalone season words with optional session marker
    String.raw`\b(fall|autumn|spring|summer|winter)\s*\d?\b`,
    // Extra: AU 2025 (explicit space form)
    String.raw`\bau\s*20\d{2}\b`,
  ].join("|"),
  "gi",
);

// Remove parenthetical chunks like "(12345)" or "(Lecture)"
const PARENS_RE = /\([^)]*\)/g;

// Map some long subject words to their short code (tweak as you learn schools)
const SUBJECT_MAP = {
  BIOLOGY: "biol",
  CHEMISTRY: "chem",
  PHYSICS: "phys",
  PHILOSOPHY: "phil",
  // OSU-style multiword subjects (ARTSSCI, BUSFIN, BIOCHEM) should pass through.
};

// Try to extract SUBJECT + 3–4 digit number and return "subject_1234"
function parseSubjectNumberSlug(raw) {
  if (!raw) return null;
  let s = String(raw).toUpperCase();

  // Drop parentheses and term tokens like "AU2025", "Fall 2025", "2025 Fall 1"
  s = s.replace(PARENS_RE, " ");
  s = s.replace(TERM_TOKENS_RE, " ");
  s = s.replace(/\s+/g, " ").trim();

  // Pattern: SUBJECT 1234(.section)? or SUBJECT1234
  // e.g., "ARTSSCI 1100.14", "BUSFIN 3220", "BIOCHEM4511", "BIOLOGY 1114.01"
  let m = s.match(/\b([A-Z&]{2,})\s*([0-9]{3,4})(?:[.\-][0-9A-Z]{1,3})?\b/);
  if (!m) {
    // fallback where subject & number are stuck but followed by junk
    m = s.match(/\b([A-Z&]{2,}?)([0-9]{3,4})\b/);
  }
  if (!m) return null;

  let subj = m[1];
  const num = m[2];

  // Normalize subject token -> lowercase, '&' -> 'and'
  let subjNorm = subj.toLowerCase().replace(/&/g, "and");
  if (SUBJECT_MAP[subj]) subjNorm = SUBJECT_MAP[subj];

  return `${subjNorm}_${num}`;
}

// Fallback slug if we can’t parse a clean subject+number
function fallbackSlug(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/([a-z])([0-9])/g, "$1_$2"); // add underscore between letter+digit
}

// Given a course object, produce the best join-link slug
function courseSlugFromCourse(course) {
  // Try course_code first (usually best), then name
  const try1 = parseSubjectNumberSlug(course?.course_code);
  if (try1) return try1;

  const try2 = parseSubjectNumberSlug(course?.name);
  if (try2) return try2;

  // Fallback to normalized course_code or name
  return fallbackSlug(course?.course_code || course?.name || "");
}

/* =========================
   CSRF panel (unchanged)
   ========================= */
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

/* =========================
   Templates: preview + randomize
   ========================= */
let currentTemplateIdx = 0;

// If you still keep the dropdown, populate it and sync with currentTemplateIdx
document.addEventListener("DOMContentLoaded", () => {
  if (templateSelectEl && !templateSelectEl.options.length) {
    TEMPLATES.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = t;
      templateSelectEl.appendChild(opt);
    });
    templateSelectEl.selectedIndex = 0;
  }
});

// Use the first selected course to build the link preview
function getFirstSelectedCourse() {
  const firstId = Array.from(selectedCourseIds)[0];
  return lastCourses.find((c) => c.id === firstId);
}

async function updatePreview() {
  if (!previewBodyEl) return;
  const intro = TEMPLATES[currentTemplateIdx] || TEMPLATES[0];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let link = "[Insert app link]";

  const course = getFirstSelectedCourse();
  if (tab && course) {
    const host = new URL(tab.url).host;
    const school = extractSchool(host);
    link = `https://app.courselynx.com/join/${school}/${
      courseSlugFromCourse(course)
    }`;
  }

  // newline so it renders on multiple lines
  previewBodyEl.value = `${intro}\n${link}`;
}

// Keep preview in sync with dropdown changes
templateSelectEl?.addEventListener("change", () => {
  currentTemplateIdx = Number(templateSelectEl.value) || 0;
  updatePreview();
});

// Randomize button
randomizeBtn?.addEventListener("click", async () => {
  let next = Math.floor(Math.random() * TEMPLATES.length);
  if (next === currentTemplateIdx) next = (next + 1) % TEMPLATES.length;
  currentTemplateIdx = next;
  if (templateSelectEl) templateSelectEl.value = String(next);
  await updatePreview();
});

/* =========================
   Progress Bar Helpers
   ========================= */
// --- Chunk-based progress model ---
const progressModel = {
  totalChunksPlanned: 0,
  sentChunks: 0,
  perCourse: new Map(), // courseId -> { totalChunks: number, sentChunks: number }
};

function resetProgressModel() {
  progressModel.totalChunksPlanned = 0;
  progressModel.sentChunks = 0;
  progressModel.perCourse.clear();
}

function recomputeSentChunks() {
  let sum = 0;
  for (const v of progressModel.perCourse.values()) {
    sum += v.sentChunks || 0;
  }
  progressModel.sentChunks = sum;
}

function updateOverallProgress() {
  const total = progressModel.totalChunksPlanned;
  const done = progressModel.sentChunks;
  if (total > 0) {
    // switch to determinate
    progressBar.classList.remove("indeterminate");
    const pct = Math.round((done / total) * 100);
    progressBar.style.width = pct + "%";
    progressLabel.textContent = `${pct}% (${done}/${total} chunks)`;
  } else {
    // while we don't know totals yet, show an indeterminate animation
    progressBar.classList.add("indeterminate");
    progressBar.style.width = "30%"; // small bar that animates
    progressLabel.textContent = "Preparing…";
  }
}

/* =========================
   Get person using exension
   ========================= */
// Cache the current user so we don’t refetch every section
let cachedUser = null;
async function getCurrentUser() {
  if (!cachedUser) {
    cachedUser = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_SELF" });
  }
  return cachedUser;
}

/* =========================
   Sections / availability
   ========================= */
async function loadSectionsFromContent(tabId, courseId) {
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "FETCH_SECTIONS",
    courseId,
  });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to fetch sections");
  return resp.sections || [];
}

async function computeCourseAvailability(tab, course) {
  const canvasHost = new URL(tab.url).host;
  const termLabel = getTermLabel(course) || "Fall 2025";
  const termKey = toTermKey(termLabel);

  // 1) Sections from Canvas
  const sections = await loadSectionsFromContent(tab.id, course.id);

  // 2) DB rows for this course+term
  const rows = await getCourseSends({
    canvasDomain: canvasHost,
    courseId: course.id,
    termKey,
  });

  // 3) Claimed set
  const claimed = new Set(
    rows.map((r) => (r.section_id === null ? 0 : Number(r.section_id))),
  );

  // 4) Remaining
  const allSectionIds = sections.length
    ? sections.map((s) => Number(s.id))
    : [0];
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

/* =========================
   UI: render courses (checkbox on right)
   ========================= */
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

  // Toggle checkbox by clicking the card
  results.querySelectorAll(".course-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("input,button,a,select,textarea")) return;
      const id = Number(card.dataset.courseid);
      const ck = document.getElementById(`ck-${id}`);
      if (!ck || ck.disabled) return;
      ck.checked = !ck.checked;
      if (ck.checked) selectedCourseIds.add(id);
      else selectedCourseIds.delete(id);
      updatePreview();
    });
  });

  // Track checkbox changes
  results.querySelectorAll(".course-check").forEach((ck) => {
    ck.addEventListener("change", () => {
      const id = Number(ck.dataset.courseid);
      if (ck.checked) selectedCourseIds.add(id);
      else selectedCourseIds.delete(id);
      updatePreview();
    });
  });
}

/* =========================
   Intro → fetch courses
   ========================= */
document.addEventListener("DOMContentLoaded", () => {
  coursesSection.classList.remove("hidden");
  fetchAndRenderCoursesForTerm("Spring 2024");
});
/* =========================
   Collect remaining sections for a course
   ========================= */
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
    rows.map((r) => (r.section_id === null ? 0 : Number(r.section_id))),
  );

  return {
    sectionIds: sectionIds.filter((id) => !claimed.has(id)),
    canvasHost,
    termKey,
    termLabel,
  };
}

/* =========================
   Send for one course
   ========================= */
async function handleSendLinkForCourse(course, statusEl) {
  const tab =
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const host = new URL(tab.url).host;
  const termLabel = getTermLabel(course);
  const termKey = toTermKey(termLabel);

  const joinUrl = `https://app.courselynx.com/join/${extractSchool(host)}/${
    courseSlugFromCourse(course)
  }`;

  const subject = "Join the CourseLynx group chat";
  const intro = TEMPLATES[currentTemplateIdx] || TEMPLATES[0];
  const body = `${intro} ${joinUrl}`;
  statusEl.textContent = "Checking remaining sections…";
  const { sectionIds, canvasHost } = await collectRemainingSectionIds(
    tab,
    course,
  );
  if (!sectionIds.length) {
    statusEl.textContent = "Already sent for all sections.";
    return;
  }

  // Claim all unclaimed sections (one by one)
  statusEl.textContent = `Claiming ${sectionIds.length} section(s)…`;
  const claims = [];
  const userProfile = await getCurrentUser();
  const senderEmail = userProfile?.primary_email || null;
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
        linkUrl: joinUrl,
        sender: senderEmail,
      });
      if (claim && !claim.already_exists) {
        claims.push({ sectionId: sid, claimId: claim.id });
      }
    } catch {
      // race is fine, just skip
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
    link_url: joinUrl,
    recipients: sendResp.totalRecipients,
    chunks: sendResp.chunks,
  };
  statusEl.textContent = `Marking ${claims.length} section(s) as sent…`;
  for (const c of claims) {
    await markSent({
      id: c.claimId,
      metadata: { ...meta, section_id: c.sectionId === 0 ? null : c.sectionId },
    });
    await new Promise((r) => setTimeout(r, 50));
  }

  statusEl.textContent =
    `Done: sent ${sendResp.totalRecipients} message(s) across ${sendResp.chunks} chunk(s).`;
}

/* =========================
   Fetch & render courses for a term
   ========================= */
async function fetchAndRenderCoursesForTerm(termText = "Fall 2025") {
  const status = document.getElementById("status");
  status.textContent = `Requesting courses and filtering by "${termText}"…`;

  try {
    const tab =
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

    if (!tab || !isCanvasUrl(tab.url || "")) {
      status.innerHTML =
        `<span class="error">Open this on a Canvas page (e.g., *.instructure.com, canvas.*.edu, webcourses.*.edu)</span>`;
      return;
    }

    // Ask content for filtered courses
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
      "Clicking button will send message to all selected courses.";

    // compute availability for each course
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

    // once list is ready (and some may be auto-checked), show preview
    updatePreview();
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span class="error">${String(err)}</span>`;
  }
}

/* =========================
   Batch "Send link to selected"
   ========================= */
sendSelectedBtn?.addEventListener("click", async () => {
  const ids = Array.from(selectedCourseIds);
  if (!ids.length) {
    alert("Select at least one course with availability.");
    return;
  }

  // Lock UI and init chunk-based progress
  sendSelectedBtn.setAttribute("disabled", "true");
  resetProgressModel();
  showProgress(true);
  updateOverallProgress(); // start indeterminate until plans arrive

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
      const ck = document.getElementById(`ck-${course.id}`);

      // Disable row control during send
      ck?.setAttribute("disabled", "true");

      try {
        await handleSendLinkForCourse(course, statusEl);
        // After success, unselect + disable
        if (ck) ck.checked = false;
        selectedCourseIds.delete(course.id);
      } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="error">${String(e)}`;
        // Leave checkbox unchecked so user can retry later
      }

      done++;
      setProgress(done, ids.length);
      await new Promise((r) => setTimeout(r, 300)); // tiny spacing
    }
  } finally {
    showProgress(false);
    sendSelectedBtn.removeAttribute("disabled");
    updatePreview(); // update preview after selection changes
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SEND_PLAN") {
    const { courseId, totalChunks } = msg;
    let pc = progressModel.perCourse.get(courseId);
    if (!pc) {
      pc = { totalChunks: 0, sentChunks: 0 };
      progressModel.perCourse.set(courseId, pc);
    }
    if (!pc.totalChunks) {
      pc.totalChunks = totalChunks;
      progressModel.totalChunksPlanned += totalChunks;
    }
    updateOverallProgress();
  }

  if (msg?.type === "SEND_CHUNK_DONE") {
    const { courseId, chunk, totalChunks } = msg;
    let pc = progressModel.perCourse.get(courseId);
    if (!pc) {
      pc = { totalChunks: totalChunks || 0, sentChunks: 0 };
      progressModel.perCourse.set(courseId, pc);
      if (pc.totalChunks) progressModel.totalChunksPlanned += pc.totalChunks;
    }
    pc.sentChunks = Math.max(pc.sentChunks || 0, chunk || 0);
    recomputeSentChunks();
    updateOverallProgress();
  }
});
