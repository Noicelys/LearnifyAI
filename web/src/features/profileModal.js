import { el } from "../lib/dom.js";
import { openModal, showConfirm } from "../lib/modal.js";
import { api } from "../lib/api.js";
import { state, notify } from "../lib/store.js";
import { toast, toastError } from "../lib/toast.js";
import { initials } from "../lib/format.js";

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/* Profile edits are two separate server calls (fields vs avatar file), so the
   avatar acts immediately and the text fields save on submit — a half-saved
   form is more confusing than two clear actions. */
export function openProfileModal() {
  const user = state.user || {};

  const avatarBox = el("span", { class: "avatar", style: "width:64px;height:64px;font-size:20px;overflow:hidden" });
  const showInitials = () => avatarBox.replaceChildren(initials(state.user?.name || state.user?.email));
  /* ใช้ <img> แทน background-image เพราะ CSS สั่ง referrerpolicy ไม่ได้ — รูปจาก Google
     ต้องส่งแบบ no-referrer ถึงจะโหลดผ่าน และ <img> ยังบอกได้ด้วยว่าโหลดพลาดเมื่อไหร่ */
  const paintAvatar = () => {
    if (!state.user?.picture) return showInitials();
    const img = el("img", {
      src: state.user.picture,
      alt: "",
      referrerpolicy: "no-referrer",
      style: "width:100%;height:100%;object-fit:cover;border-radius:50%",
    });
    img.addEventListener("error", showInitials);
    avatarBox.replaceChildren(img);
  };

  const fileInput = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
  const pickBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "เปลี่ยนรูป");
  const removeBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "เอารูปออก");
  const avatarMsg = el("div", { class: "msg" });

  const setAvatarMsg = (text, kind = "err") => {
    avatarMsg.textContent = text;
    avatarMsg.className = `msg ${kind}`;
  };

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;

    // ตรวจฝั่งนี้ก่อนเพื่อไม่ให้ครูรออัปโหลด 10MB แล้วค่อยโดนเซิร์ฟเวอร์ปฏิเสธ
    if (!ALLOWED_TYPES.includes(file.type)) return setAvatarMsg("รองรับเฉพาะไฟล์ JPG, PNG, WebP หรือ GIF");
    if (file.size > MAX_AVATAR_BYTES) return setAvatarMsg("ไฟล์ใหญ่เกิน 10 MB");

    pickBtn.disabled = true;
    setAvatarMsg("กำลังอัปโหลด…", "");
    try {
      const form = new FormData();
      form.append("avatar", file);
      const res = await api.uploadAvatar(form);
      // ต่อ query ท้าย URL เพราะชื่อไฟล์เดิมอาจถูกเบราว์เซอร์แคชไว้
      state.user = { ...state.user, picture: `${res.pictureUrl}?t=${Date.now()}` };
      paintAvatar();
      renderRemoveBtn();
      notify("user");
      setAvatarMsg("เปลี่ยนรูปแล้ว", "ok");
    } catch (err) {
      setAvatarMsg(err.message);
    } finally {
      pickBtn.disabled = false;
    }
  });

  removeBtn.addEventListener("click", async () => {
    const ok = await showConfirm("เอารูปโปรไฟล์ออก แล้วกลับไปใช้อักษรย่อของชื่อแทน", {
      title: "เอารูปออก",
      okLabel: "เอารูปออก",
      danger: true,
    });
    if (!ok) return;
    removeBtn.disabled = true;
    try {
      await api.removeAvatar();
      state.user = { ...state.user, picture: null };
      paintAvatar();
      renderRemoveBtn();
      notify("user");
      setAvatarMsg("เอารูปออกแล้ว", "ok");
    } catch (err) {
      setAvatarMsg(err.message);
    } finally {
      removeBtn.disabled = false;
    }
  });

  const renderRemoveBtn = () => {
    removeBtn.hidden = !state.user?.picture || !state.user?.dbId;
  };

  const name = el("input", { type: "text", value: user.name || "", required: true, autocomplete: "name" });
  const title = el("input", { type: "text", value: user.title || "", placeholder: "เช่น ครูชำนาญการ" });
  const department = el("input", { type: "text", value: user.department || "", placeholder: "เช่น แผนกวิชาช่างเชื่อมโลหะ" });

  const msg = el("div", { class: "msg" });
  const save = el("button", { class: "btn", type: "submit", form: "profile-form" }, "บันทึก");

  const form = el(
    "form",
    { class: "stack", id: "profile-form" },
    el("label", { class: "field" }, el("span", {}, "ชื่อ-นามสกุล"), name),
    el(
      "div",
      { class: "field-row" },
      el("label", { class: "field" }, el("span", {}, "ตำแหน่ง"), title),
      el("label", { class: "field" }, el("span", {}, "แผนกวิชา"), department)
    ),
    el("label", { class: "field" }, el("span", {}, "อีเมล"), el("input", { type: "text", value: user.email || "", readOnly: true, disabled: true })),
    el("p", { class: "hint" }, "อีเมลเปลี่ยนไม่ได้ เพราะเป็นตัวผูกงานและรายชื่อนักเรียนทั้งหมดของบัญชีนี้"),
    msg
  );

  // เข้าระบบด้วยรหัสผ่านกลางของโรงเรียนจะไม่มีบัญชีในฐานข้อมูลให้ผูกโปรไฟล์
  // บอกตั้งแต่แรกดีกว่าปล่อยให้กรอกจนเสร็จแล้วค่อยเด้งว่าไม่พบบัญชี
  const shared = !user.dbId;
  if (shared) {
    for (const control of [name, title, department, pickBtn, removeBtn]) control.disabled = true;
  }

  const modal = openModal({
    title: "โปรไฟล์ของฉัน",
    body: el(
      "div",
      { class: "stack" },
      shared
        ? el(
            "div",
            { class: "alert warn" },
            "บัญชีนี้เข้าระบบด้วยรหัสผ่านกลางของโรงเรียน จึงยังไม่มีโปรไฟล์ส่วนตัว — สมัครบัญชีด้วยอีเมล หรือเข้าด้วย Google เพื่อแก้ไขข้อมูลนี้"
          )
        : null,
      el(
        "div",
        { class: "row" },
        avatarBox,
        el("div", { class: "stack-sm" }, el("div", { class: "row-tight" }, pickBtn, removeBtn, fileInput), avatarMsg)
      ),
      form
    ),
    footer: [save],
  });

  save.disabled = shared;
  paintAvatar();
  renderRemoveBtn();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    save.disabled = true;
    msg.textContent = "";
    msg.className = "msg";
    try {
      const res = await api.updateProfile({
        fullName: name.value.trim(),
        title: title.value.trim(),
        department: department.value.trim(),
      });
      // เก็บรูปที่เพิ่งอัปโหลดไว้ เพราะคำตอบของ endpoint นี้ให้ URL แบบไม่มีตัวกันแคช
      state.user = { ...state.user, ...res.user, picture: state.user?.picture || res.user.picture };
      notify("user");
      toast("บันทึกโปรไฟล์แล้ว");
      modal.close();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg err";
      save.disabled = false;
    }
  });
}
