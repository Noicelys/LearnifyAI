import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

import { $ } from "./lib/dom.js";
import { api, setUnauthorizedHandler } from "./lib/api.js";
import { state, loadTree, loadRoster } from "./lib/store.js";
import { route, setNotFound, startRouter, navigate } from "./lib/router.js";
import { renderAuth } from "./views/auth.js";
import { mountShell } from "./views/shell.js";
import { showHome } from "./views/home.js";
import { showSubject } from "./views/subject.js";
import { showAssignment } from "./views/assignment.js";
import { showRoster } from "./views/roster.js";
import "./lib/theme.js";

function showGate() {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#gate").hidden = false;
  renderAuth(() => location.reload());
}

async function startApp() {
  $("#boot").hidden = true;
  $("#gate").hidden = true;
  mountShell();

  await Promise.all([loadTree().catch(() => {}), loadRoster().catch(() => {})]);

  route("/", showHome);
  route("/subject/:id", ({ id }) => showSubject(id));
  route("/assignment/:id", ({ id }) => showAssignment(id));
  route("/roster", showRoster);
  setNotFound(() => navigate("/", { replace: true }));
  startRouter();
}

async function boot() {
  setUnauthorizedHandler(() => {
    if (!$("#gate").hidden) return;
    showGate();
  });

  let me;
  try {
    me = await api.me();
  } catch {
    me = { teacher: false };
  }

  state.user = me.user || null;
  state.googleClientId = me.googleClientId || null;
  state.passwordConfigured = Boolean(me.passwordConfigured);

  if (me.teacher) await startApp();
  else showGate();
}

boot();
