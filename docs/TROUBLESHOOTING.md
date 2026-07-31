# Troubleshooting

## Localização dos Logs

### Modo instalado

- `%APPDATA%\Central PDF\logs\operations.log`
- `%APPDATA%\Central PDF\logs\crashes.log`

### Modo portátil / unpacked

- `data\logs\operations.log`
- `data\logs\crashes.log`

## Pacote de Diagnóstico

Use a opção de exportação dentro do app para gerar:

- logs
- configuração sanitizada
- resumo de saúde quando disponível

Indicado para:

- suporte interno
- análise de erro
- validação de ambiente

## Problemas Comuns

### Erros `ENOENT` ou falhas de `npm install`/`build` (Ambiente de Rede / UNC Path)

Sintomas:

- `npm install` falha silenciosamente
- `npm run build` ou `electron-builder` falha ao encontrar pastas como `dist/`
- Erro indicando `UNC paths are not supported` no `cmd.exe`.

Ações:

- **Não rode os comandos diretamente de um caminho de rede UNC** (algo como `\\SEU-SERVIDOR\Central PDF`).
- Mapeie o diretório para um drive local primeiro (ex: abra o prompt e rode `net use Z: "\\SEU-SERVIDOR\Central PDF"`).
- Acesse a unidade mapeada (`Z:`) e tente o comando novamente, ou clone para uma pasta local (ex: `%TEMP%`) para realizar o build e depois copie o resultado de volta.

### PDF corrompido ou não abre

Sintomas:

- erro ao processar
- falha na renderização
- interrupção da operação

Ações:

- testar o PDF em outro leitor local
- repetir com outro arquivo
- verificar `operations.log`
- testar merge/split com um PDF simples

### Falha de renderização de preview

Sintomas:

- miniaturas não aparecem
- organize fica incompleto
- preview de watermark não bate com a expectativa

Ações:

- fechar e reabrir o app
- testar um PDF menor
- verificar se o arquivo está protegido ou malformado
- revisar `crashes.log` e `operations.log`

### Problemas de permissão

Sintomas:

- erro ao salvar
- erro ao exportar diagnóstico
- pasta de destino rejeitada

Ações:

- testar outra pasta local
- evitar caminhos de rede restritos
- confirmar permissão de escrita do usuário

### Consumo alto de memória

Sintomas:

- lentidão com PDFs grandes
- miniaturas demorando
- lote pesado processando mais devagar

Ações:

- processar menos arquivos por vez
- fechar outros apps pesados
- usar horário de menor carga para lotes longos
- usar a pasta unpacked para testes isolados quando necessário

### Conversão para Word não mantém o conteúdo esperado

Sintomas:

- DOCX vazio ou quase vazio
- texto sai quebrado demais
- documento escaneado não converte

Ações:

- confirmar se o PDF é digital/textual e não apenas imagem
- testar a exportação em `Texto estruturado`
- repetir com um PDF menor do mesmo sistema de origem
- revisar `operations.log` para confirmar ausência de camada textual
### Watermark por imagem falha

Sintomas:

- imagem não aplica
- erro ao enfileirar

Ações:

- testar PNG ou JPG primeiro
- validar se o arquivo de imagem existe localmente
- em SVG, testar PNG equivalente se houver incompatibilidade local

### Fila não conclui

Sintomas:

- tarefa fica travada
- progresso não avança

Ações:

- cancelar a tarefa
- reiniciar o app
- verificar se o arquivo de origem está aberto por outro processo
- validar se há conflito com outro arquivo na fila

## PDFs Grandes e Modo Otimizado

Comportamento esperado:

- acima de ~300 MB o app pode reduzir previews
- acima de ~1 GB o app entra em modo otimizado quando aplicável
- perto de 2 GB o app exibe aviso forte e pode exigir mais tempo de processamento

## Limpeza Básica

Pode ser útil:

- remover logs antigos
- limpar `dist/`
- limpar `dist-installer/`
- remover releases antigas que não serão mais distribuídas

## Rebuild do Projeto

```bash
npm install
npm run build
npm run health-check
npm run release-check
npm run build:win
```

## Validação Rápida Pós-Correção

- abrir o app
- testar Converter para PDF com imagem, Word e Excel
- testar assinar PDF
- testar converter para Word
- testar merge
- testar split
- testar organize
- testar watermark
- testar compress
- testar proteger
- testar redigir

