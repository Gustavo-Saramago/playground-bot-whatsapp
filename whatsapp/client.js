'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const bot = require('../index.js');
const { transcribeAudioMedia } = require('../transcriber');

class WhatsAppClient {
  constructor(options = {}) {
    this.client = null;
    this.ready = false;
    this.qrData = null;
    this.proactiveTimer = null;
    this.inboxPollTimer = null;
    this.inboxPollInFlight = false;
    this.inboxPollDetachedFrameErrors = 0;
    this.inboxPollPausedUntilMs = 0;
    this.messageQueues = new Map();
    this.processedInboundMessageIds = new Set();
    this.processedInboundMessageKeys = new Map();
    this.replyTimingState = new Map();
    this.manualTakeovers = new Map();
    this.legacyManualContacts = new Set();
    this.inboundPollBootAtMs = Date.now();
    this.testAllowedContactsPath = options.testAllowedContactsPath || path.join(__dirname, '..', 'test-allowed-contacts.json');
    this.testAllowedContacts = this._loadTestAllowedContacts();
    this.mediaCatalog = this._loadMediaCatalog();
    this.salesCatalog = this._loadSalesCatalog();
    this.pricingPolicy = this._loadPricingPolicy();
    this.ownerPhone = this._normalizePhone(options.ownerPhone || process.env.OWNER_PHONE || '');
    this.pairingPhoneNumber = this._normalizePhone(
      options.pairingPhoneNumber || process.env.PAIRING_PHONE_NUMBER || process.env.OWNER_PHONE || '',
    );
    this.liveModeActive = options.liveModeActive === true;
    this.options = {
      authPath: options.authPath || path.join(__dirname, '..', '.wwebjs_auth'),
      headless: options.headless !== false,
      firstReplyDelayMs: options.firstReplyDelayMs || 15000,
      firstReplyJitterMs: options.firstReplyJitterMs || 2000,
      conversationDelayMinMs: options.conversationDelayMinMs || 5000,
      conversationDelayMaxMs: options.conversationDelayMaxMs || 20000,
      conversationResetGapMs: options.conversationResetGapMs || 30 * 60 * 1000,
      betweenMessagesMinMs: options.betweenMessagesMinMs || 5000,
      betweenMessagesMaxMs: options.betweenMessagesMaxMs || 12000,
      typingMinMs: options.typingMinMs || 650,
      typingMaxMs: options.typingMaxMs || 6200,
      typingMsPerChar: options.typingMsPerChar || 32,
      typingPunctuationMs: options.typingPunctuationMs || 60,
      typingJitterMs: options.typingJitterMs || 220,
      proactiveFollowupEnabled: options.proactiveFollowupEnabled !== false,
      proactiveFollowupCheckMs: options.proactiveFollowupCheckMs || 60 * 1000,
      proactiveInactivityMs: options.proactiveInactivityMs || 45 * 60 * 1000,
      proactiveInactivityByStatusMs: options.proactiveInactivityByStatusMs || {
        decision_pending: 12 * 60 * 60 * 1000,
        post_info_silence: 40 * 60 * 1000,
        negotiation_pause: 25 * 60 * 1000,
        mid_funnel_pause: 60 * 60 * 1000,
        default_pause: 45 * 60 * 1000,
      },
      proactiveJitterByStatusMs: options.proactiveJitterByStatusMs || {
        decision_pending: { min: 30 * 60 * 1000, max: 120 * 60 * 1000 },
        post_info_silence: { min: 6 * 60 * 1000, max: 20 * 60 * 1000 },
        negotiation_pause: { min: 4 * 60 * 1000, max: 15 * 60 * 1000 },
        mid_funnel_pause: { min: 8 * 60 * 1000, max: 25 * 60 * 1000 },
        default_pause: { min: 5 * 60 * 1000, max: 20 * 60 * 1000 },
      },
      proactiveAllowedStartHour: options.proactiveAllowedStartHour ?? 8,
      proactiveAllowedEndHour: options.proactiveAllowedEndHour ?? 20,
      proactiveWindowOpenJitterMinMs: options.proactiveWindowOpenJitterMinMs || 5 * 60 * 1000,
      proactiveWindowOpenJitterMaxMs: options.proactiveWindowOpenJitterMaxMs || 25 * 60 * 1000,
      proactiveMaxAttemptsPerPause: options.proactiveMaxAttemptsPerPause || 1,
      takeoverLeadPingCooldownMs: options.takeoverLeadPingCooldownMs || 3 * 60 * 1000,
      takeoverOwnerPingsEnabled: options.takeoverOwnerPingsEnabled === true,
      notifyOnlyCriticalClosing: options.notifyOnlyCriticalClosing !== false,
      criticalClosingGuardEnabled: options.criticalClosingGuardEnabled !== false,
      criticalClosingGuardMinutes: options.criticalClosingGuardMinutes || 20,
      criticalClosingGuardTone: String(options.criticalClosingGuardTone || 'firm').toLowerCase(),
      criticalClosingGuardPingCooldownMs: options.criticalClosingGuardPingCooldownMs || 5 * 60 * 1000,
      negotiationReviewPingCooldownMs: options.negotiationReviewPingCooldownMs || 20 * 60 * 1000,
      callRequestPingCooldownMs: options.callRequestPingCooldownMs || 15 * 60 * 1000,
      safeStartupMode: options.safeStartupMode !== false,
      proactiveSkipStages: options.proactiveSkipStages || ['fechamento'],
      inboxPollEnabled: options.inboxPollEnabled !== false,
      inboxPollIntervalMs: options.inboxPollIntervalMs || 4000,
      inboxPollRecentWindowMs: options.inboxPollRecentWindowMs || 15 * 60 * 1000,
      inboundDedupeWindowMs: options.inboundDedupeWindowMs || 20 * 60 * 1000,
      outboundNearDuplicateWindowMs: options.outboundNearDuplicateWindowMs || 10 * 60 * 1000,
      inboundPollBootSkewMs: options.inboundPollBootSkewMs || 3000,
      inboxPollDetachedFrameCooldownMs: options.inboxPollDetachedFrameCooldownMs || 60 * 1000,
      ...options,
    };
  }

  async initialize() {
    console.log('[WhatsApp] Inicializando cliente WhatsApp...');

    const chromeExecutablePath = this._resolveChromeExecutablePath();
    console.log(`[WhatsApp] Chromium path: ${chromeExecutablePath || 'default-bundled'}`);
    const chromiumArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1280,900',
    ];
    
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.options.authPath }),
      puppeteer: {
        headless: true,
        dumpio: true,
        args: chromiumArgs,
        ...(chromeExecutablePath ? { executablePath: chromeExecutablePath } : {}),
      },
      ...(this.pairingPhoneNumber
        ? {
            pairWithPhoneNumber: {
              phoneNumber: this.pairingPhoneNumber,
              showNotification: false,
              intervalMs: 180000,
            },
          }
        : {}),
    });

    if (this.pairingPhoneNumber) {
      console.log(`[WhatsApp] Pareamento por código ativo para: ${this._maskPhone(this.pairingPhoneNumber)}`);
    }

    // Event: QR Code (para scan inicial)
    this.client.on('qr', (qr) => {
      console.log('[WhatsApp] QR Code recebido');
      this.qrData = qr;
      qrcode.toFile(path.join(__dirname, '..', 'qr.png'), qr).catch(e => console.error(e));
      if (!this.pairingPhoneNumber) {
        qrcode.toString(qr, { type: 'terminal', small: true }, (err, terminalQr) => {
          if (err) {
            console.error('[WhatsApp] Falha ao renderizar QR no terminal:', err.message);
            return;
          }

          console.log('[WhatsApp] Escaneie o QR abaixo com o WhatsApp:');
          console.log(terminalQr);
        });
      }
      console.log('[WhatsApp] QR salvo em qr.png — scan com seu celular');
    });

    this.client.on('code', (code) => {
      console.log('[WhatsApp] Código de pareamento recebido:');
      console.log(`[WhatsApp] ${code}`);
    });

    // Event: Pronto
    this.client.on('ready', async () => {
      this.ready = true;
      await this._captureLegacyContacts();
      console.log('[WhatsApp] ✅ Bot conectado e pronto!');
      console.log(`[WhatsApp] Modo de atendimento: ${this.liveModeActive ? 'ATIVO' : 'SEGURO'}`);
    });

    // Event: Mensagem recebida
    this.client.on('message', async (msg) => {
      try {
        await this._enqueueIncomingMessage(msg);
      } catch (err) {
        console.error('[WhatsApp] Erro ao processar mensagem:', err.message);
      }
    });

    // Event: Desconectado
    this.client.on('disconnected', () => {
      this.ready = false;
      this._pauseInboundPoller('desconectado');
      console.log('[WhatsApp] ⚠️  Bot desconectado');
    });

    await this.client.initialize();
    this._startProactiveFollowupScheduler();
    this._startInboundPoller();
  }

  async _handleIncomingMessage(msg) {
    // Ignora mensagens do bot
    if (msg.fromMe) return;

    // Ignora grupos (por enquanto)
    if (msg.isGroupMsg) {
      console.log('[WhatsApp] Mensagem de grupo ignorada');
      return;
    }

    const nowMs = Date.now();
    const msgTsMs = Number(msg?.timestamp || 0) * 1000;
    const hasValidTimestamp = Number.isFinite(msgTsMs) && msgTsMs > 0;
    const isBootBacklogMessage = hasValidTimestamp
      && msgTsMs < (this.inboundPollBootAtMs - this.options.inboundPollBootSkewMs)
      && (nowMs - msgTsMs) > this.options.inboxPollRecentWindowMs;
    if (isBootBacklogMessage) {
      console.log('[WhatsApp] Mensagem antiga ignorada no boot/reconexão.');
      return;
    }

    const senderInfo = await this._resolveSenderInfo(msg);
    const phone = this._resolveConversationPhone(senderInfo);
    const contact = senderInfo.contact;
    const clientName = senderInfo.clientName;
    const replyTarget = String(contact?.id?._serialized || msg.from || '');

    let messageText = String(msg?.body || '').trim();
    const hasMedia = !!msg?.hasMedia;
    let audioAttempted = false;
    let audioReason = '';
    const quotedInfo = await this._resolveQuotedMessageInfo(msg);

    if (!messageText && hasMedia) {
      const transcription = await this._transcribeIncomingAudio(msg);
      audioAttempted = transcription.attempted;
      audioReason = transcription.reason;
      messageText = String(transcription.text || '').trim();
    }

    if (!messageText) {
      if (audioAttempted) {
        const intakeDecision = this._evaluateLeadEligibility(phone, senderInfo.candidates);
        if (intakeDecision.allowed && !this._isLeadUnderManualTakeover(phone)) {
          const isFirstForFallback = this._isFirstReplyInConversation(phone, nowMs);
          const fallbackDelayMs = this._getResponseDelayMs(isFirstForFallback);
          await this._wait(fallbackDelayMs);
          await this._sendMessage(replyTarget, this._buildAudioFallbackMessage(audioReason));
        }
      }
      return;
    }

    messageText = this._stripRecentBotQuoteFromIncoming(phone, messageText);
    if (!messageText) {
      return;
    }

    if (this._isLikelyAutoReplyMessage(messageText)) {
      console.log(`[WhatsApp] Auto-resposta detectada e ignorada para ${phone}.`);
      return;
    }

    if (this._isLikelyEchoOfRecentBotMessage(phone, messageText, nowMs)) {
      console.log(`[WhatsApp] Eco de mensagem do bot ignorado para ${phone}.`);
      return;
    }

    const isOwnerSender = this._isOwnerFromCandidates(senderInfo.candidates) || this._isOwnerPhone(senderInfo.phone);
    if (isOwnerSender && this._isOwnerCommand(messageText)) {
      await this._handleOwnerCommand(msg.from, messageText);
      return;
    }

    if (this._isLeadOptedOut(phone)) {
      if (this._isResumeIntentMessage(messageText)) {
        this._clearLeadOptOut(phone);
        console.log(`[WhatsApp] Lead ${phone} retomou interesse. Opt-out removido.`);
      } else {
        console.log(`[WhatsApp] Lead ${phone} está opt-out. Mensagem ignorada.`);
        return;
      }
    }

    const hasRecentAliasActivity = this._hasRecentActivityAcrossSenderAliases(senderInfo, nowMs);
    const isFirstInConversation = this._isFirstReplyInConversation(phone, nowMs) && !hasRecentAliasActivity;
    this._setLastInboundAt(phone, nowMs);

    const intakeDecision = this._evaluateLeadEligibility(phone, senderInfo.candidates);
    if (!intakeDecision.allowed) {
      if (intakeDecision.convertToManual) {
        this.legacyManualContacts.add(phone);
      }
      console.log(`[WhatsApp] Lead ${phone} ignorado (${intakeDecision.reason}).`);
      return;
    }

    if (this._isLeadUnderManualTakeover(phone)) {
      await this._notifyOwnerLeadMessageDuringTakeover(phone, clientName, messageText);
      console.log(`[WhatsApp] Lead ${phone} está em assunção manual. Bot não responderá.`);
      return;
    }

    if (this._isExplicitNoBuyMessage(messageText)) {
      this._markLeadOptOut(phone, messageText);
      const state = this.replyTimingState.get(phone) || {};
      const lastAck = Number(state.optOutAckSentAtMs || 0);
      const now = Date.now();
      if (!lastAck || (now - lastAck) > (12 * 60 * 60 * 1000)) {
        const responseDelayMs = this._getResponseDelayMs(isFirstInConversation);
        await this._wait(responseDelayMs);
        await this._sendMessage(replyTarget, 'Perfeito, sem problemas. Não vou te enviar novas mensagens por aqui. Se mudar de ideia, é só me chamar.');
        this.replyTimingState.set(phone, {
          ...state,
          optOutAckSentAtMs: now,
        });
      }
      return;
    }

    if (this._isCallRequestMessage(messageText)) {
      const responseDelayMs = this._getResponseDelayMs(isFirstInConversation);
      await this._wait(responseDelayMs);
      await this._sendMessage(replyTarget, this._buildCallRequestMessage());
      await this._notifyOwnerCallRequest(phone, clientName, messageText);
      console.log(`[WhatsApp] Pedido de ligação detectado para ${phone}. Encaminhado ao dono.`);
      return;
    }

    if (this._isCriticalClosingGuardActive(phone, nowMs)) {
      await this._notifyOwnerCriticalGuardLeadMessage(phone, clientName, messageText);
      const guardDelayMs = this._randomInt(this.options.conversationDelayMinMs, this.options.conversationDelayMaxMs);
      await this._wait(guardDelayMs);
      await this._sendMessage(replyTarget, this._buildCriticalClosingGuardMessage());
      console.log(`[WhatsApp] Lead ${phone} em modo proteção de fechamento.`);
      return;
    }

    console.log(`[WhatsApp] Mensagem de ${phone} (${clientName || 'sem nome'}): "${messageText.slice(0, 50)}"`);
    if (quotedInfo?.text) {
      console.log(`[WhatsApp] Resposta citando: "${quotedInfo.text.slice(0, 70)}"`);
    }

    this._registerUserTurn(phone, messageText);

    // Processa a mensagem no bot
    const response = await bot.handleMessage(phone, messageText, null, {
      quotedMessage: quotedInfo?.text || null,
      quotedAuthor: quotedInfo?.author || null,
      quotedIsBot: !!quotedInfo?.fromMe,
    });

    if (!response || !response.messages) {
      console.error('[WhatsApp] Resposta inválida do bot');
      return;
    }

    const baseMessages = Array.isArray(response.messages)
      ? response.messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (baseMessages.length === 0) {
      baseMessages.push('Entendi. Pode me contar um pouco mais do seu cenário para eu te orientar melhor?');
    }

    const shouldActivateGuard = this._shouldActivateCriticalClosingGuard(response);
    const shouldHoldForNegotiationReview = !shouldActivateGuard
      && this._shouldEscalateNegotiationReview(response, messageText);
    let outgoingMessages = baseMessages;
    let outgoingMediaFiles = [];

    if (shouldActivateGuard) {
      this._activateCriticalClosingGuard(phone);
      outgoingMessages = [this._buildCriticalClosingGuardMessage()];
      await this._maybeNotifyAdvancedNegotiation(phone, clientName, response, messageText);
    }

    if (shouldHoldForNegotiationReview) {
      outgoingMessages = [this._buildNegotiationReviewMessage()];
      outgoingMediaFiles = [];
      await this._notifyOwnerNegotiationReview(phone, clientName, response, messageText);
    }

    if (!shouldActivateGuard && !shouldHoldForNegotiationReview) {
      const mediaPlan = this._buildMediaPlan(phone, response, messageText, outgoingMessages);
      if (mediaPlan.messages.length > 0) {
        outgoingMessages = [...outgoingMessages, ...mediaPlan.messages];
      }
      if (mediaPlan.files.length > 0) {
        outgoingMessages = this._removeMediaConfirmationPrompts(outgoingMessages);
        outgoingMediaFiles = mediaPlan.files;
        outgoingMessages = this._compressMediaNarration(outgoingMessages);
      }
    }

    outgoingMessages = this._sanitizeOutgoingMessages(outgoingMessages, response.stage, phone, messageText);
    outgoingMessages = this._enforceConversationalFlow(outgoingMessages, {
      stage: response.stage,
      phone,
      isFirstInConversation,
      incomingText: messageText,
      nowMs,
    });
    outgoingMessages = this._applyDecisionHoldOverride(outgoingMessages, response.stage, messageText, phone);
    outgoingMessages = this._ensureFullPackageCatalogMessages(outgoingMessages, messageText);
    outgoingMessages = this._applySemanticProgressionGuard(outgoingMessages, response.stage, phone, messageText);
    outgoingMessages = this._applyCoherenceGuard(outgoingMessages, {
      stage: response.stage,
      phone,
      incomingText: messageText,
    });

    // Delay antes da primeira resposta: ~15s. Nas demais, 5-20s.
    const responseDelayMs = this._getResponseDelayMs(isFirstInConversation);
    await this._wait(responseDelayMs);

    // Envia as mensagens de volta
    for (let i = 0; i < outgoingMessages.length; i++) {
      const msgText = outgoingMessages[i];
      await this._sendMessage(replyTarget, msgText);

      // Delay entre mensagens da mesma resposta para evitar envio "automático".
      if (i < outgoingMessages.length - 1) {
        const pauseMs = this._getBetweenMessagesDelayMs(msgText);
        await this._wait(pauseMs);
      }
    }

    for (let i = 0; i < outgoingMediaFiles.length; i++) {
      const mediaPath = outgoingMediaFiles[i];
      await this._sendMediaFile(replyTarget, mediaPath);
    }

    this._rememberQuestionIntents(phone, outgoingMessages);

    const state = this.replyTimingState.get(phone) || {};
    this.replyTimingState.set(phone, {
      ...state,
      hasReplied: true,
    });

    if (!shouldActivateGuard && !shouldHoldForNegotiationReview) {
      await this._maybeNotifyAdvancedNegotiation(phone, clientName, response, messageText);
    }

    // Log final
    console.log(`[WhatsApp] Respostas enviadas | Stage: ${response.stage} | Score: ${response.score}`);
  }

  async _resolveQuotedMessageInfo(msg) {
    try {
      if (!msg || !msg.hasQuotedMsg || typeof msg.getQuotedMessage !== 'function') {
        return null;
      }

      const quoted = await msg.getQuotedMessage();
      if (!quoted) {
        return null;
      }

      const quotedText = String(quoted.body || '').trim();
      if (!quotedText) {
        return null;
      }

      return {
        text: quotedText,
        author: String(quoted.author || quoted.from || '').trim() || null,
        fromMe: !!quoted.fromMe,
      };
    } catch (err) {
      console.error('[WhatsApp] Falha ao ler mensagem citada:', err.message);
      return null;
    }
  }

  _isAudioMessage(msg) {
    const type = String(msg?.type || '').toLowerCase();
    return !!msg?.hasMedia && (type === 'ptt' || type === 'audio' || type === 'voice');
  }

  _isAudioMimetype(mimetype) {
    const normalized = String(mimetype || '').toLowerCase();
    return normalized.startsWith('audio/');
  }

  async _transcribeIncomingAudio(msg) {
    try {
      const media = await msg.downloadMedia();
      if (!media) {
        console.log('[WhatsApp] Áudio recebido, mas não foi possível baixar a mídia.');
        return { text: '', attempted: false, reason: 'media_download_failed' };
      }

      const looksLikeAudio = this._isAudioMessage(msg) || this._isAudioMimetype(media?.mimetype);
      if (!looksLikeAudio) {
        return { text: '', attempted: false, reason: 'not_audio' };
      }

      const result = await transcribeAudioMedia(media, {
        fileName: media?.filename || 'whatsapp-audio.ogg',
        mimeType: media?.mimetype || 'audio/ogg',
      });
      const text = String(result?.text || '').trim();
      const reason = String(result?.reason || 'unknown').trim();

      if (!text) {
        console.log(`[WhatsApp] Áudio sem texto utilizável (motivo: ${reason || 'desconhecido'}).`);
        return { text: '', attempted: true, reason };
      }

      console.log(`[WhatsApp] Áudio transcrito: "${text.slice(0, 80)}"`);
      return { text, attempted: true, reason: 'ok' };
    } catch (err) {
      console.error('[WhatsApp] Falha ao transcrever áudio:', err.message);
      return { text: '', attempted: true, reason: 'transcription_error' };
    }
  }

  _buildAudioFallbackMessage(reason = '') {
    if (reason === 'missing_api_key') {
      return 'Recebi seu áudio, mas não consegui ouvir por aqui. Se preferir, pode me mandar em texto ou reenviar o áudio.';
    }

    if (reason === 'media_download_failed' || reason === 'empty_media_data' || reason === 'empty_audio_buffer') {
      return 'Recebi seu áudio, mas não consegui ouvir por aqui. Se puder, me envie novamente em texto ou em áudio para eu te responder agora.';
    }

    return 'Recebi seu áudio, mas não consegui entender por aqui. Pode me enviar novamente em texto ou em áudio?';
  }

  _sanitizeOutgoingMessages(messages, stage = '', phone = '', incomingText = '') {
    const list = Array.isArray(messages) ? messages : [];
    const normalizedSeen = [];
    const sanitized = [];
    const oneQuestionStages = new Set(['conexao', 'diagnostico']);
    let questionsUsed = 0;
    const recentIntents = this._getRecentQuestionIntents(phone);
    const knownName = String(bot.dialog.getState(phone)?.name || '').trim();
    const mediaState = this.replyTimingState.get(phone) || {};
    const videosAlreadySent = !!mediaState.mediaVideosSent;
    const recentBotNormalized = this._getRecentBotMessagesInWindowNormalized(
      phone,
      this.options.outboundNearDuplicateWindowMs,
      12
    );

    for (const raw of list) {
      const text = this._applyMediaScopeGuards(
        this._applyCatalogTruthGuards(
          this._applyPricingIntegrityGuard(
            this._applyCommercialValueGuards(this._stripEmojis(String(raw || '').trim()))
          )
        ),
        phone
      );
      if (!text) continue;

      const normalized = this._normalizeMessageForCompare(text);
      if (!normalized) continue;

      if (this._isBannedPromptPattern(normalized)) {
        continue;
      }

      const isDuplicate = normalizedSeen.some((prev) => {
        if (prev === normalized) return true;
        if (prev.length >= 18 && normalized.includes(prev)) return true;
        if (normalized.length >= 18 && prev.includes(normalized)) return true;
        return false;
      });
      if (isDuplicate) {
        continue;
      }

      const repeatsRecentBot = recentBotNormalized.some((prev) => {
        if (!prev) return false;
        return this._isNearDuplicateNormalized(prev, normalized);
      });
      if (repeatsRecentBot) {
        continue;
      }

      const hasQuestion = /\?/.test(text);
      const questionIntent = hasQuestion ? this._classifyQuestionIntent(text) : '';
      if (videosAlreadySent && this._isVideoReofferMessage(text)) {
        continue;
      }

      if (questionIntent === 'ask_name' && knownName) {
        continue;
      }

      if (questionIntent && recentIntents.has(questionIntent)) {
        continue;
      }

      if (questionIntent && this._shouldDeferQuestionIntent(phone, questionIntent)) {
        continue;
      }

      if (hasQuestion && oneQuestionStages.has(String(stage || '').toLowerCase())) {
        if (questionsUsed >= 1) {
          continue;
        }
        questionsUsed += 1;
      }

      normalizedSeen.push(normalized);
      sanitized.push(text);
    }

    if (sanitized.length === 0) {
      return this._buildContextualFallbackMessages(incomingText, phone, stage);
    }

    return sanitized;
  }

  _isBannedPromptPattern(normalizedText = '') {
    const t = String(normalizedText || '').trim();
    if (!t) return false;
    return /(me conta qual ponto voce quer resolver primeiro|ponto principal que voce quer resolver agora)/.test(t);
  }

  _buildContextualFallbackMessages(incomingText = '', phone = '', stage = '') {
    const normalizedIncoming = this._normalizeMessageForCompare(incomingText);
    const asksForCatalog = this._looksLikeCatalogRequest(incomingText);
    const requestedProducts = this._findRequestedCatalogProducts(incomingText);
    const asksSmallerToys = /(brinquedos menores|so os menores|s[oó] os menores|itens menores|s[oó] os brinquedos menores)/.test(normalizedIncoming || '');
    const mentionsExistingStoreMove = /(ja tenho a loja|já tenho a loja|tenho a loja|de mudanc|de mudanç|novo lugar|novo espaco|novo espaço|mudar de loja|mudando de loja|estou de mudanc|estou de mudanç)/.test(normalizedIncoming || '');
    const isShortAffirmation = /^(sim|isso|ok|certo|tenho|ja tenho|já tenho)$/i.test(String(normalizedIncoming || '').trim());

    if (asksForCatalog) {
      return this._buildFullPackageCatalogMessages();
    }

    if (isShortAffirmation) {
      const pendingFollowup = this._buildPendingIntentFollowup(phone, incomingText);
      if (pendingFollowup.length > 0) {
        return pendingFollowup;
      }
    }

    const areaInfo = this._extractAreaFromText(incomingText);
    if (areaInfo) {
      return ['Perfeito, obrigado por compartilhar isso. Para eu te direcionar com objetividade, me diz se você está iniciando a operação kids ou se já trabalha com isso, e se sua necessidade é imediata ou se ainda está avaliando.'];
    }

    if (asksSmallerToys) {
      return [
        'Os brinquedos menores podem ser vendidos separadamente, sim.',
        'Hoje estamos dando prioridade para a venda em conjunto com o Brinquedão.',
        'Se eles ainda estiverem disponíveis após a venda do Brinquedão, conseguimos vender separado. Você prefere avaliar o Brinquedão agora ou quer que eu monte uma condição para pacote com todos os brinquedos?',
      ];
    }

    if (requestedProducts.length > 0) {
      const products = requestedProducts.length > 0
        ? requestedProducts
        : this._getDefaultSmallToysProducts();

      const names = products.map((p) => p.nome);
      const prices = products.map((p) => `${p.nome}: ${p.preco}`);
      const firstLine = names.length > 1
        ? `Perfeito, temos sim opções menores, incluindo ${names.join(', ')}.`
        : `Perfeito, temos sim esse item: ${names[0]}.`;

      const secondLine = `Valores avulsos desses itens: ${prices.join('; ')}.`;
      return [
        firstLine,
        secondLine,
        'Se você quiser, eu já separo os itens que mais te interessam e monto a melhor condição para você.',
      ];
    }

    if (mentionsExistingStoreMove) {
      return [
        'Perfeito, entendi que você já tem operação e está na mudança de espaço.',
        'Para eu te orientar com precisão, me passa o tamanho aproximado do novo espaço e a previsão de mudança.',
      ];
    }

    if (String(stage || '').toLowerCase() === 'unknown') {
      return ['Entendi seu ponto. Me diz qual item você quer priorizar agora para eu te responder de forma objetiva?'];
    }

    return ['Entendi. Para eu te direcionar com objetividade, me diz se você quer montar do zero ou complementar uma operação que já existe, e qual seu prazo de decisão, imediato ou ainda em avaliação.'];
  }

  _looksLikeCatalogRequest(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;
    return /(catalogo|catalog|catalogo|tem catalogo|tem catalog|lista de produtos|lista dos produtos|quais brinquedos voces tem|quais brinquedos voces possuem|quais itens voces tem|me manda a lista|enviar a lista)/.test(normalized);
  }

  _buildPendingIntentFollowup(phone = '', incomingText = '') {
    const state = this.replyTimingState.get(phone) || {};
    const pending = (state.pendingQuestionByIntent && typeof state.pendingQuestionByIntent === 'object')
      ? state.pendingQuestionByIntent
      : {};
    const intents = Object.keys(pending);
    if (intents.length === 0) {
      return [];
    }

    const areaInfo = this._extractAreaFromText(incomingText);
    if (areaInfo && (pending.ask_space_type || pending.ask_situation)) {
      return ['Perfeito. Com isso em mente, me diz se você está iniciando a operação kids ou se já trabalha com isso, e se sua necessidade é imediata ou ainda está avaliando.'];
    }

    if (pending.ask_space_type || pending.ask_situation) {
      return ['Perfeito. Me diz se você está iniciando a operação kids ou se já atua no segmento, e se já tem prazo para iniciar.'];
    }

    if (pending.ask_goal) {
      return ['Perfeito. Me diz qual resultado você quer priorizar nesse espaço, aumentar permanência das famílias, recorrência ou ticket médio.'];
    }

    if (pending.ask_budget) {
      return ['Perfeito. Me passa uma faixa de investimento para eu te sugerir a melhor configuração dentro da sua realidade.'];
    }

    return [];
  }

  _applyCoherenceGuard(messages, { stage = '', phone = '', incomingText = '' } = {}) {
    const list = Array.isArray(messages)
      ? messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (list.length === 0) {
      return this._buildContextualFallbackMessages(incomingText, phone, stage);
    }

    const normalizedStage = String(stage || '').toLowerCase();
    if (['negociacao', 'fechamento'].includes(normalizedStage)) {
      return list;
    }

    const normalizedList = list
      .map((m) => this._normalizeMessageForCompare(m))
      .filter(Boolean);
    if (normalizedList.length === 0) {
      return this._buildCoherenceRecoveryMessages(phone, incomingText, stage);
    }

    const recentBot = this._getRecentBotMessagesInWindowNormalized(
      phone,
      this.options.outboundNearDuplicateWindowMs,
      14
    );
    const repeatedAgainstRecent = normalizedList.filter((msg) => {
      return recentBot.some((prev) => {
        if (!prev) return false;
        return this._isNearDuplicateNormalized(msg, prev);
      });
    }).length;

    const genericCount = list.filter((msg) => this._isLowContextGenericMessage(msg)).length;
    const onlyGeneric = genericCount === list.length;
    const mostlyRepeated = repeatedAgainstRecent >= Math.max(1, normalizedList.length - 1);

    if (!onlyGeneric && !mostlyRepeated) {
      return list;
    }

    const recovered = this._buildCoherenceRecoveryMessages(phone, incomingText, stage);
    if (recovered.length === 0) {
      return list;
    }

    return recovered;
  }

  _buildCoherenceRecoveryMessages(phone = '', incomingText = '', stage = '') {
    const pendingFollowup = this._buildPendingIntentFollowup(phone, incomingText);
    if (pendingFollowup.length > 0) {
      return pendingFollowup;
    }

    const normalizedIncoming = this._normalizeMessageForCompare(incomingText);
    if (!normalizedIncoming) {
      return ['Para eu te direcionar com objetividade, me diz se você quer montar do zero ou complementar uma operação que já existe, e se a decisão é para agora ou ainda está em avaliação.'];
    }

    const areaInfo = this._extractAreaFromText(incomingText);
    if (areaInfo) {
      return ['Perfeito, anotado. Agora me diz se você está iniciando a operação kids ou se já trabalha com isso, e se a necessidade é imediata ou de avaliação.'];
    }

    const hasOperationalContext = /(restaurante|hamburgueria|loja|buffet|espaco|espaço|mudanc|mudanç|parque|kids|familia|fam[ií]lia|clientes)/.test(normalizedIncoming);
    if (hasOperationalContext) {
      return [
        'Perfeito, entendi seu cenário.',
        'Para eu te direcionar sem perder tempo, me diz se você quer montar do zero ou complementar uma operação que já existe, e qual seu prazo de decisão.',
      ];
    }

    if (String(stage || '').toLowerCase() === 'conexao') {
      return ['Perfeito. Para eu te orientar melhor, me diz se você vai montar um espaço novo ou complementar um que já existe.'];
    }

    return ['Para te responder com precisão, me diz se você quer montar do zero ou complementar uma operação que já existe, e se sua decisão é imediata ou ainda está em avaliação.'];
  }

  _isLowContextGenericMessage(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return true;

    const genericPatterns = [
      /entendi me conta um pouco mais/,
      /me conta um pouco mais para eu te ajudar/,
      /me conta um pouco mais do seu cenario/,
      /me diz qual item voce quer priorizar/,
      /qual e a sua prioridade/,
      /para eu te ajudar da melhor forma/,
    ];
    if (genericPatterns.some((re) => re.test(normalized))) {
      return true;
    }

    const isTooAbstract = /(entendi|perfeito|certo|otimo)/.test(normalized)
      && !/(espaco|espaço|prazo|inicio|iniciar|operacao|operação|investimento|orcamento|orçamento|produto|item|brinquedo|catalogo|cat[aá]logo|valor|preco|preço)/.test(normalized);
    return isTooAbstract;
  }

  _getRecentBotMessagesNormalized(phone, limit = 8) {
    if (!bot.dialog || typeof bot.dialog.getHistory !== 'function') {
      return [];
    }

    const history = bot.dialog.getHistory(phone, Math.max(limit * 2, 12));
    const out = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item?.from !== 'bot') continue;
      const normalized = this._normalizeMessageForCompare(item?.text || '');
      if (!normalized) continue;
      out.push(normalized);
      if (out.length >= limit) break;
    }
    return out;
  }

  _getRecentBotMessagesInWindowNormalized(phone, windowMs = 10 * 60 * 1000, limit = 10) {
    if (!bot.dialog || typeof bot.dialog.getHistory !== 'function') {
      return [];
    }

    const history = bot.dialog.getHistory(phone, Math.max(limit * 3, 20));
    const nowMs = Date.now();
    const out = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item?.from !== 'bot') continue;

      const ts = Date.parse(String(item?.timestamp || ''));
      if (Number.isFinite(ts) && (nowMs - ts) > windowMs) {
        break;
      }

      const normalized = this._normalizeMessageForCompare(item?.text || '');
      if (!normalized) continue;
      out.push(normalized);
      if (out.length >= limit) break;
    }
    return out;
  }

  _isNearDuplicateNormalized(a = '', b = '') {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    if (!left || !right) return false;
    if (left === right) return true;

    if (left.length >= 20 && right.includes(left)) return true;
    if (right.length >= 20 && left.includes(right)) return true;

    const leftTokens = left.split(' ').filter(Boolean);
    const rightTokens = right.split(' ').filter(Boolean);
    if (leftTokens.length === 0 || rightTokens.length === 0) return false;

    const rightSet = new Set(rightTokens);
    let shared = 0;
    for (const t of leftTokens) {
      if (rightSet.has(t)) shared += 1;
    }

    const overlap = shared / Math.max(leftTokens.length, rightTokens.length);
    return overlap >= 0.82;
  }

  _isLikelyEchoOfRecentBotMessage(phone, incomingText = '', nowMs = Date.now()) {
    const normalizedIncoming = this._normalizeMessageForCompare(incomingText);
    if (!normalizedIncoming || normalizedIncoming.length < 8) {
      return false;
    }

    if (!bot.dialog || typeof bot.dialog.getHistory !== 'function') {
      return false;
    }

    const recent = bot.dialog.getHistory(phone, 8);
    const windowMs = 3 * 60 * 1000;

    for (let i = recent.length - 1; i >= 0; i--) {
      const item = recent[i];
      if (item?.from !== 'bot') continue;
      const ts = Date.parse(String(item?.timestamp || ''));
      if (Number.isFinite(ts) && (nowMs - ts) > windowMs) {
        break;
      }

      const normalizedBot = this._normalizeMessageForCompare(item?.text || '');
      if (!normalizedBot) continue;

      const isSame = normalizedBot === normalizedIncoming;
      const isContained = normalizedBot.length >= 20 && normalizedIncoming.includes(normalizedBot);
      if (isSame || isContained) {
        return true;
      }
    }

    return false;
  }

  _stripRecentBotQuoteFromIncoming(phone, incomingText = '') {
    const raw = String(incomingText || '').trim();
    if (!raw) return '';

    const lines = raw
      .split(/\r?\n+/)
      .map((line) => String(line || '').trim())
      .filter(Boolean);
    if (lines.length === 0) return '';

    const recentBotNormalized = this._getRecentBotMessagesNormalized(phone, 6);
    if (recentBotNormalized.length === 0) {
      return raw;
    }

    const kept = lines.filter((line) => {
      const normLine = this._normalizeMessageForCompare(line);
      if (!normLine || normLine.length < 12) {
        return true;
      }

      const matchesRecentBot = recentBotNormalized.some((botLine) => {
        if (!botLine || botLine.length < 12) return false;
        if (normLine === botLine) return true;
        if (normLine.length >= 20 && normLine.includes(botLine)) return true;
        return false;
      });

      return !matchesRecentBot;
    });

    return kept.join(' ').trim();
  }

  _findRequestedCatalogProducts(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return [];

    const products = Array.isArray(this.salesCatalog?.products)
      ? this.salesCatalog.products.filter((p) => p && p.nome && p.preco)
      : [];
    if (products.length === 0) return [];

    const matchers = [
      { key: 'fliperama', test: /(fliperama|arcade|multijogos)/ },
      { key: 'air game', test: /(air game|joguinho de dis|jogo de disco|mesa de ar|hockey de mesa)/ },
      { key: 'pebolim', test: /(pebolim|tot[oó])/ },
      { key: 'basquete', test: /(basquete)/ },
      { key: 'mesinha', test: /(mesinha|mesa infantil|madeira infantil)/ },
      { key: 'espumados', test: /(espumad)/ },
      { key: 'area baby', test: /(area baby|[aá]rea baby|baby)/ },
      { key: 'cenografias', test: /(cenografia|mercadinho|pet shop|cozinha)/ },
      { key: 'parede de escalada', test: /(escalada|parede)/ },
    ];

    const matched = [];
    for (const rule of matchers) {
      if (!rule.test.test(normalized)) continue;
      const product = products.find((p) => this._normalizeMessageForCompare(p.nome).includes(rule.key));
      if (product && !matched.some((m) => m.nome === product.nome)) {
        matched.push(product);
      }
    }

    return matched.slice(0, 4);
  }

  _getDefaultSmallToysProducts() {
    const products = Array.isArray(this.salesCatalog?.products)
      ? this.salesCatalog.products.filter((p) => p && p.nome && p.preco)
      : [];
    return products
      .filter((p) => !/brinqued[aã]o/i.test(String(p.nome || '')))
      .slice(0, 4);
  }

  _applyCommercialValueGuards(text) {
    let out = String(text || '').trim();
    if (!out) return out;

    const totalAvulso = String(this.salesCatalog?.fullSet?.valorSomaAvulsa || '').trim();
    if (!totalAvulso) {
      return out;
    }

    const escapedTotal = totalAvulso
      .replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      .replace(/\s+/g, '\\s*');
    const totalRegex = new RegExp(escapedTotal, 'i');
    if (!totalRegex.test(out)) {
      return out;
    }

    // Guardrail from KB:
    // - total avulso = soma avulsa dos itens
    // - Estrutura completa equivalente nova = nao menos de R$ 80.000,00
    out = out.replace(
      new RegExp(`essa\\s+mesma\\s+estrutura\\s+nova\\s+sai\\s+por\\s+${escapedTotal}`, 'ig'),
      'uma estrutura completa equivalente nova não sai por menos de R$ 80.000,00'
    );

    out = out.replace(
      new RegExp(`os\\s+mesmos\\s+itens\\s+novos\\s+saem\\s+por\\s+${escapedTotal}`, 'ig'),
      `a soma avulsa dos itens desta oferta chega a ${totalAvulso}`
    );

    out = out.replace(
      new RegExp(`estrutura\\s+nova\\s+sai\\s+por\\s+${escapedTotal}`, 'ig'),
      'estrutura completa equivalente nova: não menos de R$ 80.000,00'
    );

    return out;
  }

  _applyCatalogTruthGuards(text) {
    let out = String(text || '').trim();
    if (!out) return out;

    out = out.replace(
      /[aá]l[eé]m do brinqued[aã]o[^.]*cenografi[aá][^.]*decora[cç][aã]o[^.]*/ig,
      'além do Brinquedão, hoje trabalhamos com Área Baby e Espumados'
    );

    out = out.replace(/(?:mais\s+algumas\s+)?pe[cç]as de cenografi[aá] e decora[cç][aã]o/ig, 'Área Baby e Espumados');
    return out;
  }

  _applyPricingIntegrityGuard(text) {
    const out = String(text || '').trim();
    if (!out) return out;

    if (!this._hasUnknownPriceToken(out)) {
      return out;
    }

    return 'Para te passar valores com total segurança, eu trabalho só com a tabela oficial já cadastrada. Se você quiser, eu te envio agora os preços oficiais de cada item e as condições válidas.';
  }

  _hasUnknownPriceToken(text) {
    const tokens = this._extractCurrencyTokens(text);
    if (tokens.length === 0) return false;

    const allowed = this.pricingPolicy?.allowedTokens;
    if (!(allowed instanceof Set) || allowed.size === 0) {
      return false;
    }

    return tokens.some((token) => !allowed.has(token));
  }

  _extractCurrencyTokens(text) {
    const raw = String(text || '');
    if (!raw) return [];

    const matches = raw.match(/R\$\s*\d[\d\.,]*/gi) || [];
    const out = [];
    for (const m of matches) {
      const token = this._normalizeCurrencyToken(m);
      if (token) out.push(token);
    }
    return out;
  }

  _normalizeCurrencyToken(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || '';
  }

  _hasFullPackageInterestSignal(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(outros brinquedos|todos os brinquedos|pacote completo|levar tudo|leva tudo|o que mais tem|quais brinquedos|quero todos|interesse em todos|quanto sai tudo|quanto sai o pacote completo|quanto que voce faz todos|quanto voce faz todos|quanto fica tudo|quanto fica o pacote completo|valor de tudo|preco de tudo)/.test(normalized);
  }

  _buildFullPackageCatalogMessages() {
    const products = Array.isArray(this.salesCatalog?.products)
      ? this.salesCatalog.products.filter((p) => p && p.nome && p.preco)
      : [];

    if (products.length === 0) {
      return [
        'Perfeito, te passo os itens disponíveis e os valores avulsos com base na nossa tabela oficial.',
        'Se você quiser levar o pacote completo, eu monto uma condição negociada com desconto relevante para fechar o conjunto.',
      ];
    }

    const messages = [
      'Perfeito, te passo agora a lista completa dos brinquedos disponíveis com valores avulsos.',
    ];

    const lines = products.map((p) => `${p.nome}: ${p.preco}`);
    const chunkSize = 4;
    for (let i = 0; i < lines.length; i += chunkSize) {
      messages.push(lines.slice(i, i + chunkSize).join('\n'));
    }

    const totalAvulso = String(this.salesCatalog?.fullSet?.valorSomaAvulsa || '').trim();
    if (totalAvulso) {
      messages.push(`Somando os valores avulsos da lista completa, a referência fica em ${totalAvulso}.`);
    }

    const valorInicial = String(this.salesCatalog?.fullSet?.valorInicialNegociacao || '').trim();
    const negociacao = String(this.salesCatalog?.fullSet?.valorNegociacao || '').trim();
    if (valorInicial && negociacao) {
      const negociacaoLimpa = negociacao.replace(/^at[eé]\s+/i, '').trim();
      messages.push(`Para quem leva o conjunto completo, a gente pode começar em ${valorInicial} à vista e chegar até ${negociacaoLimpa || negociacao} conforme a negociação andar.`);
    }

    if (negociacao) {
      const negociacaoTexto = /^at[eé]\s/i.test(negociacao)
        ? negociacao
        : `até ${negociacao}`;
      if (!valorInicial) {
        messages.push(`No pacote completo, conseguimos negociar condição especial com desconto relevante, chegando ${negociacaoTexto} conforme avanço da negociação.`);
      }
    } else {
      messages.push('No pacote completo, conseguimos negociar condição especial com desconto relevante.');
    }

    return messages;
  }

  _ensureFullPackageCatalogMessages(messages, incomingText = '') {
    const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
    if (!this._hasFullPackageInterestSignal(incomingText)) {
      return list;
    }

    const normalized = list.map((m) => this._normalizeMessageForCompare(m));
    const alreadyHasCatalog = normalized.some((m) => /lista completa|valores avulsos|somando os valores avulsos/.test(m || ''));

    if (alreadyHasCatalog) {
      return list;
    }

    return this._buildFullPackageCatalogMessages();
  }

  _applyMediaScopeGuards(text, phone = '') {
    let out = String(text || '').trim();
    if (!out) return out;

    const state = this.replyTimingState.get(phone) || {};
    const hasAnyPhotoSent = !!(
      state.mediaPhotoAreaBabySent
      || state.mediaPhotoBrinquedaoSent
      || state.mediaPhotoCenografiasSent
      || state.mediaPhotoEspumadosSent
    );

    const normalized = this._normalizeMessageForCompare(out);
    if (!normalized) return out;

    // Evita prometer que "tudo das fotos" esta incluso quando essa base nao foi enviada.
    if (!hasAnyPhotoSent && /(tudo que voce viu nas fotos|nas fotos esta incluido|nas fotos est[aá] inclu[ií]do)/.test(normalized)) {
      return 'Nos videos aparecem varios itens. Se quiser, eu te detalho exatamente o que entra em cada opcao.';
    }

    return out;
  }

  _stripEmojis(text) {
    return String(text || '')
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?;:])/g, '$1')
      .trim();
  }

  _getRecentQuestionIntents(phone) {
    const state = this.replyTimingState.get(phone) || {};
    const intents = Array.isArray(state.recentAskedIntents)
      ? state.recentAskedIntents
      : bot.dialog.getQuestionIntents(phone);
    return new Set(Array.isArray(intents) ? intents.filter(Boolean) : []);
  }

  _rememberQuestionIntents(phone, messages) {
    const current = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const intent = this._classifyQuestionIntent(message);
      if (!intent) continue;
      current.push(intent);
    }

    const deduped = [];
    for (const intent of current) {
      if (deduped.includes(intent)) continue;
      deduped.push(intent);
    }

    const state = this.replyTimingState.get(phone) || {};
    const recent = Array.isArray(state.recentAskedIntents) ? state.recentAskedIntents.slice() : [];
    const pending = (state.pendingQuestionByIntent && typeof state.pendingQuestionByIntent === 'object')
      ? { ...state.pendingQuestionByIntent }
      : {};
    const userTurnCount = Number(state.userTurnCount || 0);

    for (const intent of deduped) {
      recent.push(intent);
      pending[intent] = {
        askedAtTurn: userTurnCount,
        askedAtMs: Date.now(),
      };
    }

    this.replyTimingState.set(phone, {
      ...state,
      recentAskedIntents: recent.slice(-4),
      pendingQuestionByIntent: pending,
    });

    bot.dialog.addQuestionIntents(phone, deduped.slice(-6));
  }

  _registerUserTurn(phone, messageText) {
    const state = this.replyTimingState.get(phone) || {};
    const pending = (state.pendingQuestionByIntent && typeof state.pendingQuestionByIntent === 'object')
      ? { ...state.pendingQuestionByIntent }
      : {};

    const currentSlots = (state.leadSlots && typeof state.leadSlots === 'object')
      ? { ...state.leadSlots }
      : {};
    const extractedSlots = this._extractLeadSlots(messageText);
    const mergedSlots = {
      ...currentSlots,
      ...Object.fromEntries(Object.entries(extractedSlots).filter(([, value]) => !!value)),
    };

    const nextTurn = Number(state.userTurnCount || 0) + 1;
    const answered = this._inferAnsweredQuestionIntents(phone, messageText);
    for (const intent of answered) {
      delete pending[intent];
    }

    this.replyTimingState.set(phone, {
      ...state,
      userTurnCount: nextTurn,
      pendingQuestionByIntent: pending,
      leadSlots: mergedSlots,
    });
  }

  _applySemanticProgressionGuard(messages, stage = '', phone = '', incomingText = '') {
    const list = Array.isArray(messages)
      ? messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (list.length === 0) {
      return list;
    }

    const normalizedStage = String(stage || '').toLowerCase();
    if (!['conexao', 'diagnostico', 'apresentacao', 'validacao'].includes(normalizedStage)) {
      return list;
    }

    const state = this.replyTimingState.get(phone) || {};
    const knownSlots = (state.leadSlots && typeof state.leadSlots === 'object')
      ? { ...state.leadSlots }
      : {};
    const freshSlots = this._extractLeadSlots(incomingText);
    const slots = {
      ...knownSlots,
      ...Object.fromEntries(Object.entries(freshSlots).filter(([, value]) => !!value)),
    };

    const asksArea = list.some((msg) => this._asksForSlot(msg, 'area'));
    if (asksArea && slots.area) {
      return this._buildNextQuestionByMissingSlot(slots);
    }

    const asksTimeline = list.some((msg) => this._asksForSlot(msg, 'timeline'));
    if (asksTimeline && slots.timeline) {
      return this._buildNextQuestionByMissingSlot(slots);
    }

    return list;
  }

  _buildNextQuestionByMissingSlot(slots = {}) {
    if (!slots.situation) {
      return ['Perfeito. Me diz se você está iniciando a operação kids ou se já trabalha com isso.'];
    }

    if (!slots.goal) {
      return ['Perfeito. Agora me diz o que você está buscando resolver primeiro com essa operação.'];
    }

    if (!slots.urgency) {
      return ['Ótimo. Você precisa resolver isso agora ou ainda está avaliando as opções?'];
    }

    if (!slots.timeline) {
      return ['Perfeito. Você já tem uma previsão de início da operação?'];
    }

    if (!slots.budget) {
      return ['Perfeito. Com essas informações, me passa uma faixa de investimento para eu te montar a melhor configuração.'];
    }

    return ['Perfeito, já tenho uma visão clara do cenário. Posso te mostrar a configuração que faz mais sentido para o seu caso?'];
  }

  _asksForSlot(text = '', slot = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    if (slot === 'area') {
      return /(tamanho do espaco|tamanho do espaço|metragem|quantos metros|m2|m 2|area|área)/.test(normalized);
    }
    if (slot === 'timeline') {
      return /(quando.*iniciar|prazo.*iniciar|previsao de inicio|previsao para inicio|data de abertura|quando pretende iniciar)/.test(normalized);
    }
    if (slot === 'situation') {
      return /(iniciando|comecando|começando|do zero|ja trabalho|já trabalho|ja atuo|já atuo|ja tenho estrutura|já tenho estrutura|complementar)/.test(normalized);
    }
    if (slot === 'goal') {
      return /(buscando|procuro|quero|preciso|resolver|objetivo|priorizar)/.test(normalized);
    }
    if (slot === 'urgency') {
      return /(urgente|agora|imediat|essa semana|esse mes|esse mês|depois|sem pressa|avaliando|cotando)/.test(normalized);
    }

    return false;
  }

  _extractLeadSlots(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return {};

    const out = {};
    if (/(do zero|iniciando|comecando|começando|ja trabalho|já trabalho|ja atuo|já atuo|complementar|ja tenho estrutura|já tenho estrutura)/.test(normalized)) {
      out.situation = true;
    }

    if (/(buscando|procuro|quero|preciso|resolver|objetivo|priorizar)/.test(normalized)) {
      out.goal = true;
    }

    if (/(urgente|agora|imediat|essa semana|esse mes|esse mês|depois|sem pressa|avaliando|cotando)/.test(normalized)) {
      out.urgency = true;
    }

    if (/(semana que vem|mes que vem|m[eê]s que vem|esse mes|este mes|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|dias|semanas|meses|prazo|inicio|iniciar|abrir em)/.test(normalized)) {
      out.timeline = true;
    }

    if (/(r\$|orcamento|orçamento|investimento|quanto pretende investir|faixa de investimento|capital|caixa)/.test(normalized)) {
      out.budget = true;
    }

    return out;
  }

  _shouldDeferQuestionIntent(phone, intent) {
    const state = this.replyTimingState.get(phone) || {};
    const pending = (state.pendingQuestionByIntent && typeof state.pendingQuestionByIntent === 'object')
      ? state.pendingQuestionByIntent
      : {};
    const entry = pending[intent];
    if (!entry) return false;

    const currentTurn = Number(state.userTurnCount || 0);
    const askedAtTurn = Number(entry.askedAtTurn || 0);
    const turnsSinceAsked = currentTurn - askedAtTurn;
    const minTurnsBeforeReask = 3;

    return turnsSinceAsked < minTurnsBeforeReask;
  }

  _inferAnsweredQuestionIntents(phone, text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return [];

    const answered = new Set();
    const knownName = String(bot.dialog.getState(phone)?.name || '').trim();
    if (knownName || this._extractLikelyName(text)) {
      answered.add('ask_name');
    }

    if (/(montar|abrir|objetivo|atrair|fluxo|cliente|vender|espaco kids|espaço kids|resultado)/.test(normalized)) {
      answered.add('ask_goal');
    }

    if (/(buffet|loja|restaurante|area de lazer|área de lazer|espaco|espaço|externa|interna)/.test(normalized)) {
      answered.add('ask_space_type');
    }

    if (this._extractAreaFromText(text)) {
      answered.add('ask_space_type');
    }

    if (/(do zero|ja tenho|já tenho|complementar|ja tem|já tem|estrutura|tenho um espaco|tenho uma area|tenho uma área)/.test(normalized)) {
      answered.add('ask_situation');
    }

    if (/(r\$|valor|preco|preço|orcamento|orçamento|investir|investimento|parcel|dinheiro|grana|capital|caixa)/.test(normalized)) {
      answered.add('ask_budget');
    }

    return [...answered];
  }

  _extractAreaFromText(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const normalized = this._normalizeMessageForCompare(raw);
    if (!normalized) return null;

    const match = normalized.match(/\b(\d{2,4}(?:[\.,]\d+)?)\s*(m2|m|metro|metros|metro quadrado|metros quadrados)\b/);
    if (!match) return null;

    const value = Number(String(match[1] || '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 10) {
      return null;
    }

    return {
      value,
      unit: match[2] || 'm',
    };
  }

  _classifyQuestionIntent(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return '';

    if (/(pode me dizer seu nome|com quem eu estou falando|com quem estou falando|como voce prefere ser chamado|como vc prefere ser chamado|qual e o seu nome|qual eh o seu nome|como posso te chamar|como devo te chamar|me diz seu nome|me fala seu nome)/.test(normalized)) {
      return 'ask_name';
    }

    if (/(o que voce quer montar|o que vc quer montar|qual e o seu objetivo|qual eh o seu objetivo|qual seu objetivo|me conta.*resultado|o que voce esta pensando em montar|o que vc esta pensando em montar|qual a sua necessidade|qual e a sua necessidade)/.test(normalized)) {
      return 'ask_goal';
    }

    if (/(que tipo de espaco|tipo de espaco|buffet infantil|loja|restaurante|area de lazer|espaco em mente|espaco que voce tem em mente)/.test(normalized)) {
      return 'ask_space_type';
    }

    if (/(ja tem alguma estrutura|ja tem algo|complementar algo|espaço do zero|espaco do zero|montar um espaco novo|montar um espaco do zero|complementar o que voce ja tem)/.test(normalized)) {
      return 'ask_situation';
    }

    if (/(quanto pretende investir|faixa de investimento|orcamento|orçamento|budget|valor|preco|preço|dinheiro|grana|capital|caixa|qual ponto te trava|o que te trava hoje)/.test(normalized)) {
      return 'ask_budget';
    }

    return '';
  }

  _normalizeMessageForCompare(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
  }

  _maskPhone(value) {
    const normalized = this._normalizePhone(value);
    if (!normalized) return '';
    if (normalized.length <= 4) return normalized;
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  }

  _resolveChromeExecutablePath() {
    const envPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
    const isWindows = process.platform === 'win32';

    if (isWindows && envPath && fs.existsSync(envPath)) {
      return envPath;
    }

    const linuxCandidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];

    if (!isWindows) {
      for (const candidate of linuxCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    if (!isWindows && envPath && fs.existsSync(envPath) && envPath.startsWith('/')) {
      return envPath;
    }

    const commonPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];

    for (const candidate of commonPaths) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return '';
  }

  _phoneCandidates(phone) {
    const digits = this._normalizePhone(phone);
    if (!digits) return [];

    const out = new Set([digits]);

    const addBrNinthDigitVariants = (value) => {
      const d = String(value || '');
      if (!d) return;

      // BR with country code: 55 + DDD(2) + number(8/9)
      if (d.startsWith('55')) {
        if (d.length === 12) {
          out.add(`${d.slice(0, 4)}9${d.slice(4)}`);
        }
        if (d.length === 13 && d[4] === '9') {
          out.add(`${d.slice(0, 4)}${d.slice(5)}`);
        }
      }

      // BR without country code: DDD(2) + number(8/9)
      if (!d.startsWith('55')) {
        if (d.length === 10) {
          out.add(`${d.slice(0, 2)}9${d.slice(2)}`);
        }
        if (d.length === 11 && d[2] === '9') {
          out.add(`${d.slice(0, 2)}${d.slice(3)}`);
        }
      }
    };

    // Common BR variants: with and without country code 55.
    if (digits.startsWith('55') && digits.length > 11) {
      out.add(digits.slice(2));
    }
    if (!digits.startsWith('55') && digits.length >= 10) {
      out.add(`55${digits}`);
    }

    // Also normalize BR mobile representations with/without 9th digit.
    addBrNinthDigitVariants(digits);
    for (const candidate of [...out]) {
      addBrNinthDigitVariants(candidate);
    }

    return [...out];
  }

  _phonesEquivalent(a, b) {
    const aList = this._phoneCandidates(a);
    const bList = this._phoneCandidates(b);
    if (aList.length === 0 || bList.length === 0) {
      return false;
    }

    for (const av of aList) {
      for (const bv of bList) {
        if (av === bv) {
          return true;
        }

        // Fallback for providers that prepend/remove country/area prefixes.
        const minLen = Math.min(av.length, bv.length);
        if (minLen >= 10 && (av.endsWith(bv) || bv.endsWith(av))) {
          return true;
        }
      }
    }

    return false;
  }

  _setHasPhone(phoneSet, phone) {
    for (const candidate of phoneSet) {
      if (this._phonesEquivalent(candidate, phone)) {
        return true;
      }
    }
    return false;
  }

  _setHasAnyPhone(phoneSet, phones) {
    const list = Array.isArray(phones) ? phones : [];
    for (const p of list) {
      if (this._setHasPhone(phoneSet, p)) {
        return true;
      }
    }
    return false;
  }

  _setDeletePhone(phoneSet, phone) {
    let removed = false;
    for (const candidate of [...phoneSet]) {
      if (this._phonesEquivalent(candidate, phone)) {
        phoneSet.delete(candidate);
        removed = true;
      }
    }
    return removed;
  }

  _resolveConversationPhone(senderInfo = {}) {
    const rawPhone = this._normalizePhone(senderInfo.phone || '');
    const candidates = new Set();

    if (rawPhone) {
      for (const c of this._phoneCandidates(rawPhone)) {
        candidates.add(c);
      }
    }

    for (const item of Array.isArray(senderInfo.candidates) ? senderInfo.candidates : []) {
      const normalized = this._normalizePhone(item);
      if (!normalized) continue;
      for (const c of this._phoneCandidates(normalized)) {
        candidates.add(c);
      }
    }

    const candidateList = [...candidates];
    if (candidateList.length === 0) {
      return rawPhone || 'unknown';
    }

    const dialogs = (bot.dialog && typeof bot.dialog.getAllDialogs === 'function')
      ? bot.dialog.getAllDialogs()
      : null;

    if (!dialogs || typeof dialogs.keys !== 'function') {
      return rawPhone || candidateList[0] || 'unknown';
    }

    // Prefer exact canonical phone when it already exists in persisted dialogs.
    if (rawPhone && dialogs.has(rawPhone)) {
      return rawPhone;
    }

    for (const existingPhone of dialogs.keys()) {
      if (this._phonesEquivalent(existingPhone, rawPhone)) {
        return this._normalizePhone(existingPhone);
      }

      for (const candidate of candidateList) {
        if (this._phonesEquivalent(existingPhone, candidate)) {
          return this._normalizePhone(existingPhone);
        }
      }
    }

    return rawPhone || candidateList[0] || 'unknown';
  }

  _hasRecentActivityAcrossSenderAliases(senderInfo = {}, nowMs = Date.now()) {
    const candidates = new Set();

    const primary = this._normalizePhone(senderInfo.phone || '');
    if (primary) {
      for (const c of this._phoneCandidates(primary)) {
        candidates.add(c);
      }
    }

    for (const item of Array.isArray(senderInfo.candidates) ? senderInfo.candidates : []) {
      const normalized = this._normalizePhone(item || '');
      if (!normalized) continue;
      for (const c of this._phoneCandidates(normalized)) {
        candidates.add(c);
      }
    }

    if (candidates.size === 0) {
      return false;
    }

    const checkRecentFromState = (phoneKey) => {
      const state = this.replyTimingState.get(phoneKey) || {};
      const lastInboundAtMs = Number(state.lastInboundAtMs || 0);
      return Number.isFinite(lastInboundAtMs)
        && lastInboundAtMs > 0
        && (nowMs - lastInboundAtMs) <= this.options.conversationResetGapMs;
    };

    for (const [statePhone] of this.replyTimingState.entries()) {
      for (const candidate of candidates) {
        if (!this._phonesEquivalent(statePhone, candidate)) continue;
        if (checkRecentFromState(statePhone)) {
          return true;
        }
      }
    }

    if (!bot.dialog || typeof bot.dialog.getAllDialogs !== 'function') {
      return false;
    }

    const dialogs = bot.dialog.getAllDialogs();
    for (const [dialogPhone, dialogData] of dialogs.entries()) {
      let matches = false;
      for (const candidate of candidates) {
        if (this._phonesEquivalent(dialogPhone, candidate)) {
          matches = true;
          break;
        }
      }
      if (!matches) continue;

      const rawDate = dialogData?.lastUpdatedAt;
      const ts = rawDate instanceof Date ? rawDate.getTime() : Date.parse(String(rawDate || ''));
      if (Number.isFinite(ts) && (nowMs - ts) <= this.options.conversationResetGapMs) {
        return true;
      }
    }

    return false;
  }

  _isLikelyAutoReplyMessage(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(agradecemos sua mensagem|nao estamos disponiveis no momento|nao estamos disponivel no momento|entraremos em contato assim que possivel|retornaremos assim que possivel|mensagem automatica|resposta automatica|atendimento indisponivel|fora do horario de atendimento)/.test(normalized);
  }

  _isOwnerPhone(phone) {
    return !!this.ownerPhone && this._phonesEquivalent(phone, this.ownerPhone);
  }

  _isOwnerFromCandidates(candidates) {
    if (!this.ownerPhone) return false;
    const list = Array.isArray(candidates) ? candidates : [];
    return list.some((c) => this._phonesEquivalent(c, this.ownerPhone));
  }

  async _resolveSenderInfo(msg) {
    const rawFrom = String(msg?.from || '');
    const fromDigits = this._normalizePhone(rawFrom.split('@')[0] || '');

    let contact = null;
    try {
      contact = await msg.getContact();
    } catch (err) {
      contact = null;
    }

    const isLid = rawFrom.endsWith('@lid');

    const candidates = new Set();
    const addCandidates = (value) => {
      const normalized = this._normalizePhone(value || '');
      if (!normalized) return;
      for (const v of this._phoneCandidates(normalized)) {
        candidates.add(v);
      }
    };

    // For LID format, use contact.id.user as authority (comes from WhatsApp's canonical ID)
    if (isLid && contact?.id?.user) {
      addCandidates(contact.id.user);
    } else {
      addCandidates(fromDigits);
    }

    // Also try other sources as fallback
    addCandidates(contact?.number);
    addCandidates(contact?.phoneNumber);
    if (!isLid) {
      addCandidates(contact?.id?.user);
    }
    
    // Extract phone from _serialized if it's in format like "5534991670285@c.us"
    const serialized = String(contact?.id?._serialized || '');
    if (serialized.includes('@')) {
      addCandidates(serialized.split('@')[0]);
    }

    const phone = isLid && contact?.id?.user
      ? this._normalizePhone(contact.id.user)
      : this._normalizePhone(contact?.number || '') || fromDigits || 'unknown';
    const clientName = contact?.pushname || contact?.name || null;

    return {
      phone,
      rawFrom,
      candidates: [...candidates],
      contact,
      clientName,
    };
  }

  _isOwnerCommand(text) {
    const t = String(text || '').trim().toLowerCase();
    return t.startsWith('/assumir') || t.startsWith('/liberar') || t.startsWith('/status') || t.startsWith('/leads') || t.startsWith('/relatorio') || t.startsWith('/ajuda') || t.startsWith('/ativarbot') || t.startsWith('/desativarbot') || t.startsWith('/teste') || t.startsWith('/atender') || t.startsWith('/iniciar') || t.startsWith('/removerteste') || t.startsWith('/modo') || t.startsWith('/reset');
  }

  _resetLeadRuntimeState(phone) {
    const lead = this._normalizePhone(phone);
    if (!lead) return;

    this.replyTimingState.delete(lead);
    this.manualTakeovers.delete(lead);
  }

  _isLeadUnderManualTakeover(phone) {
    const takeover = this.manualTakeovers.get(phone);
    return !!(takeover && takeover.active);
  }

  _evaluateLeadEligibility(phone, candidates = []) {
    if (this.options.safeStartupAllowAll === true) {
      return {
        allowed: true,
        reason: 'safe_startup_allow_all',
        convertToManual: false,
        matchedTest: false,
        matchedLegacy: false,
      };
    }

    if (!this.options.safeStartupMode) {
      return {
        allowed: true,
        reason: 'safe_startup_off',
        convertToManual: false,
        matchedTest: false,
        matchedLegacy: false,
      };
    }

    const matchedTest = this._setHasPhone(this.testAllowedContacts, phone)
      || this._setHasAnyPhone(this.testAllowedContacts, candidates);
    if (matchedTest) {
      return {
        allowed: true,
        reason: 'test_allowed',
        convertToManual: false,
        matchedTest: true,
        matchedLegacy: false,
      };
    }

    const matchedLegacy = this._setHasPhone(this.legacyManualContacts, phone)
      || this._setHasAnyPhone(this.legacyManualContacts, candidates);
    if (matchedLegacy) {
      return {
        allowed: false,
        reason: 'legacy_manual_contact',
        convertToManual: false,
        matchedTest: false,
        matchedLegacy: true,
      };
    }

    if (!this.liveModeActive) {
      return {
        allowed: false,
        reason: 'safe_mode_inactive',
        convertToManual: true,
        matchedTest: false,
        matchedLegacy: false,
      };
    }

    return {
      allowed: true,
      reason: 'new_live_contact',
      convertToManual: false,
      matchedTest: false,
      matchedLegacy: false,
    };
  }

  async _captureLegacyContacts() {
    if (!this.options.safeStartupMode || !this.client) {
      return;
    }

    try {
      const chats = await this.client.getChats();
      for (const chat of chats) {
        const serialized = String(chat?.id?._serialized || '');
        if (!serialized.endsWith('@c.us')) continue;
        const digits = serialized.split('@')[0];
        if (digits && !this._isOwnerPhone(digits)) {
          this.legacyManualContacts.add(digits);
        }
      }
      console.log(`[WhatsApp] Contatos legados mapeados: ${this.legacyManualContacts.size}`);
    } catch (err) {
      console.error('[WhatsApp] Erro ao mapear contatos legados:', err.message);
    }
  }

  _isCriticalClosingGuardActive(phone, nowMs = Date.now()) {
    const state = this.replyTimingState.get(phone) || {};
    const until = Number(state.criticalClosingGuardUntilMs || 0);
    return until > nowMs;
  }

  _shouldActivateCriticalClosingGuard(response) {
    if (!this.options.criticalClosingGuardEnabled) {
      return false;
    }

    const signal = response?.closingSignal;
    return !!(signal && signal.notify_owner && signal.autonomy_boundary);
  }

  _activateCriticalClosingGuard(phone) {
    const state = this.replyTimingState.get(phone) || {};
    const untilMs = Date.now() + this.options.criticalClosingGuardMinutes * 60 * 1000;
    this.replyTimingState.set(phone, {
      ...state,
      criticalClosingGuardUntilMs: untilMs,
    });
  }

  _buildCriticalClosingGuardMessage() {
    const tone = this.options.criticalClosingGuardTone === 'soft' ? 'soft' : 'firm';

    const templatesByTone = {
      firm: [
        'Perfeito, estamos na reta final. Já estou alinhando os últimos detalhes para te passar certinho.',
        'Fechado, deixa comigo que já te trago os pontos finais da proposta para concluir com segurança.',
        'Ótimo, seu atendimento já está no fechamento. Em instantes te envio a confirmação final para avançar.',
        'Boa, estamos muito perto de concluir. Já estou validando o último ajuste e te retorno na sequência.',
      ],
      soft: [
        'Perfeito, vou organizar os detalhes finais com cuidado e já te envio tudo certinho.',
        'Ótimo, deixa eu só alinhar os últimos pontos para te passar a confirmação completa.',
        'Boa, estamos quase concluindo. Em instantes te retorno com tudo organizado.',
        'Fechado, já estou conferindo os detalhes finais para te dar um retorno redondo.',
      ],
    };

    const templates = templatesByTone[tone] || templatesByTone.firm;
    return templates[this._randomInt(0, templates.length - 1)];
  }

  _shouldEscalateNegotiationReview(response, userMessage = '') {
    const signal = response?.closingSignal || {};
    const stage = String(response?.stage || '').toLowerCase();
    const score = Number(response?.score || 0);
    const lower = this._normalizeMessageForCompare(userMessage);

    if (!lower) return false;

    const hasNegotiationAsk = /(desconto|condicao|condicoes|melhor preco|ultimo preco|fecha hoje|fechar hoje|se melhorar( o valor)?( eu)? fecho|melhorar( o valor)?|a vista|parcelado|parcelar|consegue melhorar|melhora esse valor|faz por quanto|manda proposta final|tem como melhorar)/.test(lower);
    const hasClosingMomentum = !!signal.is_advanced || !!signal.notify_owner || /(fech|compr|proposta final|agora)/.test(lower) || stage === 'negociacao' || stage === 'fechamento' || score >= 40;

    return hasNegotiationAsk && hasClosingMomentum;
  }

  _buildNegotiationReviewMessage() {
    return 'Perfeito, entendi seu ponto. Vou avaliar com mais cuidado a melhor condição para o seu caso e te retorno mais tarde com uma posição, tudo bem?';
  }

  async _notifyOwnerNegotiationReview(phone, clientName, response, userMessage) {
    if (!this.ownerPhone) {
      return;
    }

    const state = this.replyTimingState.get(phone) || {};
    const now = Date.now();
    const cooldown = this.options.negotiationReviewPingCooldownMs;
    const lastPing = Number(state.lastNegotiationReviewPingAtMs || 0);
    if (now - lastPing < cooldown) {
      return;
    }

    const ownerChat = `${this.ownerPhone}@c.us`;
    const signal = response?.closingSignal || {};
    const checkpoints = Array.isArray(signal.checkpoints) && signal.checkpoints.length > 0
      ? signal.checkpoints.join(', ')
      : 'sem checkpoints';

    await this._sendMessage(ownerChat, [
      `Negociação quente para revisão de condição: ${phone}${clientName ? ` (${clientName})` : ''}`,
      `Stage: ${response?.stage || 'unknown'} | Score: ${response?.score ?? 0}`,
      `Sinais: ${checkpoints}`,
      `Última msg lead: "${String(userMessage || '').slice(0, 160)}"`,
      `Bot respondeu que vai avaliar e retornar depois.`,
      `Para assumir: /assumir ${phone}`,
    ].join('\n'));

    this.replyTimingState.set(phone, {
      ...state,
      lastNegotiationReviewPingAtMs: now,
    });
  }

  _loadMediaCatalog() {
    try {
      const mediaPath = path.join(__dirname, '..', 'knowledge', 'media-links.json');
      if (!fs.existsSync(mediaPath)) {
        return this._buildDefaultMediaCatalog();
      }
      const parsed = JSON.parse(fs.readFileSync(mediaPath, 'utf8'));
      const withDefaults = this._buildDefaultMediaCatalog();
      return {
        ...withDefaults,
        ...parsed,
        local_media: {
          ...(withDefaults.local_media || {}),
          ...((parsed && parsed.local_media) || {}),
        },
      };
    } catch (err) {
      console.error('[WhatsApp] Falha ao carregar media-links.json:', err.message);
      return this._buildDefaultMediaCatalog();
    }
  }

  _loadSalesCatalog() {
    try {
      const canonicalPath = path.join(__dirname, '..', 'knowledge', 'canonical-base.json');
      if (fs.existsSync(canonicalPath)) {
        const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
        const products = Array.isArray(canonical?.catalogo_produtos)
          ? canonical.catalogo_produtos
            .map((p) => ({
              nome: String(p?.nome || '').trim(),
              preco: String(p?.preco || '').trim(),
            }))
            .filter((p) => p.nome && p.preco)
          : [];

        const fullSet = canonical?.pacotes_e_condicoes?.conjunto_completo || {};
        return {
          products,
          fullSet: {
            valorSomaAvulsa: String(fullSet?.soma_avulsa_referencia || '').trim(),
            valorInicialNegociacao: String(fullSet?.inicio_negociacao || '').trim(),
            valorNegociacao: String(fullSet?.piso_negociacao || '').trim(),
          },
        };
      }

      const catalogPath = path.join(__dirname, '..', 'knowledge', 'catalog.json');
      if (!fs.existsSync(catalogPath)) {
        return { products: [], fullSet: {} };
      }

      const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const products = Array.isArray(parsed?.produtos)
        ? parsed.produtos
          .map((p) => ({
            nome: String(p?.nome || '').trim(),
            preco: String(p?.preco || '').trim(),
          }))
          .filter((p) => p.nome && p.preco)
        : [];

      const packageList = Array.isArray(parsed?.estrategia_vendas?.pacotes_oficiais)
        ? parsed.estrategia_vendas.pacotes_oficiais
        : [];
      const fullSet = packageList.find((p) => /todos os brinquedos/i.test(String(p?.itens || ''))) || {};

      return {
        products,
        fullSet: {
          valorSomaAvulsa: String(fullSet?.valor_soma_avulsa || '').trim(),
          valorInicialNegociacao: String(fullSet?.valor_inicial_negociacao || '').trim(),
          valorNegociacao: String(fullSet?.valor_negociacao || '').trim(),
        },
      };
    } catch (err) {
      console.error('[WhatsApp] Falha ao carregar catálogo comercial:', err.message);
      return { products: [], fullSet: {} };
    }
  }

  _loadPricingPolicy() {
    const allowedTokens = new Set();
    const collectFromRaw = (raw) => {
      const matches = String(raw || '').match(/R\$\s*\d[\d\.,]*/gi) || [];
      for (const m of matches) {
        const token = this._normalizeCurrencyToken(m);
        if (token) {
          allowedTokens.add(token);
        }
      }
    };

    try {
      const canonicalPath = path.join(__dirname, '..', 'knowledge', 'canonical-base.json');
      if (fs.existsSync(canonicalPath)) {
        collectFromRaw(fs.readFileSync(canonicalPath, 'utf8'));
      }
    } catch (err) {
      console.error('[WhatsApp] Falha ao ler canonical-base.json para política de preços:', err.message);
    }

    try {
      const catalogPath = path.join(__dirname, '..', 'knowledge', 'catalog.json');
      if (fs.existsSync(catalogPath)) {
        collectFromRaw(fs.readFileSync(catalogPath, 'utf8'));
      }
    } catch (err) {
      console.error('[WhatsApp] Falha ao ler catalog.json para política de preços:', err.message);
    }

    try {
      const basePath = path.join(__dirname, '..', 'knowledge', 'base.json');
      if (fs.existsSync(basePath)) {
        collectFromRaw(fs.readFileSync(basePath, 'utf8'));
      }
    } catch (err) {
      console.error('[WhatsApp] Falha ao ler base.json para política de preços:', err.message);
    }

    return { allowedTokens };
  }

  _loadTestAllowedContacts() {
    const loaded = new Set();
    try {
      if (!fs.existsSync(this.testAllowedContactsPath)) {
        return loaded;
      }

      const raw = fs.readFileSync(this.testAllowedContactsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      for (const item of list) {
        const phone = this._normalizePhone(item);
        if (phone) {
          loaded.add(phone);
        }
      }

      if (loaded.size > 0) {
        console.log(`[WhatsApp] Números de teste carregados: ${loaded.size}`);
      }
    } catch (err) {
      console.error('[WhatsApp] Erro ao carregar números de teste:', err.message);
    }

    return loaded;
  }

  _saveTestAllowedContacts() {
    try {
      const sorted = [...this.testAllowedContacts].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      fs.writeFileSync(this.testAllowedContactsPath, JSON.stringify(sorted, null, 2));
    } catch (err) {
      console.error('[WhatsApp] Erro ao salvar números de teste:', err.message);
    }
  }

  _buildDefaultMediaCatalog() {
    const baseMediaDir = path.join(__dirname, '..', 'media');
    return {
      local_media: {
        videos_funcionamento_dir: path.join(baseMediaDir, 'videos_funcionamento'),
        area_baby_dir: path.join(baseMediaDir, 'area_baby'),
        brinquedao_dir: path.join(baseMediaDir, 'brinquedao'),
        cenografias_dir: path.join(baseMediaDir, 'cenografias'),
        espumados_dir: path.join(baseMediaDir, 'espumados'),
      },
    };
  }

  _buildMediaPlan(phone, response, userMessage, existingMessages = []) {
    if (!this.mediaCatalog) {
      return { messages: [], files: [] };
    }

    const lower = String(userMessage || '').toLowerCase();
    const stage = String(response?.stage || '').toLowerCase();
    const wantsMedia = /(foto|fotos|imagem|imagens|v[ií]deo|video|m[ií]dia|midia|mostrar|ver)/.test(lower);
    const asksSpecificallyForPhotos = /(foto|fotos|imagem|imagens)/.test(lower);
    const asksSpecificallyForVideos = /(v[ií]deo|video|funcionamento)/.test(lower);
    const asksGenericMedia = /(m[ií]dia|midia|mostrar|ver)/.test(lower);
    const shouldSendVideosByRequest = asksSpecificallyForPhotos || asksSpecificallyForVideos || asksGenericMedia;
    const stageAllowsVideo = ['apresentacao', 'validacao', 'negociacao'].includes(stage);

    const state = this.replyTimingState.get(phone) || {};
    const mediaState = {
      videosSent: !!state.mediaVideosSent,
      videoSuggestionSent: !!state.mediaVideoSuggestionSent,
      videoSuggestionCount: Number(state.mediaVideoSuggestionCount || 0),
      genericNoPhotoHintSent: !!state.mediaNoPhotoHintSent,
      photoSentByProduct: {
        area_baby: !!state.mediaPhotoAreaBabySent,
        brinquedao: !!state.mediaPhotoBrinquedaoSent,
        cenografias: !!state.mediaPhotoCenografiasSent,
        espumados: !!state.mediaPhotoEspumadosSent,
      },
    };

    const out = [];
    const filesToSend = [];
    let sentVideosNow = false;
    const localMedia = this.mediaCatalog?.local_media || {};
    const videos = this._listMediaFiles(localMedia.videos_funcionamento_dir, 'video');
    const existingList = Array.isArray(existingMessages) ? existingMessages : [];
    const hasVideoOfferInBaseMessages = existingList.some((m) => this._isVideoOfferOrQuestionMessage(m));

    if (hasVideoOfferInBaseMessages && !mediaState.videoSuggestionSent) {
      mediaState.videoSuggestionSent = true;
      mediaState.videoSuggestionCount += 1;
    }

    if (videos.length > 0 && !mediaState.videosSent && !mediaState.videoSuggestionSent && !hasVideoOfferInBaseMessages && !wantsMedia && stageAllowsVideo) {
      const suggestionOptions = [
        'Se fizer sentido pra você, eu posso te enviar os vídeos dos brinquedos em funcionamento para facilitar a visualização. Quer que eu te envie?',
        'Se ajudar na decisão, eu te mando os vídeos de funcionamento para você ver os brinquedos em uso real. Quer que eu te envie agora?',
        'Posso te enviar os vídeos dos brinquedos funcionando para você avaliar melhor cada opção. Prefere que eu te envie agora?',
      ];
      const suggestionIndex = mediaState.videoSuggestionCount % suggestionOptions.length;
      out.push(suggestionOptions[suggestionIndex]);
      mediaState.videoSuggestionSent = true;
      mediaState.videoSuggestionCount += 1;
    }

    // Evita envio de mídia sem solicitação explícita do cliente.
    if (videos.length > 0 && !mediaState.videosSent && shouldSendVideosByRequest && stageAllowsVideo) {
      out.push('Perfeito, vou te enviar agora os videos de funcionamento do espaco completo.');
      out.push('Nesses videos aparecem todos os brinquedos, no pacote base nem todos os itens estao inclusos.');
      out.push('Se você tiver interesse em levar o conjunto completo, eu monto uma proposta com todos os brinquedos e conseguimos negociar um desconto considerável.');
      filesToSend.push(...videos);
      mediaState.videosSent = true;
      sentVideosNow = true;
    }

    const requestedProduct = this._detectRequestedPhotoProduct(lower);
    if (requestedProduct) {
      const keyToDir = {
        area_baby: localMedia.area_baby_dir,
        brinquedao: localMedia.brinquedao_dir,
        cenografias: localMedia.cenografias_dir,
        espumados: localMedia.espumados_dir,
      };
      const photos = this._listMediaFiles(keyToDir[requestedProduct], 'image');
      if (photos.length > 0 && !mediaState.photoSentByProduct[requestedProduct]) {
        const labelMap = {
          area_baby: 'Area Baby',
          brinquedao: 'Brinquedao',
          cenografias: 'Cenografias',
          espumados: 'Espumados',
        };
        out.push(`Perfeito, vou te enviar agora as fotos de ${labelMap[requestedProduct]}.`);
        filesToSend.push(...photos);
        mediaState.photoSentByProduct[requestedProduct] = true;
      }
    }

    if (asksSpecificallyForPhotos && !requestedProduct && !mediaState.genericNoPhotoHintSent && !sentVideosNow) {
      out.push('Hoje o visual mais completo esta nos videos de funcionamento. Se quiser, eu te envio e te explico item por item.');
      mediaState.genericNoPhotoHintSent = true;
    }

    this.replyTimingState.set(phone, {
      ...state,
      mediaVideosSent: mediaState.videosSent,
      mediaVideoSuggestionSent: mediaState.videoSuggestionSent,
      mediaVideoSuggestionCount: mediaState.videoSuggestionCount,
      mediaNoPhotoHintSent: mediaState.genericNoPhotoHintSent,
      mediaPhotoAreaBabySent: mediaState.photoSentByProduct.area_baby,
      mediaPhotoBrinquedaoSent: mediaState.photoSentByProduct.brinquedao,
      mediaPhotoCenografiasSent: mediaState.photoSentByProduct.cenografias,
      mediaPhotoEspumadosSent: mediaState.photoSentByProduct.espumados,
    });

    return { messages: out, files: filesToSend };
  }

  _compressMediaNarration(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const seenMediaIntent = new Set();
    const filtered = [];

    for (const raw of list) {
      const text = String(raw || '').trim();
      if (!text) continue;

      const normalized = this._normalizeMessageForCompare(text);
      if (!normalized) continue;

      const isMediaNarration = /\b(video|videos|v[íi]deo|v[íi]deos|mostra|mostrar|te envio|vou te enviar|quero te mostrar|funcionando|ponto exato|visualizar)\b/.test(normalized);
      if (!isMediaNarration) {
        filtered.push(text);
        continue;
      }

      const mediaKey = normalized
        .replace(/\b(te envio|vou te enviar|quero te mostrar|vou mostrar|mostrar|mostra|videos?|v[íi]deos?)\b/g, 'media')
        .replace(/\s+/g, ' ')
        .trim();

      if (seenMediaIntent.has(mediaKey)) {
        continue;
      }

      seenMediaIntent.add(mediaKey);
      if (filtered.length === 0 || !this._normalizeMessageForCompare(filtered[filtered.length - 1]).includes('media')) {
        filtered.push(text);
      }
    }

    return filtered.length > 0 ? filtered : ['Vou te enviar os videos de funcionamento agora.'];
  }

  _isVideoOfferOrQuestionMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    const talksAboutVideo = /(video|videos|funcionamento|visualizacao)/.test(normalized);
    if (!talksAboutVideo) return false;

    return /(posso te enviar|posso te mandar|quer que eu te envie|prefere que eu te envie|te mando os videos|quer que eu te mande|quer que eu mande)/.test(normalized);
  }

  _isVideoReofferMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    if (this._isVideoOfferOrQuestionMessage(normalized)) {
      return true;
    }

    const hasVideoContext = /(video|videos|funcionamento|brinquedao funcionando)/.test(normalized);
    if (!hasVideoContext) {
      return false;
    }

    const hasOfferCue = /(tenho sim|vou te mostrar|vou mostrar|te mostro|vou te enviar|te envio|te mando|quer ver|antes de falar|assim voce ja visualiza)/.test(normalized);
    return hasOfferCue;
  }

  _removeMediaConfirmationPrompts(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const filtered = list.filter((m) => !this._isVideoOfferOrQuestionMessage(m));
    return filtered.length > 0 ? filtered : list;
  }

  _listMediaFiles(dirPath, type) {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return [];
    }

    const imageExt = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const videoExt = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
    const validExt = type === 'video' ? videoExt : imageExt;

    return fs.readdirSync(dirPath)
      .map((name) => ({ name, full: path.join(dirPath, name) }))
      .filter((f) => {
        if (!fs.existsSync(f.full)) return false;
        const stat = fs.statSync(f.full);
        if (!stat.isFile()) return false;
        return validExt.has(path.extname(f.name).toLowerCase());
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .map((f) => f.full);
  }

  _enforceConversationalFlow(messages, { stage = '', phone = '', isFirstInConversation = false, incomingText = '', nowMs = Date.now() } = {}) {
    const list = Array.isArray(messages)
      ? messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (list.length === 0) return list;

    if (this._isRentalRequestMessage(incomingText)) {
      return this._buildRentalClarificationMessages(phone);
    }

    const itemAvailability = this._extractKnownItemAvailabilityFromMessage(incomingText);
    if (itemAvailability.hasAny) {
      return this._buildKnownItemAvailabilityMessages(phone, itemAvailability);
    }

    if (this._isOutOfScopeRequestMessage(incomingText)) {
      return this._buildOutOfScopeClarificationMessages(phone);
    }

    const normalizedStage = String(stage || '').toLowerCase();
    const state = bot.dialog.getState(phone);
    const knownName = String(state?.name || '').trim();
    const waitingForNameAnswer = !knownName && this._isWaitingForNameAnswer(phone);
    const incomingLikelyName = waitingForNameAnswer
      ? this._extractLikelyName(incomingText)
      : '';
    const resolvedName = knownName || incomingLikelyName;
    const nameJustProvided = !!incomingLikelyName
      && !!resolvedName
      && this._normalizeMessageForCompare(resolvedName) === this._normalizeMessageForCompare(incomingLikelyName);

    if (nameJustProvided) {
      return [
        this._pickNameGreeting(phone, resolvedName),
        this._pickCommercialContinuation(phone),
      ];
    }

    // Só reinicia onboarding (saudação + nome) quando a conversa está realmente fria (>= 6h)
    // e ainda não há histórico útil do lead.
    const hasPersistedHistory = this._hasDialogHistory(phone);
    const shouldSendColdGreeting = this._shouldSendColdGreeting(phone, nowMs);
    if (isFirstInConversation && !knownName && shouldSendColdGreeting && !hasPersistedHistory) {
      return [
        this._timeGreetingForNow(),
        this._pickNameQuestion(phone),
      ];
    }

    const withoutNameQuestions = knownName
      ? list.filter((m) => !this._isNameQuestion(m))
      : list;

    const maxByStage = new Map([
      ['conexao', 2],
      ['diagnostico', 2],
      ['apresentacao', 3],
      ['validacao', 2],
      ['objecoes', 3],
      ['negociacao', 3],
      ['fechamento', 2],
    ]);
    const maxMessages = maxByStage.get(normalizedStage) || 3;

    if (withoutNameQuestions.length <= maxMessages) {
      return this._ensureFlowClosingPrompt(withoutNameQuestions, normalizedStage, phone, incomingText);
    }

    const kept = withoutNameQuestions.slice(0, Math.max(1, maxMessages - 1));
    return this._ensureFlowClosingPrompt(kept, normalizedStage, phone, incomingText);
  }

  _pickNameQuestion(phone) {
    return this._pickRotatingText(phone, 'nameQuestionIdx', [
      'Pode me dizer seu nome?',
      'Com quem eu estou falando?',
      'Como você prefere ser chamado?',
      'Me fala seu nome, por favor.',
    ]);
  }

  _hasDialogHistory(phone) {
    if (!bot.dialog || typeof bot.dialog.getHistory !== 'function') {
      return false;
    }

    const last = bot.dialog.getHistory(phone, 1);
    return Array.isArray(last) && last.length > 0;
  }

  _getLastDialogActivityAtMs(phone) {
    const state = this.replyTimingState.get(phone) || {};
    const lastInboundAtMs = Number(state.lastInboundAtMs || 0);
    if (Number.isFinite(lastInboundAtMs) && lastInboundAtMs > 0) {
      return lastInboundAtMs;
    }

    if (!bot.dialog || typeof bot.dialog.getHistory !== 'function') {
      return 0;
    }

    const history = bot.dialog.getHistory(phone, 1);
    const last = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
    const ts = Date.parse(String(last?.timestamp || ''));
    return Number.isFinite(ts) ? ts : 0;
  }

  _shouldSendColdGreeting(phone, nowMs = Date.now()) {
    const coldGapMs = 6 * 60 * 60 * 1000;
    const lastActivityAtMs = this._getLastDialogActivityAtMs(phone);
    if (!lastActivityAtMs) {
      return true;
    }

    return (nowMs - lastActivityAtMs) >= coldGapMs;
  }

  _pickNameGreeting(phone, name) {
    const safeName = String(name || '').trim() || 'tudo bem';
    const templates = [
      `Perfeito, ${safeName}. Como você está?`,
      `Prazer, ${safeName}. Tudo bem com você?`,
      `Ótimo, ${safeName}. Como vai?`,
      `Fechado, ${safeName}. Tudo certo por aí?`,
    ];
    return this._pickRotatingText(phone, 'nameGreetingIdx', templates);
  }

  _pickCommercialContinuation(phone) {
    return this._pickRotatingText(phone, 'commercialContinuationIdx', [
      'Você quer montar um espaço novo ou complementar um que já existe?',
      'Você está buscando brinquedos para um negócio que já funciona ou para começar um novo projeto?',
      'Para eu te ajudar melhor, hoje você quer montar do zero ou melhorar um espaço que já tem?',
      'Me diz de forma simples: você vai começar um espaço novo ou reforçar um que já existe?',
    ]);
  }

  _pickRotatingText(phone, counterKey, options) {
    const list = Array.isArray(options) ? options.filter(Boolean) : [];
    if (list.length === 0) return '';
    const current = this.replyTimingState.get(phone) || {};
    const index = Number(current[counterKey] || 0) % list.length;
    this.replyTimingState.set(phone, {
      ...current,
      [counterKey]: Number(current[counterKey] || 0) + 1,
    });
    return list[index];
  }

  _isNameQuestion(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;
    return /(pode me dizer seu nome|com quem eu estou falando|com quem estou falando|como voce prefere ser chamado|me fala seu nome|qual e o seu nome|qual eh o seu nome)/.test(normalized);
  }

  _isWaitingForNameAnswer(phone) {
    const state = this.replyTimingState.get(phone) || {};
    const pending = (state.pendingQuestionByIntent && typeof state.pendingQuestionByIntent === 'object')
      ? state.pendingQuestionByIntent
      : {};

    if (pending.ask_name) {
      return true;
    }

    const recent = Array.isArray(state.recentAskedIntents) ? state.recentAskedIntents : [];
    return recent.slice(-2).includes('ask_name');
  }

  _extractLikelyName(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 32) return '';
    if (/[?]/.test(raw)) return '';

    const normalized = raw
      .replace(/[0-9]/g, ' ')
      .replace(/[!?.,;:()\[\]{}"/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) return '';
    const normalizedLower = normalized.toLowerCase();
    if (/(isso|sim|nao|não|ok|tudo bem|novo projeto|espaco novo|espaço novo|voces enviam|vocês enviam)/.test(normalizedLower)) {
      return '';
    }

    const parts = normalized.split(' ').filter(Boolean);
    if (parts.length === 0 || parts.length > 3) return '';

    const blocked = new Set([
      'oi', 'ola', 'olá', 'bom', 'boa', 'dia', 'tarde', 'noite', 'ok',
      'valor', 'preco', 'preço', 'isso', 'sim', 'nao', 'não', 'novo', 'projeto',
      'espaco', 'espaço', 'voces', 'vocês', 'enviam', 'tudo', 'bem', 'entendido',
    ]);
    if (parts.some((p) => blocked.has(p.toLowerCase()))) return '';

    const valid = parts.every((p) => /^[A-Za-zÀ-ÿ']{2,}$/.test(p));
    if (!valid) return '';

    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }

  _ensureFlowClosingPrompt(messages, stage = '', phone = '', incomingText = '') {
    const list = Array.isArray(messages) ? messages.slice() : [];
    if (list.length === 0) return list;

    if (this._isDecisionHoldMessage(incomingText) && ['negociacao', 'fechamento', 'objecoes'].includes(String(stage || '').toLowerCase())) {
      return list;
    }

    const hasQuestion = list.some((m) => /\?/.test(String(m || '')));
    if (hasQuestion) {
      return list;
    }

    const promptByStage = {
      conexao: 'Perfeito, para eu te orientar melhor, você vai montar um espaço novo ou complementar um que já existe?',
      diagnostico: 'Para eu te direcionar certo, você está iniciando a operação kids ou já trabalha com isso, e sua necessidade é imediata ou ainda está avaliando?',
      apresentacao: 'Isso faz sentido para o seu cenário?',
      validacao: 'Ficou alguma dúvida?',
      objecoes: 'Qual ponto te trava mais hoje?',
      negociacao: 'Qual opção faz mais sentido para você agora?',
      fechamento: 'Posso seguir com o próximo passo?',
    };

    const prompt = promptByStage[String(stage || '').toLowerCase()] || 'Quer que eu siga por esse caminho com você?';

    const promptIntent = this._classifyQuestionIntent(prompt);
    if (promptIntent) {
      const recentIntents = this._getRecentQuestionIntents(phone);
      if (recentIntents.has(promptIntent) || this._shouldDeferQuestionIntent(phone, promptIntent)) {
        return list;
      }
    }

    return [...list, prompt];
  }

  _isDecisionHoldMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(vou pensar|vou ver|vou analisar|preciso pensar|deixar eu ver|conversar com meu socio|falar com meu socio|falar com o socio|tenho que ver com o socio|tenho que pensar|talvez depois|mais pra frente)/.test(normalized);
  }

  _buildDecisionHoldMessages() {
    return [
      'Perfeito, faz sentido pensar com calma.',
      'Só vale considerar que essa estrutura é limitada e a prioridade aqui é fechar com quem decide mais rápido.',
      'Eu vou te chamar mais pra frente na semana com o cenário atualizado e a melhor condição que eu conseguir segurar pra você.',
    ];
  }

  _applyDecisionHoldOverride(messages, stage = '', incomingText = '', phone = '') {
    if (!this._isDecisionHoldMessage(incomingText)) {
      return Array.isArray(messages) ? messages : [];
    }

    const normalizedStage = String(stage || '').toLowerCase();
    if (!['negociacao', 'fechamento', 'objecoes'].includes(normalizedStage)) {
      return Array.isArray(messages) ? messages : [];
    }

    return this._buildDecisionHoldMessages();
  }

  _timeGreetingForNow(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia!';
    if (hour >= 12 && hour < 18) return 'Boa tarde!';
    return 'Boa noite!';
  }

  _isRentalRequestMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(aluga|aluguel|alugam|locacao|locacao|locar|locam|alugar|para alugar|fazem aluguel)/.test(normalized);
  }

  _buildRentalClarificationMessages(phone) {
    const open = this._pickRotatingText(phone, 'rentalClarificationIdx', [
      'Hoje não trabalhamos com aluguel de brinquedos.',
      'No momento, não fazemos locação de brinquedos.',
      'Atualmente, não operamos com aluguel.',
    ]);

    const context = this._pickRotatingText(phone, 'rentalContextIdx', [
      'Nosso cenário é de desmobilização: estamos desmontando um buffet/playground e vendendo os brinquedos para desocupar o imóvel.',
      'Não somos uma empresa de locação ou venda recorrente; estamos desmontando um buffet/playground e vendendo a estrutura para desocupar o imóvel.',
      'Essa operação é de desmonte de um buffet/playground já existente, com venda dos brinquedos para liberar o imóvel.',
    ]);

    const continuation = this._pickRotatingText(phone, 'rentalContinuationIdx', [
      'Se fizer sentido para você, te explico as opções de compra que mais encaixam no seu cenário.',
      'Se você quiser, eu te mostro a melhor opção de compra para o seu caso.',
      'Se fizer sentido, eu te passo as opções de compra de forma objetiva e seguimos por aí.',
    ]);

    return [open, context, continuation];
  }

  _isOutOfScopeRequestMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    const outOfScopeSignals = /(manutencao|manutenção|assistencia tecnica|assistência técnica|instalacao|instalação|montagem completa|reforma|projeto sob medida|projeto personalizado|fabricacao|fabricação|fabrica|fábrica|franquia|parceria comercial|revenda|consignado|alugar para evento|locacao para evento|locação para evento|compram brinquedos usados|voc es compram brinquedos|compram estrutura)/.test(normalized);
    if (!outOfScopeSignals) return false;

    return true;
  }

  _buildOutOfScopeClarificationMessages(phone) {
    const open = this._pickRotatingText(phone, 'outScopeClarificationIdx', [
      'Hoje não trabalhamos com esse tipo de serviço ou operação.',
      'No momento, esse tipo de serviço fica fora do nosso escopo.',
      'Atualmente, não operamos com esse tipo de demanda.',
    ]);

    const context = this._pickRotatingText(phone, 'outScopeContextIdx', [
      'Nosso cenário é de desmobilização: estamos desmontando um buffet/playground e vendendo os brinquedos para desocupar o imóvel.',
      'Não somos uma empresa de serviços ou venda recorrente; estamos desmontando um buffet/playground e vendendo os itens disponíveis para desocupar o imóvel.',
      'Essa operação é focada na venda dos brinquedos disponíveis de um buffet/playground em desmonte, para liberar o imóvel.',
    ]);

    const continuation = this._pickRotatingText(phone, 'outScopeContinuationIdx', [
      'Se fizer sentido para você, eu te mostro os itens disponíveis hoje e os valores.',
      'Se você quiser, eu te apresento as opções disponíveis para compra agora.',
      'Se fizer sentido, eu te passo as opções de compra que temos hoje e seguimos por aí.',
    ]);

    return [open, context, continuation];
  }

  _extractKnownItemAvailabilityFromMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) {
      return { hasAny: false, found: [] };
    }

    const found = [];
    const addFound = (key, label, available, detail) => {
      if (found.some((f) => f.key === key)) return;
      found.push({ key, label, available, detail });
    };

    if (/(escorregador|escorregadores)/.test(normalized)) {
      addFound('escorregador', 'escorregador', true, 'temos no Brinquedão, integrado à estrutura');
    }

    if (/(pula pula|pulapula|cama elastica|cama elastica)/.test(normalized)) {
      addFound('pula_pula', 'pula-pula', true, 'temos na forma de cama elástica integrada ao Brinquedão, não como item avulso');
    }

    if (/(maquina de pipoca|maquina pipoca|pipoca)/.test(normalized)) {
      addFound('maquina_pipoca', 'máquina de pipoca', false, 'não temos disponível nesta venda');
    }

    if (/(balanco|balanco|balanco infantil|balanco infantis|balancos|balanços)/.test(normalized)) {
      addFound('balanco', 'balanço', false, 'não temos disponível nesta venda');
    }

    return {
      hasAny: found.length > 0,
      found,
    };
  }

  _buildKnownItemAvailabilityMessages(phone, availability) {
    const found = Array.isArray(availability?.found) ? availability.found : [];
    if (found.length === 0) return [];

    const parts = found.map((item) => `${item.label}: ${item.detail}`);
    const line1 = `Sobre os itens que você citou, ${parts.join('; ')}.`;

    const line2 = this._pickRotatingText(phone, 'knownAvailabilityContinuationIdx', [
      'Se fizer sentido, eu te mostro agora os itens que temos disponíveis hoje para compra.',
      'Se você quiser, eu te apresento as opções disponíveis hoje e os valores.',
      'Se fizer sentido para você, eu já te passo as opções disponíveis e seguimos por aí.',
    ]);

    return [line1, line2];
  }

  _detectRequestedPhotoProduct(lowerMessage) {
    if (/(brinqued[aã]o|pula[ -]?pula|cama el[aá]stica)/.test(lowerMessage)) return 'brinquedao';
    if (/(area baby|[áa]rea baby|\bbaby\b)/.test(lowerMessage)) return 'area_baby';
    if (/(espumad)/.test(lowerMessage)) return 'espumados';
    if (/(cenografia|cenogr[aá]fica|mercadinho|pet shop|cozinha)/.test(lowerMessage)) return 'cenografias';
    return null;
  }

  async _handleOwnerCommand(ownerChatFrom, text) {
    // Always reply in the same chat where the owner command came from.
    const ownerReplyTarget = ownerChatFrom || (this.ownerPhone ? `${this.ownerPhone}@c.us` : '');
    
    const [cmdRaw, argRaw] = String(text || '').trim().split(/\s+/, 2);
    const cmd = (cmdRaw || '').toLowerCase();
    const lead = this._normalizePhone(argRaw || '');

    if (cmd === '/ajuda') {
      await this._sendMessage(ownerReplyTarget, [
        'Comandos disponíveis:',
        '/assumir <telefone> para pausar o bot nesse lead',
        '/liberar <telefone> para devolver o lead ao bot',
        '/reset <telefone> para zerar histórico e estado desse lead',
        '/status <telefone> para ver estágio/score/assunção',
        '/leads para listar negociações mais quentes',
        '/relatorio para ver quantidade de contatos e status',
        '/teste <telefone> para liberar um numero de teste',
        '/atender <telefone> para liberar um numero real sem zerar a conversa',
        '/iniciar <telefone> para liberar um numero real e mandar a primeira mensagem',
        '/removerteste <telefone> para remover um numero de teste',
        '/ativarbot para atender contatos realmente novos',
        '/desativarbot para voltar ao modo seguro',
        '/modo para ver o status operacional',
      ].join('\n'));
      return;
    }

    if (cmd === '/modo') {
      const response = [
        `Modo do bot: ${this.liveModeActive ? 'ATIVO' : 'SEGURO'}`,
        `Contatos legados manuais: ${this.legacyManualContacts.size}`,
        `Numeros liberados para atendimento: ${this.testAllowedContacts.size}`,
      ].join('\n');
      await this._sendMessage(ownerReplyTarget, response);
      return;
    }

    if (cmd === '/ativarbot') {
      this.liveModeActive = true;
      this.legacyManualContacts.clear();
      await this._sendMessage(ownerReplyTarget, 'Bot ativado para atender contatos novos a partir de agora. Os contatos presos no modo seguro foram liberados para atendimento automático.');
      return;
    }

    if (cmd === '/desativarbot') {
      this.liveModeActive = false;
      await this._sendMessage(ownerReplyTarget, 'Bot voltou para modo seguro. Nenhum contato novo real sera atendido automaticamente.');
      return;
    }

    if (cmd === '/leads') {
      const hotLeads = this._listHotLeads();
      const textOut = hotLeads.length > 0
        ? hotLeads.join('\n')
        : 'Nenhum lead quente no momento.';
      await this._sendMessage(ownerReplyTarget, textOut);
      return;
    }

    if (cmd === '/relatorio') {
      await this._sendMessage(ownerReplyTarget, this._buildConversationReport());
      return;
    }

    if (!lead) {
      await this._sendMessage(ownerReplyTarget, 'Informe o telefone do lead. Exemplo: /assumir 5511999999999');
      return;
    }

    if (cmd === '/teste') {
      this.testAllowedContacts.add(lead);
      this._resetLeadRuntimeState(lead);
      if (bot.dialog && typeof bot.dialog.reset === 'function') {
        bot.dialog.reset(lead);
      }
      this._saveTestAllowedContacts();
      await this._sendMessage(ownerReplyTarget, `Numero liberado para teste e conversa zerada: ${lead}`);
      return;
    }

    if (cmd === '/atender') {
      this.testAllowedContacts.add(lead);
      this.manualTakeovers.delete(lead);
      this.legacyManualContacts.delete(lead);
      this._saveTestAllowedContacts();
      await this._sendMessage(ownerReplyTarget, `Numero liberado para atendimento real sem zerar a conversa: ${lead}`);
      return;
    }

    if (cmd === '/iniciar') {
      this.testAllowedContacts.add(lead);
      this.manualTakeovers.delete(lead);
      this.legacyManualContacts.delete(lead);
      this._saveTestAllowedContacts();

      const dialogState = bot.dialog.getState(lead);
      const safeName = String(dialogState?.name || '').trim();
      const openerMessages = [
        this._timeGreetingForNow(),
        safeName
          ? `Perfeito, ${safeName}. Vamos seguir por aqui.`
          : 'Perfeito, vamos seguir por aqui.',
        'Você quer montar um espaço novo ou complementar um que já existe?',
      ];

      for (let i = 0; i < openerMessages.length; i++) {
        await this._sendMessage(`${lead}@c.us`, openerMessages[i]);
        if (i < openerMessages.length - 1) {
          await this._wait(this._getBetweenMessagesDelayMs(openerMessages[i]));
        }
      }

      bot.dialog.addMessage(lead, 'bot', openerMessages.join('\n'), {
        type: 'manual_start',
      });

      this.replyTimingState.set(lead, {
        ...(this.replyTimingState.get(lead) || {}),
        hasReplied: true,
      });

      await this._sendMessage(ownerReplyTarget, `Numero liberado e atendimento iniciado para ${lead}.`);
      return;
    }

    if (cmd === '/removerteste') {
      const removed = this._setDeletePhone(this.testAllowedContacts, lead);
      if (removed) {
        this._saveTestAllowedContacts();
      }
      await this._sendMessage(ownerReplyTarget, removed
        ? `Numero removido da lista de teste: ${lead}`
        : `Numero não estava na lista de teste: ${lead}`);
      return;
    }

    if (cmd === '/assumir') {
      this.manualTakeovers.set(lead, {
        active: true,
        updatedAtMs: Date.now(),
      });
      await this._sendMessage(ownerReplyTarget, `Assunção manual ativada para ${lead}. O bot não responderá esse lead até /liberar ${lead}.`);
      return;
    }

    if (cmd === '/liberar') {
      this.manualTakeovers.delete(lead);
      await this._sendMessage(ownerReplyTarget, `Assunção manual removida para ${lead}. O bot voltou a atender esse lead.`);
      return;
    }

    if (cmd === '/reset') {
      this._resetLeadRuntimeState(lead);
      if (bot.dialog && typeof bot.dialog.reset === 'function') {
        bot.dialog.reset(lead);
      }
      await this._sendMessage(ownerReplyTarget, `Histórico e estado do lead ${lead} foram zerados. Pode reiniciar o teste.`);
      return;
    }

    if (cmd === '/status') {
      const state = bot.engine.getDialogState(lead);
      const takeover = this.manualTakeovers.get(lead);
      const takeoverText = takeover?.active ? 'ATIVA' : 'inativa';
      const origem = this._setHasPhone(this.testAllowedContacts, lead)
        ? 'teste'
        : (this._setHasPhone(this.legacyManualContacts, lead) ? 'legado_manual' : 'novo');
      await this._sendMessage(ownerReplyTarget, [
        `Lead: ${lead}`,
        `Stage: ${state?.stage || 'unknown'}`,
        `Score: ${state?.score ?? 0}`,
        `Assunção manual: ${takeoverText}`,
        `Origem operacional: ${origem}`,
      ].join('\n'));
      return;
    }

    await this._sendMessage(ownerReplyTarget, 'Comando não reconhecido. Use /ajuda.');
  }

  _listHotLeads() {
    const dialogsMap = bot.dialog.getAllDialogs();
    const rows = [];
    for (const [phone, d] of dialogsMap.entries()) {
      const score = Number(d?.score || 0);
      const stage = String(d?.stage || 'unknown');
      if (score < 30 && !['negociacao', 'fechamento'].includes(stage)) {
        continue;
      }
      const takeover = this._isLeadUnderManualTakeover(phone) ? 'manual' : 'bot';
      const origem = this._setHasPhone(this.testAllowedContacts, phone)
        ? 'teste'
        : (this._setHasPhone(this.legacyManualContacts, phone) ? 'legado' : 'novo');
      rows.push({ phone, stage, score, takeover, origem });
    }

    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, 12).map((r) => `${r.phone} | stage ${r.stage} | score ${r.score} | ${r.takeover} | ${r.origem}`);
  }

  async _maybeNotifyAdvancedNegotiation(phone, clientName, response, userMessage) {
    if (!this.ownerPhone) {
      return;
    }

    const signal = response?.closingSignal;
    if (!signal || !signal.is_advanced) {
      return;
    }

    if (this.options.notifyOnlyCriticalClosing && !signal.notify_owner) {
      return;
    }

    const state = this.replyTimingState.get(phone) || {};
    const level = signal.level || 'closing_now';
    const lastLevel = state.lastClosingAlertLevel;
    const lastAt = state.lastClosingAlertAtMs || 0;
    const now = Date.now();

    if (lastLevel === level && now - lastAt < 120 * 60 * 1000) {
      return;
    }

    const ownerChat = `${this.ownerPhone}@c.us`;
    const checkpoints = Array.isArray(signal.checkpoints) && signal.checkpoints.length > 0
      ? signal.checkpoints.join(', ')
      : 'sem checkpoints';

    const alertMsg = [
      `Alerta de fechamento (${level})`,
      `Lead: ${phone}${clientName ? ` (${clientName})` : ''}`,
      `Stage: ${response.stage} | Score: ${response.score}`,
      `Sinais: ${checkpoints}`,
      `Última msg lead: "${String(userMessage || '').slice(0, 120)}"`,
      `Para assumir: /assumir ${phone}`,
      `Para status: /status ${phone}`,
    ].join('\n');

    await this._sendMessage(ownerChat, alertMsg);

    this.replyTimingState.set(phone, {
      ...state,
      lastClosingAlertLevel: level,
      lastClosingAlertAtMs: now,
    });
  }

  async _notifyOwnerLeadMessageDuringTakeover(phone, clientName, messageText) {
    if (!this.ownerPhone || !this.options.takeoverOwnerPingsEnabled) {
      return;
    }

    const state = this.replyTimingState.get(phone) || {};
    const now = Date.now();
    const cooldown = this.options.takeoverLeadPingCooldownMs;
    const lastPing = state.lastTakeoverLeadPingAtMs || 0;

    if (now - lastPing < cooldown) {
      return;
    }

    const ownerChat = `${this.ownerPhone}@c.us`;
    await this._sendMessage(ownerChat, [
      `Lead em assunção manual respondeu: ${phone}${clientName ? ` (${clientName})` : ''}`,
      `Mensagem: "${String(messageText || '').slice(0, 140)}"`,
      `Para liberar o bot: /liberar ${phone}`,
    ].join('\n'));

    this.replyTimingState.set(phone, {
      ...state,
      lastTakeoverLeadPingAtMs: now,
    });
  }

  async _notifyOwnerCriticalGuardLeadMessage(phone, clientName, messageText) {
    if (!this.ownerPhone) {
      return;
    }

    const state = this.replyTimingState.get(phone) || {};
    const now = Date.now();
    const cooldown = this.options.criticalClosingGuardPingCooldownMs;
    const lastPing = state.lastCriticalGuardPingAtMs || 0;

    if (now - lastPing < cooldown) {
      return;
    }

    const ownerChat = `${this.ownerPhone}@c.us`;
    await this._sendMessage(ownerChat, [
      `Lead crítico aguardando fechamento: ${phone}${clientName ? ` (${clientName})` : ''}`,
      `Mensagem recente: "${String(messageText || '').slice(0, 140)}"`,
      `Assuma agora: /assumir ${phone}`,
    ].join('\n'));

    this.replyTimingState.set(phone, {
      ...state,
      lastCriticalGuardPingAtMs: now,
    });
  }

  _isCallRequestMessage(text) {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(ligacao|ligar|te ligo|pode me ligar|quer me ligar|chamada|telefonema|telefone|falar por ligacao|falar por telefone|liguem|me chama por ligacao)/.test(normalized);
  }

  _buildCallRequestMessage() {
    return 'Perfeito. Este WhatsApp é apenas web. Vou te chamar pelo WhatsApp pessoal para seguir por ligação.';
  }

  async _notifyOwnerCallRequest(phone, clientName, messageText) {
    if (!this.ownerPhone) {
      return;
    }

    const state = this.replyTimingState.get(phone) || {};
    const now = Date.now();
    const cooldown = this.options.callRequestPingCooldownMs;
    const lastPing = Number(state.lastCallRequestPingAtMs || 0);
    if (now - lastPing < cooldown) {
      return;
    }

    const ownerChat = `${this.ownerPhone}@c.us`;
    await this._sendMessage(ownerChat, [
      `Lead pediu ligação: ${phone}${clientName ? ` (${clientName})` : ''}`,
      `Mensagem: "${String(messageText || '').slice(0, 160)}"`,
      `Ação: chamar pelo WhatsApp pessoal.`,
      `Para assumir: /assumir ${phone}`,
    ].join('\n'));

    this.replyTimingState.set(phone, {
      ...state,
      lastCallRequestPingAtMs: now,
    });
  }

  _buildConversationReport() {
    const dialogsMap = bot.dialog.getAllDialogs();
    const stageCounts = new Map();
    const heatCounts = { closing_now: 0, very_hot: 0, hot: 0, warming: 0, cold: 0 };
    let total = 0;
    let manual = 0;

    for (const [phone, d] of dialogsMap.entries()) {
      total += 1;
      const stage = String(d?.stage || 'unknown');
      stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);

      if (this._isLeadUnderManualTakeover(phone)) {
        manual += 1;
      }

      const score = Number(d?.score || 0);
      if (stage === 'fechamento' || score >= 60) {
        heatCounts.closing_now += 1;
      } else if (stage === 'negociacao' || score >= 45) {
        heatCounts.very_hot += 1;
      } else if (score >= 30 || stage === 'objecoes') {
        heatCounts.hot += 1;
      } else if (score >= 15) {
        heatCounts.warming += 1;
      } else {
        heatCounts.cold += 1;
      }
    }

    const stageList = [...stageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([stage, count]) => `${stage}: ${count}`)
      .join(' | ');

    return [
      `Relatorio de conversas`,
      `Modo do bot: ${this.liveModeActive ? 'ATIVO' : 'SEGURO'}`,
      `Total de contatos: ${total}`,
      `Contatos legados manuais: ${this.legacyManualContacts.size}`,
      `Numeros de teste liberados: ${this.testAllowedContacts.size}`,
      `Em assuncao manual: ${manual}`,
      `Heatmap: closing_now ${heatCounts.closing_now}, very_hot ${heatCounts.very_hot}, hot ${heatCounts.hot}, warming ${heatCounts.warming}, cold ${heatCounts.cold}`,
      `Por estagio: ${stageList || 'sem dados'}`,
    ].join('\n');
  }

  async _enqueueIncomingMessage(msg) {
    const msgId = String(msg?.id?._serialized || '');
    if (msgId && this.processedInboundMessageIds.has(msgId)) {
      return;
    }
    if (msgId) {
      this.processedInboundMessageIds.add(msgId);
      if (this.processedInboundMessageIds.size > 5000) {
        const first = this.processedInboundMessageIds.values().next().value;
        if (first) {
          this.processedInboundMessageIds.delete(first);
        }
      }
    }

    const nowMs = Date.now();
    const dedupeKey = this._buildInboundDedupeKey(msg);
    if (dedupeKey) {
      const lastSeenMs = Number(this.processedInboundMessageKeys.get(dedupeKey) || 0);
      if (lastSeenMs > 0 && (nowMs - lastSeenMs) < this.options.inboundDedupeWindowMs) {
        return;
      }
      this.processedInboundMessageKeys.set(dedupeKey, nowMs);
      this._cleanupInboundDedupeKeys(nowMs);
    }

    return this._enqueuePhoneTask(msg.from, () => this._handleIncomingMessage(msg));
  }

  _buildInboundDedupeKey(msg) {
    const id = String(msg?.id?._serialized || '').trim();
    if (id) return `id:${id}`;

    const ts = Number(msg?.timestamp || 0);
    const body = String(msg?.body || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!body) return '';
    return `fb:${ts}:${body}`;
  }

  _cleanupInboundDedupeKeys(nowMs = Date.now()) {
    const ttl = this.options.inboundDedupeWindowMs;
    for (const [key, seenMs] of this.processedInboundMessageKeys.entries()) {
      if (!Number.isFinite(seenMs) || (nowMs - seenMs) > ttl) {
        this.processedInboundMessageKeys.delete(key);
      }
    }
  }

  async _enqueuePhoneTask(phoneKey, taskFn) {
    const previous = this.messageQueues.get(phoneKey) || Promise.resolve();

    const current = previous
      .then(() => taskFn())
      .finally(() => {
        if (this.messageQueues.get(phoneKey) === current) {
          this.messageQueues.delete(phoneKey);
        }
      });

    this.messageQueues.set(phoneKey, current);
    return current;
  }

  _getResponseDelayMs(isFirstInConversation) {
    if (isFirstInConversation) {
      const jitter = this._randomInt(-this.options.firstReplyJitterMs, this.options.firstReplyJitterMs);
      const delay = this.options.firstReplyDelayMs + jitter;
      return Math.max(1000, delay);
    }

    return this._randomInt(this.options.conversationDelayMinMs, this.options.conversationDelayMaxMs);
  }

  _randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _getBetweenMessagesDelayMs(text) {
    const baseDelay = this._randomInt(
      this.options.betweenMessagesMinMs,
      this.options.betweenMessagesMaxMs
    );

    // Mensagens maiores tendem a gerar uma pausa um pouco maior.
    const lengthFactorMs = Math.min(3000, Math.max(0, (text || '').length * 25));
    return baseDelay + lengthFactorMs;
  }

  _estimateTypingDelayMs(text) {
    const content = String(text || '').trim();
    const charCount = content.length;
    const byLength = charCount * this.options.typingMsPerChar;
    const punctuationCount = (content.match(/[.,!?;:]/g) || []).length;
    const punctuationPauseMs = punctuationCount * this.options.typingPunctuationMs;
    const base = byLength + punctuationPauseMs;
    const jitter = this._randomInt(-this.options.typingJitterMs, this.options.typingJitterMs);
    const withJitter = base + jitter;

    return Math.max(this.options.typingMinMs, Math.min(this.options.typingMaxMs, withJitter));
  }

  _isFirstReplyInConversation(phone, nowMs) {
    const state = this.replyTimingState.get(phone);

    if (!state || !state.hasReplied) {
      const persistedHistory = (bot.dialog && typeof bot.dialog.getHistory === 'function')
        ? bot.dialog.getHistory(phone, 1)
        : [];
      return persistedHistory.length === 0;
    }

    const lastInboundAtMs = Number(state.lastInboundAtMs || 0);
    if (!Number.isFinite(lastInboundAtMs) || lastInboundAtMs <= 0) {
      const persistedHistory = (bot.dialog && typeof bot.dialog.getHistory === 'function')
        ? bot.dialog.getHistory(phone, 1)
        : [];
      return persistedHistory.length === 0;
    }

    return nowMs - lastInboundAtMs > this.options.conversationResetGapMs;
  }

  _setLastInboundAt(phone, nowMs) {
    const state = this.replyTimingState.get(phone) || {};
    this.replyTimingState.set(phone, {
      ...state,
      lastInboundAtMs: nowMs,
    });
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _startProactiveFollowupScheduler() {
    if (!this.options.proactiveFollowupEnabled || this.proactiveTimer) {
      return;
    }

    this.proactiveTimer = setInterval(() => {
      this._processProactiveFollowups().catch((err) => {
        console.error('[WhatsApp] Erro no agendador de retomada:', err.message);
      });
    }, this.options.proactiveFollowupCheckMs);

    console.log('[WhatsApp] Agendador de retomada ativa inicializado');
  }

  _startInboundPoller() {
    if (!this.options.inboxPollEnabled || this.inboxPollTimer) {
      return;
    }

    // Evita reprocessar mensagens antigas do inbox ao reiniciar o processo.
    this.inboundPollBootAtMs = Date.now();

    this.inboxPollTimer = setInterval(() => {
      const nowMs = Date.now();
      if (this.inboxPollPausedUntilMs > nowMs) {
        return;
      }

      if (this.inboxPollInFlight) {
        return;
      }

      this.inboxPollInFlight = true;
      this._pollInboundMessages().catch((err) => {
        if (this._isDetachedFrameError(err)) {
          this.inboxPollDetachedFrameErrors += 1;
          const backoffFactor = Math.min(this.inboxPollDetachedFrameErrors, 5);
          const cooldownMs = this.options.inboxPollDetachedFrameCooldownMs * backoffFactor;
          this.inboxPollPausedUntilMs = Date.now() + cooldownMs;
          console.error(`[WhatsApp] Poller pausado por frame destacado (${Math.round(cooldownMs / 1000)}s).`);
          return;
        }

        console.error('[WhatsApp] Erro no poller de inbox:', err.message);
      }).finally(() => {
        this.inboxPollInFlight = false;
      });
    }, this.options.inboxPollIntervalMs);

    console.log('[WhatsApp] Poller de inbox inicializado');
  }

  async _pollInboundMessages() {
    if (!this.ready || !this.client || !this.options.inboxPollEnabled) {
      return;
    }

    const chats = await this.client.getChats();
    this.inboxPollDetachedFrameErrors = 0;
    const nowMs = Date.now();

    for (const chat of chats) {
      const serialized = String(chat?.id?._serialized || '');
      if (!serialized.endsWith('@c.us') && !serialized.endsWith('@lid')) {
        continue;
      }

      const lastTsSec = Number(chat?.lastMessage?.timestamp || chat?.timestamp || 0);
      const lastTsMs = Number.isFinite(lastTsSec) ? lastTsSec * 1000 : NaN;
      const isRecentChat = Number.isFinite(lastTsMs)
        && (nowMs - lastTsMs <= this.options.inboxPollRecentWindowMs);
      if (!isRecentChat) {
        continue;
      }

      const limit = 12;
      const messages = await chat.fetchMessages({ limit });

      for (const msg of messages) {
        if (!msg || msg.fromMe) {
          continue;
        }

        const tsMs = Number(msg.timestamp || 0) * 1000;
        if (Number.isFinite(tsMs) && tsMs < (this.inboundPollBootAtMs - this.options.inboundPollBootSkewMs)) {
          continue;
        }

        if (Number.isFinite(tsMs) && nowMs - tsMs > this.options.inboxPollRecentWindowMs) {
          continue;
        }

        await this._enqueueIncomingMessage(msg);
      }
    }
  }

  _pauseInboundPoller(reason = '') {
    const cooldownMs = this.options.inboxPollDetachedFrameCooldownMs;
    this.inboxPollPausedUntilMs = Date.now() + cooldownMs;
    if (reason) {
      console.log(`[WhatsApp] Poller de inbox em pausa (${reason}) por ${Math.round(cooldownMs / 1000)}s.`);
    }
  }

  _isDetachedFrameError(err) {
    const message = String(err?.message || '').toLowerCase();
    if (!message) return false;
    return message.includes('detached frame')
      || message.includes('attempted to use detached frame')
      || message.includes('execution context was destroyed');
  }

  async _processProactiveFollowups() {
    if (!this.ready || !this.options.proactiveFollowupEnabled) {
      return;
    }

    const dialogsMap = bot.dialog.getAllDialogs();
    const nowMs = Date.now();

    for (const [phone, dialogData] of dialogsMap.entries()) {
      if (this._isLeadUnderManualTakeover(phone)) {
        continue;
      }

      if (this._isLeadOptedOut(phone)) {
        continue;
      }

      const followupPlan = this._getProactiveFollowupPlan(phone, dialogData, nowMs);
      if (!followupPlan.shouldSend) {
        continue;
      }

      const fullPhone = `${phone}@c.us`;
      await this._enqueuePhoneTask(fullPhone, async () => {
        await this._sendProactiveFollowup(phone, dialogData, followupPlan);
      });
    }
  }

  _getProactiveFollowupPlan(phone, dialogData, nowMs) {
    if (!dialogData || !Array.isArray(dialogData.history) || dialogData.history.length === 0) {
      return { shouldSend: false, status: 'default_pause', inactivityMs: this.options.proactiveInactivityMs };
    }

    if (this.options.proactiveSkipStages.includes(dialogData.stage)) {
      return { shouldSend: false, status: 'default_pause', inactivityMs: this.options.proactiveInactivityMs };
    }

    const status = this._classifyFollowupStatus(dialogData);
    if (status === 'stop_engagement') {
      return { shouldSend: false, status, inactivityMs: this.options.proactiveInactivityMs };
    }
    const inactivityMs = this._getInactivityForFollowupStatus(status);
    const anchorMs = this._getFollowupAnchorMs(dialogData, status);
    if (!Number.isFinite(anchorMs)) {
      return { shouldSend: false, status: 'default_pause', inactivityMs: this.options.proactiveInactivityMs };
    }

    const pauseKey = this._buildProactivePauseKey(status, anchorMs);
    const dueAtMs = this._getOrCreateProactiveDueAt(phone, status, anchorMs);

    if (nowMs < dueAtMs) {
      return { shouldSend: false, status, inactivityMs, dueAtMs, pauseKey };
    }

    if (!this._isWithinProactiveWindow(nowMs)) {
      return { shouldSend: false, status, inactivityMs, dueAtMs, pauseKey };
    }

    const timingState = this.replyTimingState.get(phone) || {};
    if (timingState.lastProactivePauseKey === pauseKey) {
      const sent = timingState.lastProactiveAttempts || 0;
      if (sent >= this.options.proactiveMaxAttemptsPerPause) {
        return { shouldSend: false, status, inactivityMs, dueAtMs, pauseKey };
      }
    }

    return { shouldSend: true, status, inactivityMs, dueAtMs, pauseKey };
  }

  _classifyFollowupStatus(dialogData) {
    const history = Array.isArray(dialogData.history) ? dialogData.history : [];
    const lastUser = [...history].reverse().find((h) => h && h.from === 'user');
    const lastBot = [...history].reverse().find((h) => h && h.from === 'bot');
    const userText = (lastUser?.text || '').toLowerCase();
    const botText = (lastBot?.text || '').toLowerCase();
    const stage = (dialogData.stage || '').toLowerCase();

    if (/(nao quero|não quero|sem interesse|nao tenho interesse|não tenho interesse|nao vou comprar|não vou comprar|obrigado|obg|valeu|encerra|encerrar|pode parar|nao precisa|não precisa)/.test(userText)) {
      return 'stop_engagement';
    }

    if (/(vou pensar|vou ver|falar com (a )?(esposa|marido|s[oó]cio|s[oó]cia)|te retorno|retorno|depois eu|depois te|amanh[aã]|vou analisar|vou avaliar)/.test(userText)) {
      return 'decision_pending';
    }

    if (/(r\$\s?\d|pre[cç]o|valor|proposta|condi[cç][aã]o|foto|fotos|v[ií]deo|video|cat[aá]logo|catalogo)/.test(botText)) {
      return 'post_info_silence';
    }

    if (stage === 'negociacao' || stage === 'objecoes') {
      return 'negotiation_pause';
    }

    if (stage === 'diagnostico' || stage === 'apresentacao' || stage === 'validacao') {
      return 'mid_funnel_pause';
    }

    return 'default_pause';
  }

  _getInactivityForFollowupStatus(status) {
    const byStatus = this.options.proactiveInactivityByStatusMs || {};
    return byStatus[status] || byStatus.default_pause || this.options.proactiveInactivityMs;
  }

  _getFollowupAnchorMs(dialogData, status) {
    const history = Array.isArray(dialogData.history) ? dialogData.history : [];

    // Proactive cadence must be anchored by the last human turn,
    // otherwise bot self-messages keep resetting the anchor and can loop.
    const lastUser = [...history].reverse().find((h) => h && h.from === 'user');
    const userMs = lastUser ? new Date(lastUser.timestamp).getTime() : NaN;
    return Number.isFinite(userMs) ? userMs : NaN;
  }

  _buildProactivePauseKey(status, anchorMs) {
    return `${status}:${anchorMs}`;
  }

  _getOrCreateProactiveDueAt(phone, status, anchorMs) {
    const state = this.replyTimingState.get(phone) || {};
    const pauseKey = this._buildProactivePauseKey(status, anchorMs);

    if (state.proactiveDuePauseKey === pauseKey && Number.isFinite(state.proactiveDueAtMs)) {
      return state.proactiveDueAtMs;
    }

    const inactivityMs = this._getInactivityForFollowupStatus(status);
    const jitterMs = this._getProactiveJitterMs(status);
    let dueAtMs = anchorMs + inactivityMs + jitterMs;
    dueAtMs = this._adjustDueAtToBusinessWindow(dueAtMs);

    this.replyTimingState.set(phone, {
      ...state,
      proactiveDuePauseKey: pauseKey,
      proactiveDueAtMs: dueAtMs,
    });

    return dueAtMs;
  }

  _getProactiveJitterMs(status) {
    const byStatus = this.options.proactiveJitterByStatusMs || {};
    const range = byStatus[status] || byStatus.default_pause || { min: 5 * 60 * 1000, max: 20 * 60 * 1000 };
    const min = Number(range.min) || 0;
    const max = Number(range.max) || min;
    return this._randomInt(Math.min(min, max), Math.max(min, max));
  }

  _isWithinProactiveWindow(nowMs) {
    const d = new Date(nowMs);
    const hour = d.getHours();
    const start = this.options.proactiveAllowedStartHour;
    const end = this.options.proactiveAllowedEndHour;

    if (start === end) return true;
    if (start < end) {
      return hour >= start && hour < end;
    }

    // Janela que cruza meia-noite (ex.: 20 -> 8)
    return hour >= start || hour < end;
  }

  _adjustDueAtToBusinessWindow(dueAtMs) {
    if (this._isWithinProactiveWindow(dueAtMs)) {
      return dueAtMs;
    }

    const nextWindowStartMs = this._getNextProactiveWindowStartMs(dueAtMs);
    const openJitter = this._randomInt(
      this.options.proactiveWindowOpenJitterMinMs,
      this.options.proactiveWindowOpenJitterMaxMs
    );
    return nextWindowStartMs + openJitter;
  }

  _getNextProactiveWindowStartMs(baseMs) {
    const base = new Date(baseMs);
    const start = this.options.proactiveAllowedStartHour;
    const end = this.options.proactiveAllowedEndHour;

    if (start === end) {
      return baseMs;
    }

    const candidate = new Date(baseMs);
    candidate.setMinutes(0, 0, 0);

    if (start < end) {
      if (base.getHours() < start) {
        candidate.setHours(start, 0, 0, 0);
        return candidate.getTime();
      }

      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(start, 0, 0, 0);
      return candidate.getTime();
    }

    // Janela cruzando meia-noite: se estiver fora da janela, próximo início é hoje no start.
    if (base.getHours() >= end && base.getHours() < start) {
      candidate.setHours(start, 0, 0, 0);
      return candidate.getTime();
    }

    return baseMs;
  }

  async _sendProactiveFollowup(phone, dialogData, followupPlan = null) {
    try {
      if (this._isLeadOptedOut(phone)) {
        return;
      }

      const history = bot.engine.getDialogHistory(phone, 12);
      const status = followupPlan?.status || this._classifyFollowupStatus(dialogData);
      const generated = await bot.engine.generateProactiveFollowup({
        phone,
        name: dialogData.name || null,
        history,
        stage: dialogData.stage,
        summary: dialogData.summary || null,
        followupStatus: status,
      });

      const messages = Array.isArray(generated.messages)
        ? generated.messages.filter((m) => m && m.trim())
        : [];

      if (messages.length === 0) {
        return;
      }

      const fullPhone = `${phone}@c.us`;

      // Em retomada, sempre usa janela de conversa (5-20s), não janela de primeira resposta.
      const initialPauseMs = this._randomInt(
        this.options.conversationDelayMinMs,
        this.options.conversationDelayMaxMs
      );
      await this._wait(initialPauseMs);

      for (let i = 0; i < messages.length; i++) {
        await this._sendMessage(fullPhone, messages[i]);
        if (i < messages.length - 1) {
          await this._wait(this._getBetweenMessagesDelayMs(messages[i]));
        }
      }

      bot.dialog.addMessage(phone, 'bot', messages.join('\n'), {
        type: 'proactive_followup',
        followup_status: status,
      });

      const state = this.replyTimingState.get(phone) || {};
      const pauseKey = followupPlan?.pauseKey || state.proactiveDuePauseKey;
      const samePause = state.lastProactivePauseKey === pauseKey;

      this.replyTimingState.set(phone, {
        ...state,
        hasReplied: true,
        lastProactivePauseKey: pauseKey,
        lastProactiveAttempts: samePause ? (state.lastProactiveAttempts || 0) + 1 : 1,
      });

      console.log(`[WhatsApp] Retomada ativa enviada para ${phone} | status: ${status}`);
    } catch (err) {
      console.error(`[WhatsApp] Erro ao enviar retomada ativa para ${phone}:`, err.message);
    }
  }

  async _sendMessage(phone, text) {
    try {
      const typingMs = this._estimateTypingDelayMs(text);

      try {
        const chat = await this.client.getChatById(phone);
        if (chat && typeof chat.sendStateTyping === 'function') {
          await chat.sendStateTyping();
          await this._wait(typingMs);
          if (typeof chat.clearState === 'function') {
            await chat.clearState();
          }
        } else {
          await this._wait(typingMs);
        }
      } catch (typingErr) {
        await this._wait(typingMs);
      }

      await this.client.sendMessage(phone, text);
    } catch (err) {
      console.error(`[WhatsApp] Erro ao enviar mensagem para ${phone}:`, err.message);
    }
  }

  async _sendMediaFile(phone, filePath) {
    try {
      const media = MessageMedia.fromFilePath(filePath);
      await this.client.sendMessage(phone, media);
    } catch (err) {
      console.error(`[WhatsApp] Erro ao enviar midia para ${phone} (${filePath}):`, err.message);
    }
  }

  _isExplicitNoBuyMessage(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(nao quero comprar|não quero comprar|nao tenho interesse|não tenho interesse|sem interesse|nao vou comprar|não vou comprar|nao quero|não quero|nao preciso|não preciso|nao tenho interesse agora|não tenho interesse agora|obrigado mas nao|obrigado mas não)/.test(normalized);
  }

  _isResumeIntentMessage(text = '') {
    const normalized = this._normalizeMessageForCompare(text);
    if (!normalized) return false;

    return /(tenho interesse|quero comprar|voltei|podemos continuar|vamos continuar|me passa informacoes|me passa informações|quero saber mais|me manda detalhes|quero fechar|vamos fechar)/.test(normalized);
  }

  _markLeadOptOut(phone, reason = '') {
    const state = this.replyTimingState.get(phone) || {};
    this.replyTimingState.set(phone, {
      ...state,
      optedOut: true,
      optedOutAtMs: Date.now(),
      optedOutReason: String(reason || '').slice(0, 180),
    });

    if (bot.dialog && typeof bot.dialog.updateCommercialContext === 'function') {
      bot.dialog.updateCommercialContext(phone, {
        facts: {
          leadIntent: 'not_interested',
        },
        signals: ['lead_opt_out_explicit'],
      });
    }
  }

  _clearLeadOptOut(phone) {
    const state = this.replyTimingState.get(phone) || {};
    this.replyTimingState.set(phone, {
      ...state,
      optedOut: false,
      optedOutAtMs: 0,
      optedOutReason: '',
    });

    if (bot.dialog && typeof bot.dialog.updateCommercialContext === 'function') {
      bot.dialog.updateCommercialContext(phone, {
        facts: {
          leadIntent: 'active',
        },
        signals: ['lead_reengaged_after_opt_out'],
      });
    }
  }

  _isLeadOptedOut(phone) {
    const state = this.replyTimingState.get(phone) || {};
    if (state.optedOut === true) {
      return true;
    }

    if (bot.dialog && typeof bot.dialog.getCommercialContext === 'function') {
      const ctx = bot.dialog.getCommercialContext(phone) || {};
      const intent = String(ctx?.facts?.leadIntent || '').toLowerCase();
      if (intent === 'not_interested') {
        return true;
      }
    }

    return false;
  }

  async sendMessage(phone, text) {
    if (!this.ready) {
      console.error('[WhatsApp] Bot não está pronto');
      return false;
    }
    const fullPhone = phone.includes('@') ? phone : `${phone}@c.us`;
    return await this._sendMessage(fullPhone, text);
  }

  getQRData() {
    return this.qrData;
  }

  getStatus() {
    return {
      ready: this.ready,
      qrGenerated: !!this.qrData,
    };
  }

  async logout() {
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }

    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
    }

    if (this.client) {
      await this.client.logout();
      console.log('[WhatsApp] Logout realizado');
    }
  }
}

module.exports = WhatsAppClient;
