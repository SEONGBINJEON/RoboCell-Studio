import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, relative, isAbsolute } from 'node:path';

const defaultRoot = fileURLToPath(new URL('../web/', import.meta.url));
const DEFAULT_ISAAC_URL = 'http://192.168.0.19:8210';
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
};

function json(res, status, data, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(data));
}

export function validateIsaacBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ISAAC_BASE_URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('ISAAC_BASE_URL must be an HTTP(S) origin without credentials, query or path.');
  }
  return url;
}

function allowedMethod(path) {
  if (['/health', '/api/status', '/stream.mjpg', '/frame.jpg'].includes(path)) return 'GET';
  if (/^\/api\/jobs\/[A-Za-z0-9_-]{3,64}$/.test(path)) return 'GET';
  if (['/api/factory', '/api/control'].includes(path) || /^\/api\/jobs\/[A-Za-z0-9_-]{1,100}\/(?:start|stop)$/.test(path)) return 'POST';
  return null;
}

function matchesLocalHost(req, port) {
  try {
    const h = new URL(`http://${req.headers.host || ''}`);
    return ['127.0.0.1', 'localhost'].includes(h.hostname) && Number(h.port || 80) === port && !h.username && !h.password;
  } catch { return false; }
}

function matchesOrigin(req, port) {
  const value = req.headers.origin;
  if (!value) return req.method === 'GET' || req.method === 'HEAD';
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
      Number(origin.port || 80) === port && origin.host === req.headers.host && origin.origin === value;
  } catch { return false; }
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  let data;
  try { data = JSON.parse(raw); } catch { throw Object.assign(new Error('Valid JSON is required.'), { status: 400, code: 'INVALID_JSON' }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('A JSON object is required.'), { status: 400, code: 'INVALID_JSON' });
  return Buffer.from(JSON.stringify(data));
}

function proxyRequest(req, res, upstream, path, search, body, timeoutMs, service = 'ISAAC') {
  const url = new URL(path, upstream);
  url.search = search;
  const streaming = path === '/stream.mjpg';
  const request = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { Accept: path.endsWith('.jpg') ? 'image/jpeg' : streaming ? 'multipart/x-mixed-replace' : 'application/json' };
  if(service==='AI' && req.headers.origin)headers.Origin=req.headers.origin;
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
  let response;
  let timedOut = false;
  const proxy = request(url, { method: req.method, headers }, incoming => {
    response = incoming;
    if (streaming) clearTimeout(timer);
    const outgoing = { 'Content-Type': incoming.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };
    if (incoming.headers['content-length']) outgoing['Content-Length'] = incoming.headers['content-length'];
    res.writeHead(incoming.statusCode || 502, outgoing);
    incoming.pipe(res);
    incoming.on('end', () => clearTimeout(timer));
    incoming.on('error', () => { clearTimeout(timer); if (!res.destroyed) res.destroy(); });
  });
  const timer = setTimeout(() => { timedOut = true; proxy.destroy(new Error('Isaac request timed out')); }, timeoutMs);
  proxy.on('error', error => {
    clearTimeout(timer);
    if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
    json(res, timedOut ? 504 : 502, {
      ok: false, code: timedOut ? `${service}_TIMEOUT` : `${service}_UNREACHABLE`,
      message: service==='AI'?'AI 서비스에 연결할 수 없습니다. 서버 연결을 확인해 주세요.':timedOut ? 'Isaac Sim 서버의 응답 시간이 초과되었습니다.' : 'Isaac Sim 서버에 연결할 수 없습니다. 5090 PC의 플랫폼 실행 상태를 확인해 주세요.',
      detail: ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code) ? error.code : 'CONNECTION_FAILED',
    });
  });
  res.on('close', () => { clearTimeout(timer); proxy.destroy(); response?.destroy(); });
  if (body) proxy.write(body);
  proxy.end();
}

/** Local-only preview and fixed-destination gateway. Launch never starts a GPU job. */
export function createPreviewServer({ webRoot = defaultRoot, isaacBaseUrl = process.env.ISAAC_BASE_URL || DEFAULT_ISAAC_URL,
  aiBaseUrl = process.env.AI_BASE_URL, proxyTimeoutMs = 8000, maxBodyBytes = 1024 * 1024 } = {}) {
  const upstream = validateIsaacBaseUrl(isaacBaseUrl);
  const aiUpstream=aiBaseUrl?validateIsaacBaseUrl(aiBaseUrl):null;
  const root = resolve(webRoot);
  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    if (!matchesLocalHost(req, port)) { json(res, 403, { ok: false, code: 'INVALID_HOST' }); return; }
    let url, decoded;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
      decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid path');
    } catch { json(res, 400, { ok: false, code: 'INVALID_PATH' }); return; }
    if(decoded.startsWith('/api/ai/')){
      if(!matchesOrigin(req,port)){json(res,403,{ok:false,code:'ORIGIN_DENIED'});return;}
      const method=decoded==='/api/ai/status'?'GET':['/api/ai/assist','/api/ai/report'].includes(decoded)?'POST':null;
      if(!method){json(res,404,{ok:false,code:'AI_ROUTE_NOT_ALLOWED'});return;}
      if(req.method!==method){json(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'},{Allow:method});return;}
      if(!aiUpstream){json(res,method==='GET'?200:503,{configured:false,available:false,model_checked:false,provider:'aws-bedrock',mode:'unconfigured',error:'AI 서비스가 구성되지 않았습니다.'});return;}
      let body;if(method==='POST'){
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{error:'JSON_REQUIRED'});return;}
        try{body=await readJsonBody(req,196608);}catch(error){json(res,error.status||400,{error:error.code});return;}
      }
      proxyRequest(req,res,aiUpstream,decoded,'',body,55000,'AI');return;
    }
    if (decoded.startsWith('/isaac/')) {
      if (!matchesOrigin(req, port)) { json(res, 403, { ok: false, code: 'ORIGIN_DENIED', message: '같은 로컬 스튜디오 화면에서 요청해 주세요.' }); return; }
      const path = decoded.slice('/isaac'.length);
      if (path === '/connection' && req.method === 'GET') {
        json(res, 200, { mode: 'local-gateway', configured: true, target: upstream.origin,
          healthPath: '/isaac/health', streamPath: '/isaac/stream.mjpg', statusPath: '/isaac/api/status' }); return;
      }
      const method = allowedMethod(path);
      if (!method) { json(res, 404, { ok: false, code: 'ISAAC_ROUTE_NOT_ALLOWED' }); return; }
      if (req.method !== method) { json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { Allow: method }); return; }
      let body;
      if (method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { json(res, 415, { ok: false, code: 'JSON_REQUIRED', message: 'Content-Type: application/json is required.' }); return; }
        if (Number(req.headers['content-length'] || 0) > maxBodyBytes) { json(res, 413, { ok: false, code: 'BODY_TOO_LARGE' }); return; }
        try { body = await readJsonBody(req, maxBodyBytes); }
        catch (error) { json(res, error.status || 400, { ok: false, code: error.code || 'INVALID_REQUEST', message: error.message }); return; }
      }
      proxyRequest(req, res, upstream, path, url.search, body, proxyTimeoutMs);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let candidate = decoded === '/' ? '/index.html' : decoded;
    if (!extname(candidate)) candidate += '.html';
    const path = resolve(root, '.' + candidate);
    const inside = relative(root, path);
    if (inside.startsWith('..') || isAbsolute(inside) || !types[extname(path)]) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const canonical = await realpath(path);
      const canonicalRoot = await realpath(root);
      const relativeReal = relative(canonicalRoot, canonical);
      if (relativeReal.startsWith('..') || isAbsolute(relativeReal)) throw new Error('Outside root');
      const info = await stat(canonical);
      if (!info.isFile()) throw new Error('Not a file');
      res.writeHead(200, { 'Content-Type': types[extname(path)], 'Content-Length': info.size,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(canonical);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ROBOCELL_PREVIEW_PORT || process.env.PORT || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Preview port must be 1-65535.');
  const server = createPreviewServer();
  server.on('error', error => { console.error(`Preview could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`RoboCell Studio: http://127.0.0.1:${port}\nIsaac gateway: /isaac (fixed operator-configured destination)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
