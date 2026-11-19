/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const args = isMain ? process.argv.slice(2) : [];
if (args.includes('--help')) {
  console.log('Usage: node fake-openai-provider.mjs [--port 11434] [--reply "Thunderbolt validation reply."]\nLoopback-only OpenAI-compatible /v1/models and /v1/chat/completions (JSON + SSE). Permissive CORS. Logs method/path/status only. No key needed; use a disposable dummy key. Side effect: listens until SIGINT/SIGTERM.');
  process.exit(0);
}
const options = { port: '11434', reply: 'Thunderbolt validation reply, one word at a time.' };
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]?.slice(2);
  if (!['--port', '--reply'].includes(args[i]) || args[i + 1] === undefined) {
    console.error('Use --port NUMBER and/or --reply TEXT; see --help.'); process.exit(2);
  }
  options[name] = args[i + 1];
}
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !options.reply.trim()) {
  console.error('Port must be 1..65535 and reply must be nonempty.'); process.exit(2);
}
const model = 'thunder-validate-fake';
/** Serve deterministic OpenAI-compatible responses without retaining request credentials. */
export const handleRequest = async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  // Log a fixed known path only: arbitrary URLs can contain credentials.
  res.on('finish', () => console.log(`${req.method} ${['/v1/models', '/v1/chat/completions'].includes(pathname) ? pathname : '/unknown'} ${res.statusCode}`));
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && pathname === '/v1/models') {
    json(200, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'local-validation' }] }); return;
  }
  if (req.method !== 'POST' || pathname !== '/v1/chat/completions') { json(404, { error: { message: 'Use /v1/models or /v1/chat/completions' } }); return; }
  let body;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) { json(413, { error: { message: 'Local fake accepts up to 1 MiB' } }); return; }
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch { json(400, { error: { message: 'Send a JSON object' } }); return; }
  const common = { id: 'chatcmpl-validation', created: 0, model };
  if (!body.stream) {
    json(200, { ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: options.reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 } }); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  event({ role: 'assistant', content: '' });
  for (const word of options.reply.match(/\S+\s*/g)) {
    if (res.destroyed) return;
    event({ content: word }); await delay(100);
  }
  if (res.destroyed) return;
  event({}, 'stop'); res.end('data: [DONE]\n\n');
};
if (isMain) {
  const server = createServer(handleRequest);
  server.on('error', error => {
    const action = ['EPERM', 'EACCES'].includes(error.code) ? 'This session forbids loopback listening; run in an authorized local terminal.' : 'Choose a free CSP-allowed port.';
    console.error(`Cannot listen on loopback port ${port} (${error.code}). ${action}`); process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
