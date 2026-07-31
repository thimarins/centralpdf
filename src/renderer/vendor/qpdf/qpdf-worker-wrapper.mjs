
import { parentPort } from 'worker_threads';
import fs from 'fs';
import path from 'path';

// Polyfill global scope for Emscripten in worker
global.self = global;
global.location = { href: '' };
global.document = { currentScript: null };
global.Worker = class MockWorker {};

// Polyfill fetch inside worker
global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.startsWith('file://')) {
    let filePath = urlStr.substring(7);
    if (filePath.startsWith('//')) {
      filePath = filePath.replace(/\//g, '\\');
    } else if (filePath.startsWith('/')) {
      filePath = filePath.substring(1).replace(/\//g, '\\');
    } else {
      filePath = filePath.replace(/\//g, '\\');
    }
    filePath = decodeURIComponent(filePath);
    const data = fs.readFileSync(filePath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': 'application/wasm' }
    });
  }
  return fetch(url);
};

// Polyfill postMessage/onmessage with queueing to avoid race condition during async import()
global.postMessage = (msg) => {
  parentPort.postMessage(msg);
};

let queuedMessages = [];
let onmessageHandler = null;

Object.defineProperty(global, 'onmessage', {
  get: () => onmessageHandler,
  set: (handler) => {
    onmessageHandler = handler;
    if (handler && queuedMessages.length > 0) {
      // console.log('Worker flushing ' + queuedMessages.length + ' queued messages.');
      queuedMessages.forEach(msg => handler({ data: msg }));
      queuedMessages = [];
    }
  }
});

parentPort.on('message', (msg) => {
  if (onmessageHandler) {
    onmessageHandler({ data: msg });
  } else {
    queuedMessages.push(msg);
  }
});

// Import the actual emscripten worker script
import('./qpdf.mjs');
