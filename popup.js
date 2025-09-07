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

// ==== CSRF status (unchanged) ====
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

// ==== Term-filtered course fetch ====

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
    btn.addEventListener("click", () => {
      const courseId = Number(btn.dataset.courseid);
      const avail = availabilityByCourseId.get(courseId);
      if (!avail || avail.availableSections === 0) return;
      alert(
        `Ready to send for ${avail.courseName} — ${avail.availableSections} section(s) available. (Next step: implement send loop)`,
      );
    });
  });
}
// Helper to get chosen section for a row
function getChosenSection(idx) {
  const sel = document.querySelector(`#sections-wrap-${idx} select`);
  if (sel && sel.value) {
    const payload = sel.options[sel.selectedIndex].dataset.payload;
    return payload ? JSON.parse(payload) : {
      id: Number(sel.value),
      name: sel.options[sel.selectedIndex].textContent,
    };
  }
  return null; // no selection => course-wide (null section)
}

// Load sections via content script
async function loadSectionsForRow(idx) {
  const st = document.getElementById(`row-status-${idx}`);
  const wrap = document.getElementById(`sections-wrap-${idx}`);
  st.textContent = "Loading sections…";
  try {
    const tab = await getActiveTab();
    const course = lastCourses[idx];
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FETCH_SECTIONS",
      courseId: course.id,
    });
    if (!resp?.ok) throw new Error(resp?.error || "Failed to fetch sections.");

    const sections = resp.sections || [];
    if (!sections.length) {
      wrap.innerHTML = `<span class="small">No sections found.</span>`;
    } else {
      const opts = sections.map((s) =>
        `<option value="${s.id}" data-payload='${JSON.stringify(s)}'>${
          s.name || `Section ${s.id}`
        }</option>`
      ).join("");
      wrap.innerHTML = `<select>${opts}</select>`;
    }
    st.textContent = "Sections loaded.";
  } catch (e) {
    st.innerHTML = `<span class="error">${String(e)}</span>`;
  }
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

async function coursePayloadForDB(course, section /* {id,name} or null */) {
  const tab = await getActiveTab();
  const canvasHost = new URL(tab.url).host; // e.g., ufl.instructure.com

  const termLabel = getTermLabel(course) || "Spring 2023";
  const termKey = toTermKey(termLabel);

  return {
    canvasDomain: canvasHost,
    courseId: course.id,
    courseCode: course.course_code || null,
    courseName: course.name || null,
    sectionId: section?.id ?? null,
    sectionName: section?.name ?? null,
    termKey,
    termLabel,
    linkUrl: `https://courselynx.app/c/${canvasHost}/${course.id}/${termKey}`,
    sender: null,
  };
}

async function _devClaimCourse(idx) {
  const st = document.getElementById(`row-status-${idx}`);
  st.textContent = "Claiming in DB…";
  try {
    const section = getChosenSection(idx); // <-- NEW
    const payload = await coursePayloadForDB(lastCourses[idx], section);
    const res = await claimCourse(payload);
    if (!res) throw new Error("No response from claim RPC.");
    st.textContent = res.already_exists
      ? `Already claimed (status=${res.status})`
      : `Claimed OK (id=${res.id})`;
    st.dataset.claimId = res.id;
  } catch (e) {
    st.innerHTML = `<span class="error">${String(e)}</span>`;
  }
}

async function _devMarkSent(idx) {
  const st = document.getElementById(`row-status-${idx}`);
  const id = st.dataset.claimId;
  if (!id) {
    st.innerHTML = `<span class="error">Claim first (no id cached).</span>`;
    return;
  }
  st.textContent = "Marking sent…";
  try {
    const updated = await markSent({
      id,
      metadata: { test: true, at: new Date().toISOString() },
    });
    st.textContent = `Marked sent at ${(updated?.[0]?.sent_at || "now")}`;
  } catch (e) {
    st.innerHTML = `<span class="error">${String(e)}</span>`;
  }
}

async function _devRelease(idx) {
  const st = document.getElementById(`row-status-${idx}`);
  const id = st.dataset.claimId;
  if (!id) {
    st.innerHTML = `<span class="error">Claim first (no id cached).</span>`;
    return;
  }
  st.textContent = "Releasing claim…";
  try {
    await releaseClaim({ id });
    st.textContent = "Released (if still pending).";
  } catch (e) {
    st.innerHTML = `<span class="error">${String(e)}</span>`;
  }
}

// ===== Existing "Send to One" remains unchanged =====
document.getElementById("sendOneBtn").addEventListener("click", async () => {
  const sendStatus = document.getElementById("sendStatus");
  const candidatesBox = document.getElementById("candidates");
  candidatesBox.innerHTML = "";
  sendStatus.textContent = "Searching and sending via Canvas…";

  const term = (document.getElementById("recipientTerm").value || "").trim();
  const subject = document.getElementById("oneSubject").value || "";
  const body = document.getElementById("oneBody").value || "";

  if (!term) {
    sendStatus.innerHTML =
      `<span class="error">Enter a recipient full name.</span>`;
    return;
  }
  if (!body.trim()) {
    sendStatus.innerHTML =
      `<span class="error">Message body is required.</span>`;
    return;
  }

  try {
    const tab = await getActiveTab();
    if (!tab || !/^https:\/\/.*\.instructure\.com\//.test(tab.url || "")) {
      sendStatus.innerHTML =
        `<span class="error">Open this on a Canvas course page.</span>`;
      return;
    }

    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "SEND_ONE_VIA_CANVAS",
      recipientTerm: term,
      subject,
      body,
    });

    if (resp?.ok) {
      sendStatus.textContent = `Sent message to user ID ${resp.userId}.`;
      await refreshCsrfStatus();
    } else {
      sendStatus.innerHTML = `<span class="error">${
        resp?.error || "Failed to send."
      }</span>`;
      if (resp?.candidates?.length) {
        const list = resp.candidates.slice(0, 10).map((u) =>
          `<li>${u.name} — id:${u.id}</li>`
        ).join("");
        candidatesBox.innerHTML = `<ul class="small">${list}</ul>`;
      }
    }
  } catch (e) {
    console.error(e);
    sendStatus.innerHTML = `<span class="error">${String(e)}</span>`;
  }
});
