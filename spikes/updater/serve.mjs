// 0.0.2 のインストーラーと latest.json をローカルで配る（DESIGN.md §28 GUI の自動更新の実測）。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const PORT = 8765;
const [installer, version] = process.argv.slice(2);
const name = basename(installer);
const latest = {
  version,
  notes: 'spike',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      url: `http://127.0.0.1:${PORT}/${encodeURIComponent(name)}`,
      signature: readFileSync(`${installer}.sig`, 'utf8'),
    },
  },
};
createServer((request, response) => {
  console.log(new Date().toISOString(), request.method, request.url);
  if (request.url === '/latest.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(latest));
    return;
  }
  if (decodeURIComponent(request.url ?? '') === `/${name}`) {
    response.end(readFileSync(installer));
    return;
  }
  response.statusCode = 404;
  response.end();
}).listen(PORT, '127.0.0.1');
