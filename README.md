# Central PDF

Utilitário corporativo para processamento **local** de documentos no Windows. Operação offline, previsível, com baixa manutenção e sem dependência de cloud.

Para uma documentação completa do projeto, estrutura, processo de build e troubleshooting, leia os arquivos na pasta [docs/](./docs/).

---

## ⚠️ AVISO PARA NOVOS DESENVOLVEDORES

Este projeto está atualmente hospedado em um **caminho de rede (`\\vm-infra\Central PDF`)**.

Devido a limitações do `cmd.exe` do Windows, comandos como `npm install`, `npm run dev` ou `npm run build` podem falhar se executados diretamente a partir de um caminho UNC (que inicia com `\\`).

**Sempre mapeie a pasta de rede para uma unidade local antes de trabalhar.**
Por exemplo, mapeie a pasta como disco `Z:`:

```bash
# Executar no Prompt de Comando / PowerShell
net use Z: "\\vm-infra\Central PDF"

# Depois acesse a unidade Z:
Z:
cd \
```

---

## Execução Rápida

Após mapear o disco de rede, você pode instalar as dependências e iniciar o ambiente de desenvolvimento local:

```bash
npm install
npm run dev
```

Para gerar os pacotes Windows (MSI e Portable):

```bash
npm run build:win
```

## Guia de Leitura Essencial

Para manutenção e troubleshooting detalhado, consulte:

1. [Visão Geral e Features (`docs/README.md`)](./docs/README.md)
2. [Guia de Build e Deploy (`docs/BUILD.md`)](./docs/BUILD.md)
3. [Troubleshooting e Erros Comuns (`docs/TROUBLESHOOTING.md`)](./docs/TROUBLESHOOTING.md)
4. [Arquitetura Geral (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)
