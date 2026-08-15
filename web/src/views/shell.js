import { $, el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state, subscribe, loadTree, loadDeps } from "../lib/store.js";
import { navigate, currentPath } from "../lib/router.js";
import { cycleTheme, themeLabel } from "../lib/theme.js";
import { subjectColor } from "../components/subjectTheme.js";
import { showPrompt, closeAllModals } from "../lib/modal.js";
import { toastError } from "../lib/toast.js";
import { initials } from "../lib/format.js";
import { openProfileModal } from "../features/profileModal.js";

let outlet;
let subjectList;
let depsPill;
let themeBtn;

const DEP_STATE = {
  up: { cls: "green", text: "ระบบพร้อม" },
  ready: { cls: "green", text: "ระบบพร้อม" },
  down: { cls: "red", text: "บางบริการไม่พร้อม" },
};

export function mountShell() {
  const app = $("#app");
  clear(app);

  subjectList = el("div", { class: "nav-group" });
  depsPill = el("span", { class: "pill", role: "status", "aria-live": "polite" }, el("span", { class: "dot" }), "กำลังตรวจระบบ");

  const addSubject = el("button", { class: "icon-btn sm", type: "button", "aria-label": "สร้างรายวิชา", title: "สร้างรายวิชา" }, "＋");
  addSubject.addEventListener("click", createSubject);

  themeBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, `ธีม: ${themeLabel()}`);
  themeBtn.addEventListener("click", () => {
    themeBtn.textContent = `ธีม: ${themeLabel(cycleTheme())}`;
  });

  const logout = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "ออกจากระบบ");
  logout.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    location.reload();
  });

  const brand = el(
    "button",
    { class: "brand", type: "button" },
    el("img", { class: "brand-mark", src: "/icon-192.png", alt: "", width: 34, height: 34, decoding: "async" }),
    el(
      "span",
      {},
      el("span", { class: "brand-name" }, "LearnifyAI"),
      el("br"),
      el("span", { class: "brand-sub" }, "พิสูจน์ความเข้าใจจริง")
    )
  );
  brand.addEventListener("click", () => navigate("/"));

  const rosterItem = el("button", { class: "nav-item", type: "button", "data-path": "/roster" }, "รายชื่อนักเรียน");
  rosterItem.addEventListener("click", () => navigate("/roster"));

  const user = el("button", { class: "nav-item", type: "button", style: "gap:10px;min-height:48px", title: "แก้ไขโปรไฟล์" });
  user.addEventListener("click", openProfileModal);

  const sidebar = el(
    "nav",
    { class: "sidebar", "aria-label": "เมนูหลัก" },
    brand,
    el(
      "div",
      { class: "nav-group" },
      el("div", { class: "nav-head" }, el("span", { class: "eyebrow" }, "รายวิชา"), addSubject),
      subjectList
    ),
    el("div", { class: "nav-group" }, rosterItem),
    el("div", { class: "nav-foot" }, depsPill, user, themeBtn, logout)
  );

  outlet = el("main", { class: "main", id: "outlet" });
  app.append(el("div", { class: "shell" }, sidebar, outlet));
  app.hidden = false;

  renderUser(user);
  renderSubjectNav();
  subscribe((reason) => {
    if (reason === "tree") renderSubjectNav();
    if (reason === "deps") renderDeps();
    if (reason === "user") renderUser(user);
  });

  loadDeps().catch(() => {});
  setInterval(() => loadDeps().catch(() => {}), 60_000);
}

/* รูปจาก Google (lh3.googleusercontent.com) ถูกปฏิเสธเมื่อเบราว์เซอร์แนบ Referer มาด้วย
   จึงต้องสั่ง no-referrer และถ้ารูปยังโหลดไม่ขึ้น ให้ตกกลับไปใช้อักษรย่อ ไม่ปล่อยวงกลมว่าง */
function avatarImg(u) {
  const img = el("img", { class: "avatar", src: u.picture, alt: "", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => {
    img.replaceWith(el("span", { class: "avatar" }, initials(u.name || u.email)));
  });
  return img;
}

function renderUser(box) {
  const u = state.user;
  clear(box);
  if (!u) return;

  const subtitle = [u.title, u.department].filter(Boolean).join(" · ");
  box.append(
    u.picture ? avatarImg(u) : el("span", { class: "avatar" }, initials(u.name || u.email)),
    el(
      "span",
      { class: "grow", style: "min-width:0;text-align:left" },
      el("span", { class: "truncate", style: "display:block;font-weight:700" }, u.name || u.email),
      el("span", { class: "hint truncate", style: "display:block" }, subtitle || "แก้ไขโปรไฟล์")
    )
  );
}

function renderDeps() {
  const d = state.deps;
  clear(depsPill);
  if (!d) return;
  const bad = [
    d.whisper !== "up" && "ถอดเสียง",
    d.typhoon !== "ready" && "วิเคราะห์",
    d.opencodezen !== "ready" && "ค้นข้อมูล",
  ].filter(Boolean);
  const tone = bad.length ? DEP_STATE.down : DEP_STATE.up;
  depsPill.className = `pill ${tone.cls}`;
  depsPill.append(el("span", { class: "dot" }), bad.length ? `${bad.join(" · ")}ไม่พร้อม` : tone.text);
}

function renderSubjectNav() {
  clear(subjectList);
  if (!state.tree.length) {
    subjectList.append(el("p", { class: "hint", style: "padding:0 8px" }, "ยังไม่มีรายวิชา"));
    return;
  }
  for (const subject of state.tree) {
    const item = el(
      "button",
      { class: "nav-item", type: "button", "data-path": `/subject/${subject.id}` },
      el("span", { class: "nav-swatch", style: `background:${subjectColor(subject)}` }),
      el("span", { class: "truncate grow" }, subject.name),
      el("span", { class: "nav-count" }, String(subject.student_count ?? 0))
    );
    item.addEventListener("click", () => navigate(`/subject/${subject.id}`));
    subjectList.append(item);
  }
  markActiveNav();
}

export function markActiveNav() {
  const path = currentPath();
  for (const item of document.querySelectorAll(".sidebar [data-path]")) {
    if (item.dataset.path === path) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

export function setView(node) {
  closeAllModals();
  clear(outlet).append(node);
  outlet.scrollTo?.({ top: 0 });
  window.scrollTo({ top: 0 });
  markActiveNav();
}

export function viewPage(...children) {
  return el("div", { class: "page" }, ...children);
}

export async function createSubject() {
  const name = await showPrompt("ชื่อรายวิชา", { title: "สร้างรายวิชา", placeholder: "เช่น งานเชื่อมโลหะ ม.5" });
  if (!name) return;
  try {
    const created = await api.createSubject(name);
    await loadTree();
    navigate(`/subject/${created.id}`);
  } catch (err) {
    toastError(err);
  }
}
