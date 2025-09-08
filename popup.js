// popup.js (module)
import { claimCourse, getCourseSends, markSent, releaseClaim } from "./db.js";

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
  const linkUrl = `https://courselynx.app/c/${host}/${course.id}/${termKey}`;
  const subject = "test";
  const body = "test";

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

function renderCourses(courses) {
  const results = document.getElementById("results");
  results.innerHTML = "";
  if (!courses?.length) {
    results.innerHTML = "<p><em>No courses matched this term.</em></p>";
    return;
  }

  const ul = document.createElement("ul");

  courses.forEach((c) => {
    const term = getTermLabel(c) || "—";
    const li = document.createElement("li");
    li.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
        <div>
          <div><strong>${c.name || "(unnamed course)"}</strong></div>
          <div class="small"><code>ID: ${c.id}</code> · Code: ${
      c.course_code || "—"
    } · Term: ${term}</div>
          <div class="small" id="avail-${c.id}" style="margin-top:6px;">Checking availability…</div>
        </div>
        <div style="min-width:150px; text-align:right;">
          <button class="btn-send" data-courseid="${c.id}" disabled>Send Link</button>
        </div>
      </div>
    `;
    ul.appendChild(li);
  });

  results.appendChild(ul);

  // Wire "Send" (we'll implement later to actually broadcast)
  results.querySelectorAll(".btn-send").forEach((btn) => {
    // in renderCourses, when wiring the .btn-send:
    btn.addEventListener("click", async () => {
      const courseId = Number(btn.dataset.courseid);
      const course = lastCourses.find((c) => c.id === courseId);
      const statusEl = document.getElementById(`avail-${course.id}`);
      btn.setAttribute("disabled", "true");
      try {
        await handleSendLinkForCourse(course, statusEl);
      } catch (e) {
        statusEl.innerHTML = `<span class="error">${String(e)}`;
        btn.removeAttribute("disabled");
      }
    });
  });
}

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const termFilter = (document.getElementById("termFilter").value || "").trim();
  status.textContent = `Requesting courses and filtering by "${
    termFilter || "—"
  }"…`;

  try {
    const tab = await getActiveTab();
    if (!tab || !/^https:\/\/.*\.instructure\.com\//.test(tab.url || "")) {
      status.innerHTML =
        `<span class="error">Open this on a Canvas page (https://*.instructure.com/...)</span>`;
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FETCH_COURSES_FILTERED",
      termFilter,
    });
    if (!resp?.ok) {
      status.innerHTML = `<span class="error">Failed: ${
        resp?.error || "unknown error"
      }</span>`;
      return;
    }

    lastCourses.length = 0;
    lastCourses.push(...resp.courses);
    status.textContent =
      `Showing ${resp.courses.length} course(s) for "${termFilter}".`;
    renderCourses(resp.courses);

    // Now compute availability per course (async) and update the UI as results come in
    for (const course of resp.courses) {
      try {
        const avail = await computeCourseAvailability(tab, course);
        availabilityByCourseId.set(course.id, avail);
        const label = document.getElementById(`avail-${course.id}`);
        if (label) {
          if (avail.availableSections > 0) {
            label.textContent =
              `Available: ${avail.availableSections} of ${avail.totalSections} section(s)`;
            // enable the Send button
            const btn = document.querySelector(
              `.btn-send[data-courseid="${course.id}"]`,
            );
            if (btn) btn.removeAttribute("disabled");
          } else {
            label.textContent = `Already sent for all sections this term`;
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
});
