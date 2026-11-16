const fs = require('node:fs');
const { threadId } = require('node:worker_threads');

if (process.env.CENTRAL_PDF_NETWORK_BLOCK_MARKER) {
  fs.appendFileSync(process.env.CENTRAL_PDF_NETWORK_BLOCK_MARKER, `${threadId}\n`);
}

const block = (name) => (...args) => {
  const target = args.find((value) => typeof value === 'string' || value instanceof URL);
  throw new Error(`NETWORK_BLOCKED_FOR_OFFLINE_TEST:${name}:${target ? String(target) : 'request'}`);
};

for (const moduleName of ['node:http', 'node:https', 'node:net', 'node:tls']) {
  const networkModule = require(moduleName);
  for (const method of ['request', 'get', 'connect', 'createConnection']) {
    if (typeof networkModule[method] === 'function') networkModule[method] = block(`${moduleName}.${method}`);
  }
}

if (typeof globalThis.fetch === 'function') globalThis.fetch = block('fetch');
