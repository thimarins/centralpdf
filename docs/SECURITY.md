# Segurança

## Visão Geral

Central PDF foi desenhado para processamento local e previsível.
O objetivo de segurança do projeto é reduzir a superfície de risco com medidas simples, auditáveis e sustentáveis.

## Hardening do Electron

Medidas atuais:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- `webSecurity: true`
- bloqueio de navegação externa
- bloqueio de `window.open`
- `requestSingleInstanceLock()`

Resultado prático:

- o renderer não acessa Node diretamente
- a comunicação com o main passa pelo preload
- o app não navega para destinos externos arbitrários
- múltiplas instâncias concorrentes são evitadas

## CSP

O renderer utiliza Content Security Policy restritiva no HTML principal.

Diretivas principais:

- `default-src 'self'`
- `script-src 'self'`
- `connect-src 'none'`
- `object-src 'none'`
- `base-uri 'none'`
- `frame-ancestors 'none'`

## IPC Allowlist

O preload expõe uma API pequena e intencional.

Superfícies principais:

- configurações
- seleção de diretórios
- fila de processamento
- exportação de diagnóstico
- abertura/revelação controlada de paths locais

O `main` valida:

- tipo da operação
- arquivos de entrada
- opções de watermark
- opções de organização
- diretório de saída
- paths absolutos e existentes para shell local

## Processamento Offline

Regras do projeto:

- sem cloud
- sem upload automático
- sem dependência de API externa
- sem telemetria remota

Tudo ocorre localmente no equipamento do usuário.

## Arquivos Temporários e Saída

Práticas atuais:

- escrita atômica com arquivo temporário e `rename`
- validação de integridade antes da publicação final
- limpeza de temporários em falha
- watermark gera cópia por padrão

## Endurecimento de Arquivos

- validação de magic bytes para PDF
- checagem básica de marcador final `%%EOF`
- validação de PNG/JPG por assinatura e dimensões
- SVG aceito apenas com restrições locais e bloqueio de padrões perigosos conhecidos
- limite oficial de arquivo configurado para apr?ximadamente `2 GB`

## Logs

Práticas atuais:

- logs rotativos
- crash log separado
- retenção configurável
- pacote de diagnóstico exportado sob demanda
- sanitização de paths sensíveis no diagnóstico

## Dados Sensíveis

Diretriz atual:

- não registrar conteúdo integral dos PDFs
- evitar exposição de caminhos absolutos quando possível
- exportar diagnóstico com sanitização de configuração e logs

## Políticas Corporativas

Arquivo suportado:

- `C:\ProgramData\Central PDF\policy.json`

Pode ser usado para:

- forçar tema
- forçar pasta padrão
- desabilitar histórico
- ajustar retenção de logs
- limitar tamanho máximo de arquivo

## Limitações Conhecidas

- PDFs malformados ainda podem causar falhas de parsing em bibliotecas de terceiros
- `pdfjs-dist` é o maior componente do bundle
- `pdf-lib` continua sendo o principal limitador para documentos muito grandes
- atualizações de Electron devem ser acompanhadas de bateria mínima de validação
