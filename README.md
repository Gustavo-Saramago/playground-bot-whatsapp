# Bot de vendas de brinquedos

Este é um novo projeto separado para atender leads de tráfego pago interessados em brinquedos de um playground em desmontagem.

## Objetivo
- Qualificar o lead
- Entender a necessidade da pessoa
- Apresentar os brinquedos como solução
- Enviar fotos e vídeos quando disponíveis
- Passar preços e condições de pagamento
- Filtrar interessados qualificados para fechamento manual

## Estrutura
- index.js: ponto de entrada do bot
- knowledge/: base de conhecimento do negócio
- flows/: fluxo de vendas e roteiro

## Retomada ativa estrategica

O bot retoma conversas de forma contextual, com tempos diferentes por status de pausa:

- decision_pending (ex.: "vou pensar", "falar com a esposa"): 12h + jitter de 45 a 150 min
- post_info_silence (sumiu apos preco/fotos/proposta): 35 min + jitter de 8 a 28 min
- negotiation_pause (parou em negociacao/objecoes): 20 min + jitter de 6 a 18 min
- mid_funnel_pause (diagnostico/apresentacao/validacao): 75 min + jitter de 12 a 35 min
- default_pause: 60 min + jitter de 10 a 30 min

Regras de envio:

- Janela permitida: 08h ate 20h
- Fora da janela, o envio eh movido para a proxima abertura com jitter adicional
- Numero maximo de tentativas por mesma pausa: 2

Variaveis de ambiente principais:

- PROACTIVE_STRATEGY_PRESET (conservative, balanced, aggressive)
- OWNER_PHONE (telefone que recebe alertas e envia comandos de assuncao)
- NOTIFY_ONLY_CRITICAL_CLOSING (true por padrao)
- TAKEOVER_OWNER_PINGS (false por padrao)
- CRITICAL_CLOSING_GUARD (true por padrao)
- CRITICAL_CLOSING_GUARD_MINUTES (padrao 20)
- CRITICAL_CLOSING_GUARD_TONE (firm ou soft, padrao firm)
- PROACTIVE_FOLLOWUP_ENABLED
- PROACTIVE_ALLOWED_START_HOUR
- PROACTIVE_ALLOWED_END_HOUR
- PROACTIVE_MAX_ATTEMPTS
- PROACTIVE_DECISION_PENDING_MINUTES
- PROACTIVE_POST_INFO_SILENCE_MINUTES
- PROACTIVE_NEGOTIATION_PAUSE_MINUTES
- PROACTIVE_MID_FUNNEL_PAUSE_MINUTES
- PROACTIVE_DEFAULT_PAUSE_MINUTES

Presets de estrategia:

- conservative: contato menos frequente, foco em menor pressao comercial
- balanced: equilibrio entre velocidade de follow-up e conforto do lead
- aggressive: retomada mais rapida para maximizar conversao

Exemplo:

- Definir PROACTIVE_STRATEGY_PRESET=conservative para operacao mais conservadora

Observacao:

- Variaveis de ambiente especificas sempre sobrescrevem o preset escolhido

## Envio de midia como arquivo

O bot envia arquivos de midia (nao links) a partir de pastas locais.

Estrutura esperada:

- media/videos_funcionamento
- media/area_baby
- media/brinquedao
- media/cenografias
- media/espumados

Regras:

- Videos: quando entrar no momento de apresentacao, envia todos os arquivos da pasta videos_funcionamento
- Fotos por brinquedo: quando o cliente pedir, envia todos os arquivos da pasta correspondente
- Se houver mais de 1 arquivo na pasta, envia todos em sequencia

Extensoes aceitas:

- Videos: .mp4, .mov, .avi, .mkv, .webm
- Fotos: .jpg, .jpeg, .png, .webp

## Alertas de fechamento e assuncao manual

Quando a negociacao entra em fase quente (negociacao/fechamento, score alto ou intencao explicita de fechar),
o bot envia alerta para OWNER_PHONE com resumo e checkpoints.

Comandos (enviar do OWNER_PHONE para o WhatsApp do bot):

- /assumir 5511999999999
- /liberar 5511999999999
- /status 5511999999999
- /leads
- /relatorio
- /ajuda

Ao assumir um lead, o bot para de responder esse contato ate receber /liberar.

## Operacao segura com numero ja em uso

O bot pode iniciar em modo seguro para proteger conversas antigas e evitar atendimento real durante testes.

Regras:

- Contatos que ja existiam quando o bot conecta ficam como manuais
- Enquanto o bot estiver em modo seguro, novos contatos reais nao sao atendidos automaticamente
- Para testar, libere apenas numeros especificos com /teste
- Quando estiver tudo validado, use /ativarbot para atender apenas contatos realmente novos

Variaveis:

- SAFE_STARTUP_MODE (true por padrao)
- BOT_LIVE_ON_START (false por padrao)

Comandos adicionais:

- /teste 5511999999999
- /removerteste 5511999999999
- /ativarbot
- /desativarbot
- /modo

Politica de notificacao:

- O owner recebe notificacoes apenas em casos criticos de fechamento, muito proximos do limite de autonomia do bot.
- Fora esses casos, sem notificacoes automaticas.
- Acompanhamento sob demanda pelos comandos /leads, /status e /relatorio.

Estrategia anti-risco no fechamento:

- Quando o bot detecta fechamento iminente no limite de autonomia, ele ativa modo de protecao.
- Nesse modo, responde com mensagens seguras de manutencao para nao se complicar nem esfriar a venda.
- Em paralelo, dispara alerta pontual para o owner assumir a conversa.
- O tom dessas mensagens pode ser ajustado: firm (mais direto) ou soft (mais suave).
