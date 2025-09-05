# CourseLynx Messenger (Chrome Extension)

A Chrome (MV3) extension that helps you:
- **List your Canvas courses** (filtered by a specific term, e.g. “Spring 2023”)
- **Search a classmate by name** in the current course
- **Send a single Canvas Inbox message** to that classmate

This build works **without Personal Access Tokens (PATs)**. It uses a **CSRF sniffer** to mirror how the Canvas UI authorizes API requests.

---

## ✨ Features

- **Term filter** for courses (default: `Spring 2023`)
- **Search recipients by full name** within the current course
- **Send one message** via Canvas Conversations API (FormData + `recipients[]`)
- **CSRF auto-capture** from real Canvas traffic (REST or GraphQL)
- **Minimal, clean UI** using CourseLynx colors (royal blue + white)
- **No server** & no external dependencies

---

## 🧱 Architecture

MV3 extension with three parts:

- **`popup.html` + `popup.js`** – the UI you click in Chrome’s toolbar  
- **`content.js`** – runs on `https://*.instructure.com/*`; calls Canvas APIs with your session  
- **`background.js`** – service worker; **sniffs CSRF tokens** from request/response headers and caches them

Data flow:
Popup (button click)
- sends message to content script
- content script calls Canvas API (with cookies)
- background keeps recent CSRF token by watching network

---

## 🔐 How CSRF Sniffing Works

Many Canvas tenants disable PATs and do not expose a global CSRF token. However, the **Canvas UI itself** sends messages using a masked CSRF token (either on REST or GraphQL).  
The extension:

1. **Listens to outgoing API requests** (`/api/*`) and caches any `X-CSRF-Token` it sees.
2. **Listens to responses** and caches any `_csrf_token` seen in `Set-Cookie` as a fallback.
3. **Before sending**, the content script asks the background for the **most recent token** and sets `X-CSRF-Token` on the request.

> Tokens often rotate. If a send gets `422`, we re-check the latest token and retry once.

---

## ✅ Prerequisites

- Google Chrome (or Chromium-based browser supporting MV3)
- Access to your institution’s Canvas at `https://<tenant>.instructure.com/`
- You must be signed in to Canvas in the same browser profile

---

## 📦 Installation (Load Unpacked)

1. Clone or download this repository.
2. Go to `chrome://extensions` in Chrome.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. The extension appears in the toolbar as “CourseLynx Messenger”.

---

## 🛠 Permissions Rationale

- `activeTab`, `scripting` – basic extension messaging/DOM access
- `storage` – cache the latest CSRF token and small UI state
- `webRequest` – **read** request & response headers to capture CSRF
- `host_permissions: https://*.instructure.com/*` – run on Canvas pages and call Canvas APIs

> We **do not** modify Canvas traffic, only read headers.

---

## 🚀 Usage

### First run: “prime” CSRF capture
1. Open any page under your Canvas domain (ideally a **course page**).
2. Open the **Canvas Inbox** and send any quick message using the **native UI**.  
   - This lets the background script **capture** the CSRF header from a real request.
3. Open the extension popup and click **Refresh** in the CSRF panel (tiny grey box).  
   - You should see “Header token: present”.

### Fetch courses (filtered)
1. In the popup, the “My Courses” section has a **Term filter** (defaults to `Spring 2023`).
2. Click **Fetch Courses**.  
   - The list shows only courses whose **term label** or **course name** matches “Spring 2023” (with some fuzzy matching and date fallbacks).

### Send to one classmate
1. Make sure you’re on a **course page** (`/courses/<id>/...`).
2. Enter the recipient’s **full name** as shown in Canvas.
3. (Optional) Enter a subject.
4. Enter a short message and click **Send Message**.
5. If multiple matches are found, the popup will show candidates to help refine the name.

---

## 🧩 File Map
/ (project root)
├─ manifest.json        # MV3 configuration
├─ background.js        # CSRF sniffer: watches headers, caches latest token
├─ content.js           # Canvas API calls (fetch courses, search, send)
├─ popup.html           # CourseLynx-styled UI (royal blue + white)
└─ popup.js             # UI logic, messaging to content script

---

## ⚠️ Troubleshooting

- **CSRF status shows missing**  
  - Send any message in the **Canvas Inbox UI** once.  
  - Click **Refresh** in the popup’s CSRF panel.  
  - Navigate around Canvas (any `/api/*` traffic can help capture tokens).

- **`422 Unprocessable` on send**  
  - Token may have rotated: try again (the extension re-reads “latest” and retries once automatically).  
  - Ensure you used **FormData** with `recipients[]` and non-empty `body`.  
  - Use a **valid `context_code`** shared with the recipient (the extension auto-computes from `common_courses`).

- **`403 Forbidden`**  
  - Institution policy/role likely prevents messaging that user. Try sending via the **native Inbox UI**; if it’s blocked there, the API is too.

- **No Spring 2023 courses**  
  - Adjust the **Term filter** text. The fuzzy matcher accepts variants like `2023 Spring`, `Sp 2023`, etc.

---

## 🔒 Privacy & Security

- CSRF tokens are stored **locally** via `chrome.storage.local` and used only to call **your** Canvas endpoints.  
- The extension does **not** send any data to third parties.  
- You remain signed in with your normal Canvas cookies; the extension never sees your password.

---

## 🧪 Development Notes

- The extension uses **FormData** and relies on the browser to set the multipart boundary; we **do not manually set** `Content-Type` on POSTs.
- API endpoints used:
  - `GET /api/v1/courses?per_page=100&enrollment_state=active&include[]=term` (with pagination)
  - `GET /api/v1/search/recipients?search=<name>&context=course_<id>&types[]=user`
  - `POST /api/v1/conversations` (params: `recipients[]`, `subject`, `body`, `context_code`, `group_conversation=false`, `bulk_message=false`)
- Many tenants use **GraphQL** for the Inbox UI. We don’t need to replicate the mutation; we only **capture the CSRF** they use, which also works for REST.

---

## 🗺️ Roadmap

- Course **selector** and “Send to all students” batch flow with progress UI
- **Dry-run mode** (log what would be sent)
- **GraphQL** send path (mirror UI mutation)
- **Ambiguity resolver** for recipient search (select from candidates)
- Export **course roster** to CSV for debugging
- Collapsible **Developer Info** section (fully hidden by default)

---

## 📄 License

MIT License – see LICENSE file for details.

---

## 🖼️ Screenshots (optional)

Add screenshots/GIFs for:
- Popup main view (courses + send)
- CSRF panel (tiny dev info)
- Success message
