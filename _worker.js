// Κωδικοί QR — αποθήκευση αρχείων / file storage (Cloudflare Pages Function + KV)
// Ένα μόνο αρχείο: βάλ' το δίπλα στο index.html / single file next to index.html
// Χρειάζεται / Needs:  KV binding  QR_KV   και   μεταβλητή / variable  UPLOAD_PIN
const CHUNK = 4 * 1024 * 1024;          // 4 MB κάθε κομμάτι
const MAX_FILE = 50 * 1024 * 1024;      // 50 MB ανά αρχείο
const MAX_ITEM = 100 * 1024 * 1024;     // 100 MB ανά κωδικό
const MAX_FILES = 20;
const MAX_TEXT = 2 * 1024 * 1024;       // 2 MB κείμενο
const INLINE = /^(image\/(png|jpeg|gif|webp|heic|heif|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain|application\/msword|application\/vnd\.openxmlformats-officedocument\.[\w.]+)$/i;

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const ERR = (code, s = 400) => J({ ok: false, error: code }, s);

function rid(n) {
  const a = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = ""; for (const x of b) s += a[x % a.length]; return s;
}
function pinOk(req, env) {
  const want = String(env.UPLOAD_PIN || ""), got = String(req.headers.get("x-pin") || "");
  if (!want || got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}
const cleanName = (n) => String(n || "file").replace(/[\u0000-\u001f\/\\:*?"<>|]+/g, "_").slice(0, 120) || "file";
const cleanType = (t) => /^[\w.+-]+\/[\w.+-]+$/.test(String(t || "")) ? String(t).toLowerCase() : "application/octet-stream";

async function getItem(env, id) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return null;
  const raw = await env.QR_KV.get("m:" + id);
  return raw ? JSON.parse(raw) : null;
}

async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const url = new URL(req.url), M = req.method;
  const kvOk = !!env.QR_KV;

  try {
    // GET /api/ping
    if (parts[0] === "ping") return J({ ok: true, storage: kvOk, upload: kvOk && !!env.UPLOAD_PIN });

    if (!kvOk) return ERR("no_storage", 503);

    // POST /api/pin   — έλεγχος κωδικού
    if (parts[0] === "pin" && M === "POST") return J({ ok: pinOk(req, env) });

    // POST /api/item   — νέο / create
    if (parts[0] === "item" && parts.length === 1 && M === "POST") {
      if (!env.UPLOAD_PIN) return ERR("no_pin_set", 503);
      if (!pinOk(req, env)) return ERR("bad_pin", 403);
      const b = await req.json();
      const text = String(b.text || "");
      if (text.length > MAX_TEXT) return ERR("text_too_big", 413);
      const files = Array.isArray(b.files) ? b.files : [];
      if (files.length > MAX_FILES) return ERR("too_many_files", 413);
      let total = 0;
      const fl = files.map((f) => {
        const size = Math.max(0, Math.floor(Number(f.size) || 0));
        total += size;
        return { name: cleanName(f.name), type: cleanType(f.type), size, chunks: Math.max(1, Math.ceil(size / CHUNK)) };
      });
      if (fl.some((f) => f.size > MAX_FILE)) return ERR("file_too_big", 413);
      if (total > MAX_ITEM) return ERR("item_too_big", 413);
      if (!text && !fl.length) return ERR("empty");
      const id = rid(10);
      const meta = { id, v: 1, title: String(b.title || "").slice(0, 200), text, lang: String(b.lang || "").slice(0, 5),
        files: fl, created: Date.now(), done: false };
      await env.QR_KV.put("m:" + id, JSON.stringify(meta), { expirationTtl: 86400 });
      return J({ ok: true, id, chunk: CHUNK, files: fl });
    }

    // PUT /api/item/ID/F/N  — κομμάτι αρχείου / chunk
    if (parts[0] === "item" && parts.length === 4 && M === "PUT") {
      if (!pinOk(req, env)) return ERR("bad_pin", 403);
      const [, id, fs, ns] = parts, f = +fs, n = +ns;
      const meta = await getItem(env, id);
      if (!meta || meta.done) return ERR("not_found", 404);
      const file = meta.files[f];
      if (!file || !(n >= 0 && n < file.chunks)) return ERR("bad_chunk");
      const buf = await req.arrayBuffer();
      const expect = n < file.chunks - 1 ? CHUNK : file.size - CHUNK * (file.chunks - 1);
      if (buf.byteLength !== expect && !(file.size === 0 && buf.byteLength === 0)) return ERR("bad_size");
      await env.QR_KV.put(`c:${id}:${f}:${n}`, buf);
      return J({ ok: true });
    }

    // POST /api/item/ID/finish
    if (parts[0] === "item" && parts.length === 3 && parts[2] === "finish" && M === "POST") {
      if (!pinOk(req, env)) return ERR("bad_pin", 403);
      const meta = await getItem(env, parts[1]);
      if (!meta) return ERR("not_found", 404);
      meta.done = true;
      // KV: μία εγγραφή ανά δευτερόλεπτο στο ίδιο κλειδί / one write per second per key
      const wait = 1100 - (Date.now() - meta.created);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { await env.QR_KV.put("m:" + meta.id, JSON.stringify(meta)); }
      catch (e) { await new Promise((r) => setTimeout(r, 1200)); await env.QR_KV.put("m:" + meta.id, JSON.stringify(meta)); }
      return J({ ok: true, id: meta.id });
    }

    // GET / DELETE /api/item/ID
    if (parts[0] === "item" && parts.length === 2) {
      const meta = await getItem(env, parts[1]);
      if (M === "DELETE") {
        if (!pinOk(req, env)) return ERR("bad_pin", 403);
        if (!meta) return J({ ok: true });
        const dels = [env.QR_KV.delete("m:" + meta.id)];
        meta.files.forEach((fl, f) => { for (let n = 0; n < fl.chunks; n++) dels.push(env.QR_KV.delete(`c:${meta.id}:${f}:${n}`)); });
        await Promise.all(dels);
        return J({ ok: true });
      }
      if (!meta || !meta.done) return ERR("not_found", 404);
      return J({ ok: true, id: meta.id, title: meta.title, text: meta.text, lang: meta.lang, created: meta.created,
        files: meta.files.map((x) => ({ name: x.name, type: x.type, size: x.size })) });
    }

    // GET /api/file/ID/F   — περιεχόμενο με Range / content with Range
    if (parts[0] === "file" && parts.length >= 3 && (M === "GET" || M === "HEAD")) {
      const meta = await getItem(env, parts[1]);
      const f = +parts[2];
      if (!meta || !meta.done || !meta.files[f]) return new Response("Not found", { status: 404 });
      const file = meta.files[f], size = file.size;
      const inline = INLINE.test(file.type) && !url.searchParams.has("dl");
      const h = new Headers({
        "content-type": INLINE.test(file.type) ? file.type : "application/octet-stream",
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "content-disposition": (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(file.name)
      });
      let a = 0, b = size - 1, status = 200;
      const r = req.headers.get("range");
      if (r && size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(r.trim());
        if (m) {
          if (m[1] === "" && m[2] !== "") { a = Math.max(0, size - +m[2]); }
          else { a = +m[1]; if (m[2] !== "") b = Math.min(+m[2], size - 1); }
          if (a > b || a >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
          status = 206; h.set("content-range", `bytes ${a}-${b}/${size}`);
        }
      }
      const len = size === 0 ? 0 : b - a + 1;
      h.set("content-length", String(len));
      if (M === "HEAD" || len === 0) return new Response(null, { status, headers: h });

      const { readable, writable } = new FixedLengthStream(len);
      const w = writable.getWriter();
      (async () => {
        try {
          const first = Math.floor(a / CHUNK), last = Math.floor(b / CHUNK);
          for (let n = first; n <= last; n++) {
            const cs = n * CHUNK, ce = Math.min(cs + CHUNK, size) - 1;
            const from = Math.max(a, cs) - cs, to = Math.min(b, ce) - cs;
            const key = `c:${meta.id}:${f}:${n}`;
            if (from === 0 && to === ce - cs) {
              const s = await env.QR_KV.get(key, { type: "stream" });
              if (!s) throw new Error("missing");
              const rd = s.getReader();
              for (;;) { const { done, value } = await rd.read(); if (done) break; await w.write(value); }
            } else {
              const buf = await env.QR_KV.get(key, { type: "arrayBuffer" });
              if (!buf) throw new Error("missing");
              await w.write(new Uint8Array(buf, from, to - from + 1));
            }
          }
          await w.close();
        } catch (e) { try { await w.abort(e); } catch (_) {} }
      })();
      return new Response(readable, { status, headers: h });
    }

    return ERR("not_found", 404);
  } catch (e) {
    return ERR("server_error: " + (e && e.message || e), 500);
  }
}

// Κεντρική είσοδος / main entry (Cloudflare Pages "_worker.js")
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, params: { path }, waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (url.pathname === "/_worker.js") return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  }
};
