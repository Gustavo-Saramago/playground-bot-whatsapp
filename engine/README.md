Contextual Engine — Design

Objetivo
- Fornecer um motor contextual que combine: recuperação da base de conhecimento (KB), memória/resumo por lead e uma camada LLM para geração de respostas dinâmicas.
- Evitar scripts rígidos: usar templates orientadores e instruções dinâmicas, alimentadas por trechos relevantes da KB e histórico do usuário.

Componentes
1. KB index (lightweight)
   - Arquivo JSON com entradas (produtos, políticas, playbook)
   - Indexador simples (token/keyword based) para recuperação inicial

2. Retriever
   - Recebe a mensagem do usuário e devolve os trechos da KB mais relevantes
   - Implementação inicial baseada em contagem de palavras-chave (substituível por embedding vector store)

3. Dialogue Manager
   - Mantém estado por lead (estágio atual, resumo, últimas N mensagens)
   - Fornece contexto para o prompt do LLM

4. Prompt Templates
   - Templates estruturados para system + user messages
   - Instruções: estilo de atendimento, regras proibidas, formato de resposta

5. LLM Adapter
   - Interface para chamar um LLM (Anthropic/OpenAI). Implementação inicial: stub que simula resposta
   - Produz JSON com `messages[]`, `stage`, `reason`, `client_name`, `pronto`

6. Generator
   - Combina retrieval + context + templates para criar prompt
   - Chama LLM Adapter e transforma saída para o formato do bot

Persistência e memória
- `db` simples (arquivo SQLite em futuras iterações) — por enquanto, usar resumo em memória via objeto `dialogues` e salvar em `knowledge/summaries.json` se necessário.

Extensões futuras
- Substituir retriever por embeddings com `@openai` ou outro provedor
- Conectar LLM real via variáveis de ambiente
- Adicionar scoring de leads, regras de roteamento e integração com `whatsapp-web.js`

Segurança e regras de uso
- Nunca se identificar como IA
- Não prometer condições que não existam
- Sempre usar KB para fatos sensíveis (preços, condições)

Arquivos relacionados
- `engine/engine.js` — implementação inicial
- `engine/prompt_templates.js` — templates e regras
- `knowledge/*.json` — base de conhecimento
- `flows/sales-flow.js` — fluxo leve (compatibilidade)
