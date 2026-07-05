'use strict';

const engine = require('./engine/engine');
const dialog = require('./engine/dialog_manager');

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

console.log('[Bot] Iniciando bot de vendas de brinquedos...');

// Configuração básica
const config = {
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  botName: 'Atendente de Brinquedos',
  horaInicio: 8,
  horaFim: 19,
  diasAtendimento: ['segunda', 'terça', 'quarta', 'quinta', 'sexta'],
};

const allowFallbackRuntime = isTrue(process.env.SAFE_STARTUP_ALLOW_ALL) || isTrue(process.env.ALLOW_FALLBACK_LLM);

if (!config.apiKey && !allowFallbackRuntime) {
  throw new Error('ANTHROPIC_API_KEY ausente e fallback nao autorizado. Configure ANTHROPIC_API_KEY ou ALLOW_FALLBACK_LLM=true para manutencao.');
}

if (!config.apiKey) {
  console.warn('[Bot] ⚠️  ANTHROPIC_API_KEY não configurada. Usando fallback autorizado por ambiente.');
} else {
  console.log(`[Bot] Modelo Anthropic ativo: ${config.anthropicModel}`);
}

// Handler de mensagem (será chamado pelo WhatsApp-web.js depois)
async function handleMessage(phone, message, name = null, meta = {}) {
  try {
    if (!message || !message.trim()) return;

    console.log(`[Message] ${phone} (${name || 'sem nome'}): "${message.slice(0, 60)}"`);
    const currentState = engine.getDialogState(phone);
    const effectiveName = name || currentState?.name || null;

    const response = await engine.generateResponse({
      phone,
      name: effectiveName,
      message,
      history: engine.getDialogHistory(phone, 20),
      summary: currentState?.summary || null,
      stage: currentState?.stage || null,
      quotedMessage: meta?.quotedMessage || null,
      quotedAuthor: meta?.quotedAuthor || null,
      quotedIsBot: !!meta?.quotedIsBot,
    });

    // Log do resultado
    console.log(`[Response] Stage: ${response.stage} | Score: ${response.dialog_state.score}`);

    return {
      messages: response.messages,
      stage: response.stage,
      score: response.dialog_state.score,
      ready: response.pronto,
      closingSignal: response.closing_signal || null,
    };
  } catch (err) {
    console.error('[Bot] Erro ao processar mensagem:', err.message);
    return {
      messages: ['Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.'],
      stage: 'unknown',
      error: err.message,
    };
  }
}

// Export para integração com WhatsApp-web.js
module.exports = { handleMessage, config, engine, dialog };

// Se executado diretamente, inicia uma demo interativa
if (require.main === module) {
  console.log(`[Demo] Bot ready. Use handleMessage(phone, text, name) para processar mensagens.`);
  console.log(`[Demo] Exemplo: await handleMessage('5511987654321', 'Olá, tenho interesse', 'João')\n`);
}

console.log('Bot de vendas de brinquedos pronto para ser conectado.');
