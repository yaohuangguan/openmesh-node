'use strict';
function node() { return { static: new Map(), param: null, wildcard: null, methods: new Map() }; }
class Router {
  constructor() { this.static = new Map(); this.root = node(); }
  add(method, path, route) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path)) throw new TypeError('Route path must start with / and cannot contain ? or #');
    const segments = path.slice(1).split('/'), names = [];
    let current = this.root, dynamic = false;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.includes(name)) throw new TypeError('Invalid or duplicate parameter name: ' + name);
        names.push(name); dynamic = true; current = current.param || (current.param = node());
      } else if (segment === '*') {
        if (i !== segments.length - 1) throw new TypeError('Wildcard must be the final path segment');
        names.push('*'); dynamic = true; current = current.wildcard || (current.wildcard = node());
      } else { if (segment.includes('*') || segment.includes(':')) throw new TypeError('Parameters must occupy a whole path segment'); if (!current.static.has(segment)) current.static.set(segment, node()); current = current.static.get(segment); }
    }
    if (current.methods.has(method)) throw new Error('Duplicate route: ' + method + ' ' + path);
    route.paramNames = names; current.methods.set(method, route);
    if (!dynamic) this.static.set(path, current);
  }
  find(path, method) {
    const exact = this.static.get(path);
    if (exact) {
      const route = pick(exact.methods, method);
      if (route) return { route, values: null };
    }
    const segments = path.slice(1).split('/');
    return search(this.root, segments, 0, method, []);
  }
  allowed(path) {
    const methods = new Set();
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) if (this.find(path, method)) methods.add(method);
    return [...methods];
  }
}
function pick(methods, method) { return methods.get(method) || (method === 'HEAD' ? methods.get('GET') : undefined) || methods.get('*'); }
function search(current, segments, index, method, values) {
  if (index === segments.length) {
    const route = pick(current.methods, method);
    if (route) return { route, values };
    if (current.wildcard) { const wildcard = pick(current.wildcard.methods, method); if (wildcard) return { route: wildcard, values: [...values, ''] }; }
    return null;
  }
  const segment = segments[index], fixed = current.static.get(segment);
  if (fixed) { const found = search(fixed, segments, index + 1, method, values); if (found) return found; }
  if (current.param && segment) { const found = search(current.param, segments, index + 1, method, [...values, segment]); if (found) return found; }
  if (current.wildcard) { const route = pick(current.wildcard.methods, method); if (route) return { route, values: [...values, segments.slice(index).join('/')] }; }
  return null;
}
module.exports = { Router };
