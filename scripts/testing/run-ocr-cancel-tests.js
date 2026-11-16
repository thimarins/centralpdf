const assert = require('assert');
const { createPendingOcrCancelRegistry } = require('../../src/main/services/ocr/ocr-cancel-registry');

let currentTime = 100;
const registry = createPendingOcrCancelRegistry({ ttlMs: 50, maxEntries: 2, now: () => currentTime });

assert.strictEqual(registry.remember('cancel-before-start'), true);
assert.strictEqual(registry.consume('cancel-before-start'), true, 'cancelamento antecipado deve valer quando o processamento se registrar');
assert.strictEqual(registry.consume('cancel-before-start'), false, 'o pedido deve ser consumido uma única vez');

registry.remember('expira');
currentTime += 51;
assert.strictEqual(registry.consume('expira'), false, 'pedidos antigos não devem cancelar operações futuras');

registry.remember('primeiro');
registry.remember('segundo');
registry.remember('terceiro');
assert.strictEqual(registry.size, 2, 'registro de cancelamentos deve ter limite de memória');
assert.strictEqual(registry.consume('primeiro'), false, 'ao atingir o limite, o pedido mais antigo deve ser descartado');
assert.strictEqual(registry.consume('terceiro'), true);

console.log('OCR cancel tests passed: 4');
