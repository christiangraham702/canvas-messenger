// db.js  (loaded by popup.html as a module)
const SUPABASE_URL = "https://bbouzkzmjyvsxqaomimt.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJib3V6a3ptanl2c3hxYW9taW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxMDk3MzksImV4cCI6MjA3MjY4NTczOX0.krNF_H6PXIyatcYNp2i3saNFUF5Oo_6gn8LN8oTKYEY";

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`RPC ${fn} failed ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json();
}

// Public helpers the popup will use
export async function claimCourse(payload) {
  const rows = await rpc("courselynx_claim", {
    _canvas_domain: payload.canvasDomain,
    _course_id: Number(payload.courseId),
    _course_code: payload.courseCode || null,
    _course_name: payload.courseName || null,
    _section_id: payload.sectionId ?? null,
    _section_name: payload.sectionName || null,
    _term_key: payload.termKey,
    _term_label: payload.termLabel || payload.termKey,
    _link_url: payload.linkUrl || null,
    _sender: payload.sender || null,
  });
  return rows?.[0] || null; // { id, already_exists, status }
}

export async function markSent({ id, metadata }) {
  const rows = await rpc("courselynx_mark_sent", {
    _id: id,
    _message_metadata: metadata || null,
  });
  return rows; // updated row
}

export async function releaseClaim({ id }) {
  return rpc("courselynx_release_claim", { _id: id });
}

// db.js (add this near the top, after SUPABASE_URL/KEY)
async function dbSelect(pathWithQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithQuery}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DB select failed ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// Public: read all sends for a course+term (any section)
export async function getCourseSends({ canvasDomain, courseId, termKey }) {
  // filter: canvas_domain=eq.<>, course_id=eq.<>, term_key=eq.<>
  const qp = new URLSearchParams({
    select: "*",
    canvas_domain: `eq.${canvasDomain}`,
    course_id: `eq.${courseId}`,
    term_key: `eq.${termKey}`,
  }).toString();
  return dbSelect(`courselynx_sends?${qp}`);
}
