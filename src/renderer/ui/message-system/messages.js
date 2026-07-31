const MESSAGE_CATALOG = {
  success: [
    "Operação concluída.",
    "Tudo certo.",
    "PDF processado com sucesso."
  ],
  successLarge: [
    "Terminamos. E honestamente, foi um PDF bem corajoso.",
    "Tudo pronto. Foram muitas páginas. Muitas mesmo.",
    "Operação concluída. Seu computador merece água agora."
  ],
  queued: [
    "Fila em andamento. Os PDFs serão processados em sequência para manter estabilidade.",
    "Tudo entrou na fila. Agora seguimos em ritmo seguro.",
    "Tarefa adicionada. Vamos priorizar estabilidade antes da pressa."
  ],
  warning: [
    "Detectamos um cenário que merece cuidado extra.",
    "Há um ponto de atenção nesta operação.",
    "Seguimos, mas com algumas proteções ativadas."
  ],
  giantPdf: [
    "Esse PDF é realmente enorme. Vamos abrir em modo otimizado para evitar travamentos.",
    "Detectamos um documento de grande porte. Reduzindo previews para manter estabilidade.",
    "Muita página chegando. Ativando modo de baixa memória."
  ],
  longRunning: [
    "Esse PDF é grande. Estamos processando com cuidado.",
    "Processando documentos gigantes. Isso pode levar alguns minutos.",
    "Muita página chegando. Ativando modo sobrevivência."
  ],
  retry: [
    "A operação encontrou resistência e vai tentar novamente.",
    "Houve uma falha parcial. Estamos repetindo com cuidado.",
    "Tentando mais uma vez antes de desistir."
  ],
  cancelled: [
    "Operação cancelada com segurança.",
    "Tudo bem. Interrompemos o processamento antes de avançar mais.",
    "Cancelamento concluído. Sem insistir no que não precisava continuar."
  ],
  recovery: [
    "O aplicativo foi recuperado após uma falha inesperada. Sua sessão anterior foi preservada quando possível.",
    "Recuperamos o estado anterior e retomamos com cautela.",
    "Voltamos com segurança após uma interrupção inesperada."
  ],
  error: [
    "Não conseguimos processar esse PDF. Ele pode estar corrompido ou incompleto.",
    "Esse arquivo parece mais confuso do que deveria. A operação foi interrompida para evitar problemas maiores.",
    "A operação falhou antes de finalizar. Mantivemos o resto do sistema estável."
  ],
  validation: [
    "Falta uma informação.",
    "Ajuste isso para continuar.",
    "Complete isso para seguir."
  ],
  safeMode: [
    "Modo seguro ativado para priorizar estabilidade.",
    "Reduzimos a carga visual para proteger a sessão atual.",
    "Seguimos em modo otimizado para evitar consumo excessivo."
  ]
};

function getRotationIndex(seed = "") {
  let total = 0;
  const normalized = String(seed);
  for (let index = 0; index < normalized.length; index += 1) {
    total += normalized.charCodeAt(index) * (index + 1);
  }
  return total;
}

export function pickMessage(category, seed = "") {
  const bucket = MESSAGE_CATALOG[category] || MESSAGE_CATALOG.success;
  const index = getRotationIndex(seed) % bucket.length;
  return bucket[index];
}

export function buildFeedbackMessage(category, options = {}) {
  const {
    seed = "",
    prefix = "",
    suffix = "",
    detail = ""
  } = options;

  const parts = [
    prefix.trim(),
    pickMessage(category, seed),
    detail.trim(),
    suffix.trim()
  ].filter(Boolean);

  return parts.join(" ");
}

export function getOperationLabel(type) {
  const map = {
    "images-to-pdf": "Converter arquivos para PDF",
    "files-to-pdf": "Converter arquivos para PDF",
    sign: "Assinar PDF",
    "pdf-to-word": "Converter para Word",
    merge: "Mesclar",
    "split-pages": "Separar PDFs",
    "split-range": "Separar PDFs",
    "split-size": "Separar PDFs",
    organize: "Organizar Páginas",
    compress: "Reduzir tamanho",
    watermark: "Marca d'água",
    protect: "Proteger PDF",
    unlock: "Desbloquear PDF",
    redact: "Ocultar Dados"
  };

  return map[type] || "Processamento PDF";
}
