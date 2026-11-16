const fs = require('fs');
const path = require('path');

const PDF_RANGE_CHUNK_SIZE = 64 * 1024;

async function readExact(fileHandle, position, length, isCancelled = () => false) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    if (isCancelled()) throw new Error('OPERATION_CANCELLED');
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('O PDF foi reduzido ou ficou indisponível durante a leitura.');
    offset += bytesRead;
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function openPdfJsDocumentFromFile(pdfjs, filePath, options = {}, isCancelled = () => false) {
  const fileHandle = await fs.promises.open(filePath, 'r');
  let closed = false;
  let aborted = false;
  let loadingTask = null;
  let ioError = null;
  let bytesRead = 0;
  const requestedRanges = [];

  const readChunk = async (position, length) => {
    const chunk = await readExact(fileHandle, position, length, isCancelled);
    bytesRead += chunk.byteLength;
    return chunk;
  };

  try {
    const initialStats = await fileHandle.stat();
    if (!initialStats.isFile() || initialStats.size < 1) throw new Error('O PDF está vazio ou não é um arquivo válido.');
    const length = initialStats.size;
    const initialLength = Math.min(PDF_RANGE_CHUNK_SIZE, length);
    const initialData = await readChunk(0, initialLength);

    class LocalPdfRangeTransport extends pdfjs.PDFDataRangeTransport {
      constructor() {
        super(length, initialData, initialLength === length, path.basename(filePath));
      }

      requestDataRange(begin, end) {
        if (closed || aborted) return;
        if (isCancelled()) {
          aborted = true;
          ioError = new Error('OPERATION_CANCELLED');
          void loadingTask?.destroy?.().catch(() => {});
          return;
        }
        requestedRanges.push({ begin, end });
        void (async () => {
          try {
            if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > length) {
              throw new Error('O PDF.js solicitou um intervalo inválido do arquivo.');
            }
            const bytes = await readChunk(begin, end - begin);
            // A file read can finish after the caller cancels. Check again
            // before handing the bytes to PDF.js so a completed in-flight
            // range cannot revive work that the user already stopped.
            if (isCancelled()) {
              aborted = true;
              ioError = new Error('OPERATION_CANCELLED');
              void loadingTask?.destroy?.().catch(() => {});
              return;
            }
            if (!closed && !aborted) this.onDataRange(begin, bytes);
          } catch (error) {
            ioError = error;
            try { this.onDataRange(begin, new Uint8Array(0)); } catch {}
            void loadingTask?.destroy?.().catch(() => {});
          }
        })();
      }

      abort() {
        aborted = true;
      }
    }

    const range = new LocalPdfRangeTransport();
    loadingTask = pdfjs.getDocument({
      ...options,
      range,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      disableStream: true,
      disableAutoFetch: true,
      disableWorker: true
    });
    return {
      loadingTask,
      getReadError: () => ioError,
      getBytesRead: () => bytesRead,
      getRequestedRanges: () => requestedRanges.slice(),
      close: async () => {
        if (closed) return;
        closed = true;
        await fileHandle.close();
      }
    };
  } catch (error) {
    closed = true;
    await fileHandle.close().catch(() => {});
    throw error;
  }
}

module.exports = { PDF_RANGE_CHUNK_SIZE, openPdfJsDocumentFromFile };
