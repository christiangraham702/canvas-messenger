async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

async function refreshCsrfStatus() {
  const box = document.getElementById("csrfStatus");
  const resp = await chrome.runtime.sendMessage({ type: "GET_LATEST_CSRF" });
  if (!resp?.ok) {
    box.textContent = "Unable to read CSRF cache.";
    return;
  }
  const h = resp.sources.header;
  const c = resp.sources.cookie;
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

function renderCourses(courses) {
  const results = document.getElementById("results");
  if (!courses || courses.length === 0) {
    results.innerHTML = "<p><em>No courses matched this term.</em></p>";
    return;
  }
  const list = document.createElement("ul");
  courses.forEach((c) => {
    const li = document.createElement("li");
    const term = c?.enrollment_term?.name || c?.term?.name || "—";
    li.innerHTML = `<div><strong>${c.name || "(unnamed course)"}</strong></div>
                    <div class="small"><code>ID: ${c.id}</code> · Code: ${
      c.course_code || "—"
    } · Term: ${term}</div>`;
    list.appendChild(li);
  });
  results.innerHTML = "";
  results.appendChild(list);
}

function renderCandidates(cands) {
  const box = document.getElementById("candidates");
  if (!cands?.length) {
    box.innerHTML = "";
    return;
  }
  const list = cands.slice(0, 10).map((u) =>
    `<li>${(u.name ||
      "(no name)")} <span class="small">— id:${u.id}</span></li>`
  ).join("");
  box.innerHTML =
    `<div class="small" style="margin-top:8px"><strong>Multiple matches:</strong> refine the name (e.g., include middle initial).</div>
                   <ul>${list}</ul>`;
}

document.getElementById("refreshCsrf").addEventListener(
  "click",
  refreshCsrfStatus,
);
document.getElementById("clearCsrf").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_CSRF_CACHE" });
  await refreshCsrfStatus();
  alert("Cleared cached CSRF tokens.");
});
document.addEventListener("DOMContentLoaded", refreshCsrfStatus);

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  const termFilter = (document.getElementById("termFilter").value || "").trim();
  results.innerHTML = "";
  status.textContent =
    `Requesting courses from the Canvas API and filtering by "${
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
    if (resp?.ok) {
      status.textContent =
        `Showing ${resp.courses.length} course(s) for "${termFilter}".`;
      renderCourses(resp.courses);
    } else {
      status.innerHTML = `<span class="error">Failed: ${
        resp?.error || "unknown error"
      }</span>`;
    }
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span class="error">${String(err)}</span>`;
  }
});

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
    } else {
      sendStatus.innerHTML = `<span class="error">${
        resp?.error || "Failed to send."
      }</span>`;
      if (resp?.candidates?.length) renderCandidates(resp.candidates);
    }
  } catch (e) {
    console.error(e);
    sendStatus.innerHTML = `<span class="error">${String(e)}</span>`;
  }
});
