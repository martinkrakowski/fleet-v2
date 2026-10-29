#!/usr/bin/env node
// Lane Q1a: standalone fake opencode v2 server for the conductor end-to-end
// fixture. Plain Node with no dependencies. It implements exactly what
// `ocm-run --detach`, `--status` and `--abort` call, plus the test-only
// `POST /__start/<id>` and `GET /__state`. It listens on 127.0.0.1 port 0,
// prints `port=<n>` once, and serves until TERM.

import http from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** id -> { state: 'created' | 'busy', directory } */
const sessions = new Map();
const interrupts = [];
const createdIds = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  const send = (code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };
  void (async () => {
    try {
      if (url.pathname === '/api/info' && req.method === 'GET') {
        return send(200, { version: '2.0.28' });
      }
      if (
        parts.length === 2 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        req.method === 'POST'
      ) {
        let directory = '';
        try {
          directory = JSON.parse(await readBody(req))?.location?.directory ?? '';
        } catch {
          // Malformed body: fall through with an empty directory.
        }
        const id = `ses_it${createdIds.length + 1}`;
        createdIds.push(id);
        sessions.set(id, { state: 'created', directory });
        return send(200, { data: { id, location: { directory } } });
      }
      if (url.pathname === '/api/session/active' && req.method === 'GET') {
        const active = {};
        for (const [id, session] of sessions) {
          if (session.state === 'busy') active[id] = { type: 'busy' };
        }
        return send(200, { data: active });
      }
      if (
        parts.length === 3 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        parts[2].startsWith('ses_') &&
        req.method === 'GET'
      ) {
        const session = sessions.get(parts[2]);
        if (session === undefined) return send(404, { error: 'not found' });
        return send(200, {
          data: { id: parts[2], location: { directory: session.directory } },
        });
      }
      if (
        parts.length === 4 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        parts[3] === 'interrupt' &&
        req.method === 'POST'
      ) {
        interrupts.push(parts[2]);
        sessions.delete(parts[2]);
        return send(200, { interrupted: true });
      }
      if (parts.length === 2 && parts[0] === '__start' && req.method === 'POST') {
        const session = sessions.get(parts[1]);
        if (session === undefined) return send(404, { error: 'not found' });
        session.state = 'busy';
        return send(200, { started: true });
      }
      if (parts.length === 2 && parts[0] === '__end' && req.method === 'POST') {
        // A lane that ended: unlisted by /api/session/active, still readable
        // by GET /api/session/<id> for post-run assertions.
        const session = sessions.get(parts[1]);
        if (session === undefined) return send(404, { error: 'not found' });
        session.state = 'ended';
        return send(200, { ended: true });
      }
      if (url.pathname === '/__state' && req.method === 'GET') {
        const snapshot = {};
        for (const [id, session] of sessions) snapshot[id] = session.state;
        return send(200, { sessions: snapshot, interrupts, createdIds });
      }
      return send(404, { error: 'not found' });
    } catch {
      return send(500, { error: 'boom' });
    }
  })();
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address !== null && typeof address === 'object') {
    console.log(`port=${address.port}`);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
