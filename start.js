#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnvFile(path.join(__dirname, '.env'));
loadDotEnvFile(path.join(__dirname, '.env.local'));

if (process.platform !== 'win32' && process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chromePath = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  const looksLikeWindowsPath = /^[A-Za-z]:\\/.test(chromePath) || chromePath.includes('\\');
  if (looksLikeWindowsPath) {
    console.warn('[App] Ignorando PUPPETEER_EXECUTABLE_PATH com formato Windows em ambiente Linux.');
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
  }
}

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

const pairingPortalEnabled = isTrue(process.env.WEB_PAIRING_ENABLED || 'true');

function maskPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return 'none';
  if (digits.length <= 4) return digits;
  return `***${digits.slice(-4)}`;
}

const hasAnthropicKey = String(process.env.ANTHROPIC_API_KEY || '').trim().length > 0;
const allowFallbackRuntime = isTrue(process.env.SAFE_STARTUP_ALLOW_ALL) || isTrue(process.env.ALLOW_FALLBACK_LLM) || pairingPortalEnabled;

if (!hasAnthropicKey && !allowFallbackRuntime) {
  console.error('[App] Erro fatal: ANTHROPIC_API_KEY ausente e fallback nao autorizado.');
  console.error('[App] Configure ANTHROPIC_API_KEY ou habilite ALLOW_FALLBACK_LLM=true para manutencao controlada.');
  process.exit(1);
}

console.log(`[App] Runtime LLM mode: ${hasAnthropicKey ? 'anthropic' : 'fallback-autorizado'}`);
if (!hasAnthropicKey && pairingPortalEnabled) {
  console.warn('[App] Portal de pareamento habilitado sem ANTHROPIC_API_KEY. O portal web pode subir em modo de manutencao.');
}

const startupHealth = {
  llm_mode: hasAnthropicKey ? 'anthropic' : 'fallback-autorizado',
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  fallback_authorized: allowFallbackRuntime,
  safe_startup_mode: isTrue(process.env.SAFE_STARTUP_MODE),
  bot_live_on_start: isTrue(process.env.BOT_LIVE_ON_START),
  critical_closing_guard: process.env.CRITICAL_CLOSING_GUARD !== 'false',
  owner_phone: maskPhone(process.env.OWNER_PHONE || ''),
};

console.log(`[App][Health] ${JSON.stringify(startupHealth)}`);

const { createPairingServer } = require('./web/server');

if (!String(process.env.OPENAI_API_KEY || '').trim()) {
  console.warn('[App] OPENAI_API_KEY não encontrada. Áudios vão cair no fallback até a chave ser configurada.');
}

function envNum(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PROACTIVE_PRESETS = {
  conservative: {
    inactivityMinutes: {
      decision_pending: 16 * 60,
      post_info_silence: 60,
      negotiation_pause: 40,
      mid_funnel_pause: 120,
      default_pause: 90,
    },
    jitterMinutes: {
      decision_pending: { min: 60, max: 240 },
      post_info_silence: { min: 12, max: 35 },
      negotiation_pause: { min: 10, max: 25 },
      mid_funnel_pause: { min: 20, max: 50 },
      default_pause: { min: 15, max: 45 },
    },
    windowOpenJitterMinutes: { min: 10, max: 35 },
    maxAttempts: 1,
  },
  balanced: {
    inactivityMinutes: {
      decision_pending: 12 * 60,
      post_info_silence: 35,
      negotiation_pause: 20,
      mid_funnel_pause: 75,
      default_pause: 60,
    },
    jitterMinutes: {
      decision_pending: { min: 45, max: 150 },
      post_info_silence: { min: 8, max: 28 },
      negotiation_pause: { min: 6, max: 18 },
      mid_funnel_pause: { min: 12, max: 35 },
      default_pause: { min: 10, max: 30 },
    },
    windowOpenJitterMinutes: { min: 7, max: 30 },
    maxAttempts: 2,
  },
  aggressive: {
    inactivityMinutes: {
      decision_pending: 12 * 60,
      post_info_silence: 20,
      negotiation_pause: 12,
      mid_funnel_pause: 45,
      default_pause: 35,
    },
    jitterMinutes: {
      decision_pending: { min: 35, max: 120 },
      post_info_silence: { min: 5, max: 18 },
      negotiation_pause: { min: 4, max: 12 },
      mid_funnel_pause: { min: 8, max: 25 },
      default_pause: { min: 7, max: 20 },
    },
    windowOpenJitterMinutes: { min: 5, max: 20 },
    maxAttempts: 2,
  },
};

const presetName = (process.env.PROACTIVE_STRATEGY_PRESET || 'balanced').toLowerCase();
const preset = PROACTIVE_PRESETS[presetName] || PROACTIVE_PRESETS.balanced;

let app = null;

const appBridge = {
  getStatus: () => {
    if (app && typeof app.getStatus === 'function') {
      return app.getStatus();
    }
    return { ready: false, qrGenerated: false, pairingCodeGenerated: false };
  },
  getQRData: () => {
    if (app && typeof app.getQRData === 'function') {
      return app.getQRData();
    }
    return '';
  },
  getPairingCode: () => {
    if (app && typeof app.getPairingCode === 'function') {
      return app.getPairingCode();
    }
    return '';
  },
  getPairingPhoneMasked: () => {
    if (app && typeof app.getPairingPhoneMasked === 'function') {
      return app.getPairingPhoneMasked();
    }
    return maskPhone(process.env.PAIRING_PHONE_NUMBER || '');
  },
  logout: async () => {
    if (app && typeof app.logout === 'function') {
      await app.logout();
    }
  },
};

function createWhatsAppClient() {
  const WhatsAppClient = require('./whatsapp/client');
  return new WhatsAppClient({
    headless: true,
    ownerPhone: process.env.OWNER_PHONE || '',
    pairingPhoneNumber: process.env.PAIRING_PHONE_NUMBER || '',
    safeStartupMode: process.env.SAFE_STARTUP_MODE !== 'false',
    safeStartupAllowAll: process.env.SAFE_STARTUP_ALLOW_ALL === 'true',
    liveModeActive: process.env.BOT_LIVE_ON_START === 'true',
    notifyOnlyCriticalClosing: process.env.NOTIFY_ONLY_CRITICAL_CLOSING !== 'false',
    takeoverOwnerPingsEnabled: process.env.TAKEOVER_OWNER_PINGS === 'true',
    criticalClosingGuardEnabled: process.env.CRITICAL_CLOSING_GUARD !== 'false',
    criticalClosingGuardMinutes: envNum('CRITICAL_CLOSING_GUARD_MINUTES', 20),
    criticalClosingGuardTone: (process.env.CRITICAL_CLOSING_GUARD_TONE || 'firm').toLowerCase(),
    proactiveFollowupEnabled: process.env.PROACTIVE_FOLLOWUP_ENABLED === 'true',
    proactiveInactivityMs: envNum('PROACTIVE_INACTIVITY_MINUTES', preset.inactivityMinutes.default_pause) * 60 * 1000,
    proactiveInactivityByStatusMs: {
      decision_pending: envNum('PROACTIVE_DECISION_PENDING_MINUTES', preset.inactivityMinutes.decision_pending) * 60 * 1000,
      post_info_silence: envNum('PROACTIVE_POST_INFO_SILENCE_MINUTES', preset.inactivityMinutes.post_info_silence) * 60 * 1000,
      negotiation_pause: envNum('PROACTIVE_NEGOTIATION_PAUSE_MINUTES', preset.inactivityMinutes.negotiation_pause) * 60 * 1000,
      mid_funnel_pause: envNum('PROACTIVE_MID_FUNNEL_PAUSE_MINUTES', preset.inactivityMinutes.mid_funnel_pause) * 60 * 1000,
      default_pause: envNum('PROACTIVE_DEFAULT_PAUSE_MINUTES', preset.inactivityMinutes.default_pause) * 60 * 1000,
    },
    proactiveJitterByStatusMs: {
      decision_pending: {
        min: envNum('PROACTIVE_DECISION_PENDING_JITTER_MIN_MINUTES', preset.jitterMinutes.decision_pending.min) * 60 * 1000,
        max: envNum('PROACTIVE_DECISION_PENDING_JITTER_MAX_MINUTES', preset.jitterMinutes.decision_pending.max) * 60 * 1000,
      },
      post_info_silence: {
        min: envNum('PROACTIVE_POST_INFO_SILENCE_JITTER_MIN_MINUTES', preset.jitterMinutes.post_info_silence.min) * 60 * 1000,
        max: envNum('PROACTIVE_POST_INFO_SILENCE_JITTER_MAX_MINUTES', preset.jitterMinutes.post_info_silence.max) * 60 * 1000,
      },
      negotiation_pause: {
        min: envNum('PROACTIVE_NEGOTIATION_PAUSE_JITTER_MIN_MINUTES', preset.jitterMinutes.negotiation_pause.min) * 60 * 1000,
        max: envNum('PROACTIVE_NEGOTIATION_PAUSE_JITTER_MAX_MINUTES', preset.jitterMinutes.negotiation_pause.max) * 60 * 1000,
      },
      mid_funnel_pause: {
        min: envNum('PROACTIVE_MID_FUNNEL_PAUSE_JITTER_MIN_MINUTES', preset.jitterMinutes.mid_funnel_pause.min) * 60 * 1000,
        max: envNum('PROACTIVE_MID_FUNNEL_PAUSE_JITTER_MAX_MINUTES', preset.jitterMinutes.mid_funnel_pause.max) * 60 * 1000,
      },
      default_pause: {
        min: envNum('PROACTIVE_DEFAULT_JITTER_MIN_MINUTES', preset.jitterMinutes.default_pause.min) * 60 * 1000,
        max: envNum('PROACTIVE_DEFAULT_JITTER_MAX_MINUTES', preset.jitterMinutes.default_pause.max) * 60 * 1000,
      },
    },
    proactiveAllowedStartHour: envNum('PROACTIVE_ALLOWED_START_HOUR', 8),
    proactiveAllowedEndHour: envNum('PROACTIVE_ALLOWED_END_HOUR', 20),
    proactiveWindowOpenJitterMinMs: envNum('PROACTIVE_WINDOW_OPEN_JITTER_MIN_MINUTES', preset.windowOpenJitterMinutes.min) * 60 * 1000,
    proactiveWindowOpenJitterMaxMs: envNum('PROACTIVE_WINDOW_OPEN_JITTER_MAX_MINUTES', preset.windowOpenJitterMinutes.max) * 60 * 1000,
    proactiveFollowupCheckMs: envNum('PROACTIVE_CHECK_SECONDS', 60) * 1000,
    proactiveMaxAttemptsPerPause: envNum('PROACTIVE_MAX_ATTEMPTS', preset.maxAttempts),
  });
}

console.log(`[App] Preset de retomada ativa: ${presetName in PROACTIVE_PRESETS ? presetName : 'balanced'}`);

const runtimeState = {
  phase: 'starting',
  error: '',
};

function setRuntimeState(phase, error = '') {
  runtimeState.phase = String(phase || 'starting');
  runtimeState.error = String(error || '');
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason || 'unhandled rejection');
  setRuntimeState('error', message);
  console.error('[App] Unhandled rejection capturada:', message);
});

process.on('uncaughtException', (error) => {
  const message = error instanceof Error ? error.message : String(error || 'uncaught exception');
  setRuntimeState('error', message);
  console.error('[App] Uncaught exception capturada:', message);
});

async function initializeWhatsApp() {
  setRuntimeState('initializing');
  if (!app) {
    app = createWhatsAppClient();
  }
  await app.initialize();
  setRuntimeState('ready');
  console.log('[App] Bot aguardando mensagens no WhatsApp...');
}

(async () => {
  let pairingWeb = null;

  try {
    console.log('[App] Iniciando bot de vendas de brinquedos com WhatsApp...');

    pairingWeb = createPairingServer({
      app: appBridge,
      getRuntimeState: () => runtimeState,
      port: Number(process.env.PORT || 3000),
      // Keep HTTP service up unconditionally to satisfy Railway health checks.
      enabled: true,
      username: process.env.WEB_PAIRING_USER || 'admin',
      password: process.env.WEB_PAIRING_PASSWORD || process.env.DASHBOARD_PASSWORD || '',
    });

    await pairingWeb.start();
    initializeWhatsApp().catch((err) => {
      setRuntimeState('error', err.message);
      console.error('[App] Falha ao iniciar WhatsApp:', err.message);
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      setRuntimeState('stopping');
      console.log('[App] Encerrando...');
      await appBridge.logout();
      if (pairingWeb) {
        await pairingWeb.stop();
      }
      process.exit(0);
    });
  } catch (err) {
    setRuntimeState('error', err.message);
    console.error('[App] Erro fatal:', err.message);
    if (!pairingWeb) {
      process.exit(1);
    }
  }
})();
