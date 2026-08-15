/* Hash routing: the server has no SPA catch-all, so a path-based router
   would 404 on reload. Hash keeps deep links and the back button working. */
const routes = [];
let notFound = () => {};

export function route(pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ regex, keys, handler });
}

export function setNotFound(handler) { notFound = handler; }

export function currentPath() {
  return location.hash.replace(/^#/, "") || "/";
}

export function navigate(path, { replace = false } = {}) {
  const target = "#" + path;
  if (location.hash === target) return resolve();
  if (replace) location.replace(target);
  else location.hash = target;
}

export function resolve() {
  const path = currentPath();
  for (const { regex, keys, handler } of routes) {
    const m = path.match(regex);
    if (!m) continue;
    const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return handler(params, path);
  }
  return notFound(path);
}

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  resolve();
}
