export function createAppState() {
  return {
    appMeta: null,
    appConfig: null,
    runtimeColorTheme: "blue",
    activeTab: "dashboard",
    dashboardSelectedPdfFile: null,
    dashboardAutoRouteOnPick: false,
    feedbackBannerMode: "",
    queueSnapshot: [],
    operationOutputDirs: {},

    imagePdfFiles: [],
    imagePdfDragIndex: null,
    imagePdfSelectedIndex: null,
    imagePdfOptimizedMode: false,
    imagePdfUndoStack: [],

    mergeFiles: [],
    selectedSplitFile: null,
    selectedCompressFile: null,
    pdfToWordFile: null,
    ocrFiles: [],
    ocrRuntime: null,

    signatureFile: null,
    signaturePdfDoc: null,
    signaturePageCount: 0,
    signatureCurrentPageIndex: 0,
    signatureFields: [],
    signatureSelectedFieldId: "",
    signatureSealFile: null,
    signatureSealPreviewUrl: "",
    signatureDrawnDataUrl: "",
    signatureDrawHasInk: false,

    watermarkFiles: [],
    watermarkImageFile: null,
    watermarkPreviewIndex: 0,
    watermarkPreviewPageIndex: 0,
    watermarkPreviewPageCount: 0,
    watermarkPreviewImageDataUrl: "",
    watermarkPreviewImageElement: null,

    protectFile: null,
    unlockFile: null,

    redactFile: null,
    redactPdfBytes: null,
    redactPdfDoc: null,
    redactPageCount: 0,
    redactCurrentPageIndex: 0,
    redactBoxes: [],
    redactSelectedBoxId: "",
    redactTempPaths: [],

    organizeFiles: [],
    organizePdfDocs: [],
    organizePages: [],
    organizeRenderedPageIds: [],
    organizeLowMemoryMode: false,
    organizeUndoStack: [],
    organizeRedoStack: [],
    organizeTempPaths: [],
    organizeSelection: new Set(),
    organizeLastSelectedId: null,
    organizeObserver: null,
    organizeBookmarks: [],
    organizeDrag: {
      ids: [],
      sourceId: null,
      placeholderIndex: null
    }
  };
}

export const APP_STATE_KEYS = Object.freeze(Object.keys(createAppState()));
