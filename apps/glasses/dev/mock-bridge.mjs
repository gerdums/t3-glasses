import http from 'node:http';
const port = Number(process.env.PORT || 8787);
const now = () => new Date().toISOString();
const envs = [
  { id: 'studio', label: 'M4 Studio', connected: true, attention: { approval: 1, question: 1, failed: 0, running: 1 }, threadCount: 3 },
  { id: 'worker', label: 'M1 Worker', connected: true, attention: { approval: 0, question: 0, failed: 0, running: 0 }, threadCount: 0 },
];
const summaries = [
  { envId: 'studio', envLabel: 'M4 Studio', id: 'approval', title: 'Ship feature', projectTitle: 'T3', status: 'waiting', attention: 'approval', updatedAt: now(), preview: 'Approve command?' },
  { envId: 'studio', envLabel: 'M4 Studio', id: 'question', title: 'Choose design', projectTitle: 'T3', status: 'waiting', attention: 'question', updatedAt: now(), preview: 'Which layout?' },
  { envId: 'studio', envLabel: 'M4 Studio', id: 'running', title: 'Run tests', projectTitle: 'T3', status: 'running', attention: 'running', updatedAt: now(), preview: 'Testing' },
];
const pending = {
  approval: { kind: 'approval', requestId: 'request-approval', requestKind: 'command', prompt: '$ npm run build', options: [{ decision: 'accept', label: 'Approve' }, { decision: 'acceptForSession', label: 'Approve for session' }, { decision: 'decline', label: 'Deny' }] },
  question: { kind: 'question', requestId: 'request-question', questions: [{ id: 'layout', question: 'Which layout?', options: [{ label: 'Compact' }, { label: 'Spacious' }], multiSelect: false }] },
};
const detail = id => { const summary = summaries.find(t => t.id === id); return summary && { ...summary, messages: [{ role: 'user', text: 'Please take care of this.', at: now() }, { role: 'assistant', text: summary.preview, at: now() }], ...(pending[id] ? { pending: pending[id] } : {}), ...(id === 'running' ? { activity: '$ npm test' } : {}), canInterrupt: id === 'running' }; };
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(value)); };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, version: 'mock', protocol: 1, transcription: true });
  if (url.pathname === '/api/envs') return json(res, 200, { envs });
  if (url.pathname === '/api/threads') return json(res, 200, { threads: summaries.filter(t => !url.searchParams.has('env') || t.envId === url.searchParams.get('env')).slice(0, Number(url.searchParams.get('limit') || 20)) });
  if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' }); res.write(`event: envs\ndata: ${JSON.stringify({ type: 'envs', envs })}\n\n`); const keep = setInterval(() => res.write(': keepalive\n\n'), 15000); req.on('close', () => clearInterval(keep)); return; }
  if (url.pathname === '/api/transcribe' && req.method === 'POST') { for await (const _ of req) { /* drain PCM */ } return json(res, 200, { text: 'Mock dictated message' }); }
  const match = /^\/api\/envs\/([^/]+)\/threads\/([^/]+)(?:\/(messages|approval|answer|interrupt))?$/.exec(url.pathname);
  if (match) {
    const [, env, id, action] = match;
    if (env !== 'studio' || !detail(id)) return json(res, 404, { ok: false, error: 'Thread not found' });
    if (!action && req.method === 'GET') return json(res, 200, detail(id));
    if (action && req.method === 'POST') { for await (const _ of req) { /* drain body */ } return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { ok: false, error: 'Route not found' });
}).listen(port, '127.0.0.1', () => console.log(`Mock bridge listening at http://localhost:${port}`));
