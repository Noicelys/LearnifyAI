import { $, el, clear } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { state } from "../lib/store.js";

const GOOGLE_SVG = `<svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true">
<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.66 0 6.58 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"/>
<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.58 42.62 14.66 48 24 48z"/></svg>`;

function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) score++;
  if (/[^\w\s]/.test(pw)) score++;
  return Math.min(score, 4);
}

function field(label, attrs) {
  const input = el("input", attrs);
  return { input, node: el("label", { class: "field" }, el("span", {}, label), input) };
}

export function renderAuth(onAuthenticated) {
  const gate = $("#gate");
  clear(gate);

  const msg = el("div", { class: "msg", role: "status", "aria-live": "polite" });

  // With a shared TEACHER_PASSWORD configured, the server accepts a password
  // with no email at all — so the field must not be required in that mode.
  const loginEmail = field("อีเมล", {
    type: "email",
    autocomplete: "email",
    placeholder: "teacher@school.ac.th",
    required: !state.passwordConfigured,
  });
  if (state.passwordConfigured) {
    loginEmail.node.append(el("span", { class: "hint" }, "เว้นว่างได้ถ้าใช้รหัสผ่านกลางของโรงเรียน"));
  }
  const loginPw = field("รหัสผ่าน", { type: "password", autocomplete: "current-password", required: true });
  const loginBtn = el("button", { class: "btn btn-lg", type: "submit" }, "เข้าสู่ระบบ");
  const loginForm = el("form", { class: "stack" }, loginEmail.node, loginPw.node, loginBtn);

  const regName = field("ชื่อ-นามสกุล", { type: "text", autocomplete: "name", placeholder: "สมชาย ใจดี", required: true });
  const regEmail = field("อีเมล", { type: "email", autocomplete: "email", placeholder: "teacher@school.ac.th", required: true });
  const regPw = field("รหัสผ่าน", { type: "password", autocomplete: "new-password", placeholder: "อย่างน้อย 8 ตัวอักษร", required: true, minLength: 8 });
  const meterBars = [0, 1, 2, 3].map(() => el("div"));
  const meter = el("div", { class: "pw-meter" }, meterBars);
  const meterHint = el("span", { class: "hint" }, "ผสมตัวอักษร ตัวเลข และสัญลักษณ์จะปลอดภัยขึ้น");
  regPw.node.append(meter, meterHint);
  const regPw2 = field("ยืนยันรหัสผ่าน", { type: "password", autocomplete: "new-password", required: true });
  const regBtn = el("button", { class: "btn btn-lg", type: "submit" }, "สร้างบัญชี");
  const registerForm = el("form", { class: "stack", hidden: true }, regName.node, regEmail.node, regPw.node, regPw2.node, regBtn);

  regPw.input.addEventListener("input", () => {
    const score = passwordStrength(regPw.input.value);
    meterBars.forEach((bar, i) => {
      bar.className = i < score ? `on-${score}` : "";
    });
  });

  const tabLogin = el("button", { type: "button", "aria-selected": "true" }, "เข้าสู่ระบบ");
  const tabRegister = el("button", { type: "button", "aria-selected": "false" }, "สมัครสมาชิก");
  const segmented = el("div", { class: "segmented", role: "tablist" }, tabLogin, tabRegister);

  const switchTo = (mode) => {
    const login = mode === "login";
    tabLogin.setAttribute("aria-selected", String(login));
    tabRegister.setAttribute("aria-selected", String(!login));
    loginForm.hidden = !login;
    registerForm.hidden = login;
    msg.textContent = "";
    msg.className = "msg";
  };
  tabLogin.addEventListener("click", () => switchTo("login"));
  tabRegister.addEventListener("click", () => switchTo("register"));

  const fail = (text) => {
    msg.textContent = text;
    msg.className = "msg err";
  };

  loginForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    loginBtn.disabled = true;
    msg.textContent = "";
    try {
      const email = loginEmail.input.value.trim();
      await api.login(email ? { email, password: loginPw.input.value } : { password: loginPw.input.value });
      onAuthenticated();
    } catch (err) {
      fail(err.message);
    } finally {
      loginBtn.disabled = false;
    }
  });

  registerForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (regPw.input.value !== regPw2.input.value) return fail("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    regBtn.disabled = true;
    msg.textContent = "";
    try {
      await api.register({
        fullName: regName.input.value.trim(),
        email: regEmail.input.value.trim(),
        password: regPw.input.value,
      });
      onAuthenticated();
    } catch (err) {
      fail(err.message);
    } finally {
      regBtn.disabled = false;
    }
  });

  const googleBtn = el(
    "a",
    { class: "btn-google", href: "/api/auth/google", id: "btn-google-login" },
    el("span", { html: GOOGLE_SVG }),
    el("span", {}, "ดำเนินการต่อด้วย Google")
  );

  const card = el(
    "div",
    { class: "auth-card" },
    el(
      "div",
      { class: "stack-sm" },
      // ใช้ตัว 512 เพราะกล่องนี้กว้าง 104px จอ 2x เลยต้องการภาพต้นทางใหญ่กว่า 192
      el("img", { class: "brand-mark brand-mark-lg", src: "/icon-512.webp", alt: "LearnifyAI", width: 104, height: 104, decoding: "async" }),
      el("h1", {}, "LearnifyAI"),
      el("p", { class: "muted" }, "พิสูจน์ความเข้าใจจริง ไม่ใช่จับผิด AI")
    ),
    segmented,
    googleBtn,
    el("div", { class: "divider" }, "หรือใช้อีเมล"),
    loginForm,
    registerForm,
    msg,
    el("p", { class: "hint", style: "text-align:center" }, "สำหรับคุณครูและผู้ดูแลระบบเท่านั้น")
  );

  gate.append(
    el(
      "div",
      { class: "auth" },
      el(
        "aside",
        { class: "auth-hero" },
        el("span", { class: "eyebrow" }, "LearnifyAI"),
        el("h1", {}, "ให้นักเรียนอธิบายงานของตัวเอง แล้วดูว่าตรงกับงานจริงไหม"),
        el(
          "ul",
          { class: "auth-hero-list" },
          el("li", {}, "ดึงงานจาก Google Drive ได้"),
          el("li", {}, "ถอดเสียงคำอธิบายอัตโนมัติ แล้วเทียบกับชิ้นงาน"),
          el("li", {}, "ผลตรวจมีเหตุผลกำกับเสมอ และครูแก้คะแนนได้ตลอด")
        )
      ),
      el("div", { class: "auth-panel" }, card)
    )
  );

  initGoogleOneTap(googleBtn);
}

function initGoogleOneTap(googleBtn) {
  const clientId = state.googleClientId;
  if (!clientId) {
    googleBtn.hidden = true;
    return;
  }
  googleBtn.hidden = false;

  // Popup keeps the teacher on the page; the redirect href is the no-JS fallback.
  googleBtn.addEventListener("click", (ev) => {
    const popup = window.open("/api/auth/google", "google-login", "width=480,height=640");
    if (!popup) return; // blocked — let the href navigate instead
    ev.preventDefault();
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        location.reload();
      }
    }, 500);
  });

  if (!window.google?.accounts?.id) return;
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      try {
        await api.googleCredential(credential);
        location.reload();
      } catch {
        /* fall back to the button */
      }
    },
  });
  window.google.accounts.id.prompt();
}
