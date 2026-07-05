'use strict';

const fs = require('fs');
const path = require('path');
const templates = require('./prompt_templates');
const dialog = require('./dialog_manager');

const RETRIEVAL_CACHE_TTL_MS = 20 * 60 * 1000;
const RETRIEVAL_CACHE_MAX_KEYS = 6;
const RETRIEVAL_TELEMETRY_MAX = 300;
const retrievalCriticalCache = new Map();
const retrievalTelemetry = [];

// Simples KB loader e retriever por correspondência de palavras-chave
function loadKB() {
  const canonicalPath = path.join(__dirname, '..', 'knowledge', 'canonical-base.json');
  if (fs.existsSync(canonicalPath)) {
    try {
      const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
      const snippets = [];

      const products = Array.isArray(canonical?.catalogo_produtos)
        ? canonical.catalogo_produtos
        : [];

      for (const p of products) {
        const title = String(p?.nome || p?.id || '').trim();
        const price = String(p?.preco || '').trim();
        if (!title) continue;
        snippets.push({
          title,
          text: [
            p?.descricao ? String(p.descricao) : '',
            p?.dimensoes_completo ? `Dimensões completas: ${String(p.dimensoes_completo)}` : '',
            p?.dimensoes_sem_cama ? `Dimensões sem cama: ${String(p.dimensoes_sem_cama)}` : '',
            p?.regra ? `Regra: ${String(p.regra)}` : '',
            price ? `Preço: ${price}` : '',
          ].filter(Boolean).join('\n'),
        });
      }

      const sectionSnippets = [
        ['Objetivo Comercial', canonical?.objetivo_comercial],
        ['Contexto Negocio', canonical?.contexto_negocio],
        ['Regras Comunicacao', canonical?.regras_comunicacao],
        ['Diagnostico Comercial', canonical?.diagnostico_comercial],
        ['Pacotes e Condicoes', canonical?.pacotes_e_condicoes],
        ['Argumentacao Mercado', canonical?.argumentacao_mercado],
        ['Logistica', canonical?.logistica],
        ['Objecoes Playbook', canonical?.objecoes_playbook],
      ];

      for (const [title, value] of sectionSnippets) {
        if (!value) continue;
        const text = typeof value === 'string'
          ? value
          : JSON.stringify(value, null, 2);
        snippets.push({ title, text });
      }

      if (snippets.length > 0) {
        return snippets;
      }
    } catch (err) {
      console.error('[Engine] Falha ao carregar canonical-base.json:', err.message);
    }
  }

  const basePath = path.join(__dirname, '..', 'knowledge', 'base.json');
  const catalogPath = path.join(__dirname, '..', 'knowledge', 'catalog.json');
  const baseRaw = fs.readFileSync(basePath, 'utf8');
  const base = JSON.parse(baseRaw);
  let catalog = null;
  if (fs.existsSync(catalogPath)) {
    const catalogRaw = fs.readFileSync(catalogPath, 'utf8');
    catalog = JSON.parse(catalogRaw);
  }

  // Flatten entries into searchable snippets
  const snippets = [];
  const seenProducts = new Set();

  function pushProduct(p) {
    const key = (p.nome || p.id || '').toLowerCase();
    if (!key || seenProducts.has(key)) return;
    seenProducts.add(key);
    const conditions = Array.isArray(p.opcoes_pagamento)
      ? p.opcoes_pagamento.join(' | ')
      : (p.condicoes || p.condicao_preco || 'Consultar');
    const dimensionsParts = [];
    const completeDimensions = p.dimensoes_completo || {};
    const bareDimensions = p.dimensoes_sem_cama || {};

    if (completeDimensions.comprimento || completeDimensions.profundidade || completeDimensions.altura) {
      dimensionsParts.push(
        `Dimensões completas: ${[completeDimensions.comprimento, completeDimensions.profundidade, completeDimensions.altura].filter(Boolean).join(' x ')}${completeDimensions.descricao ? ` (${completeDimensions.descricao})` : ''}`
      );
    }

    if (bareDimensions.comprimento || bareDimensions.profundidade || bareDimensions.altura) {
      dimensionsParts.push(
        `Dimensões sem cama: ${[bareDimensions.comprimento, bareDimensions.profundidade, bareDimensions.altura].filter(Boolean).join(' x ')}${bareDimensions.descricao ? ` (${bareDimensions.descricao})` : ''}`
      );
    }

    snippets.push({
      title: p.nome || p.id || 'Produto',
      text: [
        p.descricao || '',
        dimensionsParts.join('\n'),
        `Preço: ${p.preco || 'Consultar'}`,
        `Condições: ${conditions}`,
      ].filter(Boolean).join('\n'),
    });
  }

  if (base.produtos && Array.isArray(base.produtos)) {
    for (const p of base.produtos) pushProduct(p);
  }
  if (catalog && catalog.produtos && Array.isArray(catalog.produtos)) {
    for (const p of catalog.produtos) pushProduct(p);
  }

  const regras = [];
  if (base.regras && Array.isArray(base.regras)) regras.push(...base.regras);
  if (catalog && catalog.regras && Array.isArray(catalog.regras)) regras.push(...catalog.regras);
  if (regras.length > 0) snippets.push({ title: 'Regras', text: regras.join('\n') });

  if (base.objetivo) snippets.push({ title: 'Objetivo', text: base.objetivo });
  if (catalog && catalog.objetivo) snippets.push({ title: 'Objetivo Comercial', text: catalog.objetivo });

  if (catalog && catalog.estrategia_vendas) {
    snippets.push({ title: 'Estrategia Vendas', text: JSON.stringify(catalog.estrategia_vendas, null, 2) });
  }
  if (catalog && catalog.condicoes_gerais) {
    snippets.push({ title: 'Condicoes Gerais', text: JSON.stringify(catalog.condicoes_gerais, null, 2) });
  }

  return snippets;
}

function retrieve(kb, message, topK = 3) {
  const words = (message || '').toLowerCase().split(/\W+/).filter(Boolean);
  const scores = kb.map(s => {
    const text = (s.title + ' ' + s.text).toLowerCase();
    let score = 0;
    for (const w of words) if (text.includes(w)) score += 1;
    return score;
  });
  const scored = kb.map((s, i) => ({ s, score: scores[i] }));
  scored.sort((a,b)=>b.score - a.score);
  return scored.slice(0, topK).filter(x=>x.score>0).map(x=>x.s);
}

function _snippetKey(snippet = {}) {
  return `${String(snippet.title || '').trim()}::${String(snippet.text || '').trim()}`;
}

function _isPolicySnippet(snippet = {}) {
  const title = String(snippet?.title || '').toLowerCase();
  if (!title) return false;

  const policyPatterns = [
    /objetivo/,
    /contexto/,
    /regras?/,
    /diagnostico/,
    /pacotes?/,
    /condicoes?/,
    /argumentacao/,
    /objecoes?/,
    /estrategia/,
    /logistica/,
  ];

  return policyPatterns.some((re) => re.test(title));
}

function _normalizeForSearch(text = '') {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function _nowMs() {
  return Date.now();
}

function _pruneRetrievalCache() {
  const now = _nowMs();
  for (const [phone, entry] of retrievalCriticalCache.entries()) {
    if (!entry || !entry.expiresAt || entry.expiresAt <= now) {
      retrievalCriticalCache.delete(phone);
    }
  }
}

function _isCriticalSnippet(snippet = {}) {
  const title = _normalizeForSearch(snippet?.title || '');
  if (!title) return false;

  const hardCriticalTitles = new Set([
    'regras comunicacao',
    'diagnostico comercial',
    'pacotes e condicoes',
    'argumentacao mercado',
    'objecoes playbook',
    'condicoes gerais',
  ]);

  if (hardCriticalTitles.has(title)) return true;
  return _snippetPriorityWeight(snippet) >= 1.3;
}

function _rememberCriticalSnippets(phone, snippets = []) {
  if (!phone) return;
  _pruneRetrievalCache();

  const keys = [];
  for (const snippet of snippets) {
    if (!_isCriticalSnippet(snippet)) continue;
    keys.push(_snippetKey(snippet));
    if (keys.length >= RETRIEVAL_CACHE_MAX_KEYS) break;
  }

  if (keys.length === 0) return;

  retrievalCriticalCache.set(phone, {
    keys,
    expiresAt: _nowMs() + RETRIEVAL_CACHE_TTL_MS,
  });
}

function _getCachedCriticalSnippets(phone, kb = []) {
  if (!phone) return [];
  _pruneRetrievalCache();

  const entry = retrievalCriticalCache.get(phone);
  if (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0) return [];

  const byKey = new Map(kb.map((snippet) => [_snippetKey(snippet), snippet]));
  const hydrated = [];

  for (const key of entry.keys) {
    const snippet = byKey.get(key);
    if (snippet) hydrated.push(snippet);
  }

  if (hydrated.length === 0) {
    retrievalCriticalCache.delete(phone);
  }

  return hydrated;
}

function _mergeSnippetLists(primary = [], secondary = [], max = 7) {
  const out = [];
  const seen = new Set();

  const add = (snippet) => {
    if (!snippet || out.length >= max) return;
    const key = _snippetKey(snippet);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(snippet);
  };

  for (const snippet of primary) add(snippet);
  for (const snippet of secondary) add(snippet);
  return out;
}

function _recordRetrievalTelemetry(payload = {}) {
  retrievalTelemetry.push({ timestamp: new Date().toISOString(), ...payload });
  if (retrievalTelemetry.length > RETRIEVAL_TELEMETRY_MAX) {
    retrievalTelemetry.splice(0, retrievalTelemetry.length - RETRIEVAL_TELEMETRY_MAX);
  }
}

function getRetrievalTelemetry(limit = 50) {
  const size = Math.max(1, Number(limit || 50));
  return retrievalTelemetry.slice(-size);
}

function _expandQueryTerms(message = '') {
  const normalized = _normalizeForSearch(message);
  const directTerms = normalized.split(/\W+/).filter(Boolean);
  const expanded = new Set(directTerms);

  const groups = [
    ['preco', 'valor', 'investimento', 'orcamento', 'desconto', 'condicao', 'condicoes', 'parcelado', 'parcelamento', 'cartao'],
    ['frete', 'montagem', 'instalacao', 'entrega', 'envio', 'prazo', 'logistica'],
    ['video', 'videos', 'foto', 'fotos', 'imagem', 'imagens', 'midia', 'catalogo', 'lista'],
    ['aluguel', 'alugar', 'locacao', 'locar'],
    ['brinquedao', 'pacote', 'completo', 'todos', 'estrutura', 'itens'],
    ['urgente', 'agora', 'imediato', 'prazo', 'quando', 'inicio'],
    ['duvida', 'objecao', 'objecoes', 'caro', 'barato'],
  ];

  for (const group of groups) {
    if (group.some((term) => expanded.has(term))) {
      for (const term of group) {
        expanded.add(term);
      }
    }
  }

  return {
    directTerms,
    expandedTerms: [...expanded],
    normalizedMessage: normalized,
  };
}

function _snippetPriorityWeight(snippet = {}) {
  const title = _normalizeForSearch(snippet?.title || '');
  if (!title) return 0;

  if (title.includes('regras comunicacao')) return 1.6;
  if (title.includes('diagnostico comercial')) return 1.5;
  if (title.includes('pacotes e condicoes')) return 1.5;
  if (title.includes('argumentacao mercado')) return 1.3;
  if (title.includes('objecoes playbook')) return 1.3;
  if (title.includes('condicoes gerais')) return 1.2;
  if (title.includes('logistica')) return 1.1;
  if (_isPolicySnippet(snippet)) return 0.8;
  return 0;
}

function _intentBoost(snippet = {}, normalizedMessage = '') {
  const title = _normalizeForSearch(snippet?.title || '');
  const message = _normalizeForSearch(normalizedMessage || '');
  if (!title || !message) return 0;

  if (/(preco|valor|desconto|investimento|orcamento|parcel)/.test(message)) {
    if (/(pacotes e condicoes|argumentacao mercado|condicoes gerais|objecoes playbook)/.test(title)) return 1.4;
  }

  if (/(frete|montagem|instalacao|entrega|envio|prazo|logistica)/.test(message)) {
    if (/(logistica|condicoes gerais)/.test(title)) return 1.5;
  }

  if (/(video|videos|foto|fotos|imagem|imagens|midia|catalogo|lista)/.test(message)) {
    if (/(regras comunicacao|pacotes e condicoes)/.test(title)) return 1.1;
  }

  if (/(aluguel|alugar|locacao|locar|fora de escopo)/.test(message)) {
    if (/(regras comunicacao|contexto negocio)/.test(title)) return 1.3;
  }

  if (/(objecao|objecoes|duvida|caro|barato|nao sei)/.test(message)) {
    if (/(objecoes playbook|argumentacao mercado)/.test(title)) return 1.2;
  }

  return 0;
}

function retrieveWithCoverage(kb, message, options = {}) {
  const topK = Number(options.topK || 5);
  const minPolicy = Number(options.minPolicy || 2);
  const minCatalog = Number(options.minCatalog || 2);
  const maxTotal = Number(options.maxTotal || 7);
  const returnMeta = options.returnMeta === true;

  const { directTerms, expandedTerms, normalizedMessage } = _expandQueryTerms(message);
  const scored = kb.map((snippet) => {
    const text = _normalizeForSearch(`${String(snippet?.title || '')} ${String(snippet?.text || '')}`);
    let score = 0;

    for (const w of directTerms) {
      if (text.includes(w)) score += 2;
    }

    for (const w of expandedTerms) {
      if (text.includes(w)) score += 1;
    }

    score += _snippetPriorityWeight(snippet);
    score += _intentBoost(snippet, normalizedMessage);

    return { snippet, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const withSignal = scored.filter((x) => x.score > 0);
  const policyPool = withSignal.filter((x) => _isPolicySnippet(x.snippet));
  const catalogPool = withSignal.filter((x) => !_isPolicySnippet(x.snippet));

  const selected = [];
  const selectedKeys = new Set();

  const add = (entry) => {
    if (!entry || !entry.snippet) return;
    const key = _snippetKey(entry.snippet);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(entry);
  };

  for (const entry of policyPool.slice(0, minPolicy)) add(entry);
  for (const entry of catalogPool.slice(0, minCatalog)) add(entry);

  for (const entry of withSignal) {
    if (selected.length >= topK) break;
    add(entry);
  }

  const mandatoryPolicyTitles = new Set([
    'regras comunicacao',
    'diagnostico comercial',
    'pacotes e condicoes',
    'argumentacao mercado',
    'objecoes playbook',
    'condicoes gerais',
  ]);

  const mandatoryPool = scored.filter((entry) => {
    const title = String(entry?.snippet?.title || '').toLowerCase();
    return mandatoryPolicyTitles.has(title);
  });

  for (const entry of mandatoryPool) {
    if (selected.length >= maxTotal) break;
    add(entry);
  }

  const selectedSnippets = selected.length === 0
    ? scored.slice(0, topK).map((x) => x.snippet).filter(Boolean)
    : selected.slice(0, maxTotal).map((x) => x.snippet);

  if (!returnMeta) {
    return selectedSnippets;
  }

  return {
    snippets: selectedSnippets,
    meta: {
      topSignals: withSignal.slice(0, 10).map((entry) => ({
        title: String(entry?.snippet?.title || ''),
        score: Number(entry?.score || 0),
      })),
      selectedPolicyCount: selectedSnippets.filter((snippet) => _isPolicySnippet(snippet)).length,
      selectedCatalogCount: selectedSnippets.filter((snippet) => !_isPolicySnippet(snippet)).length,
      totalWithSignal: withSignal.length,
    },
  };
}

// LLM adapter — usa Anthropic quando a chave estiver disponível, senão fallback simulado
const Anthropic = require('@anthropic-ai/sdk');
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const anthropicClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

function pickFirstNonRepeated(candidates, recentTexts = []) {
  const recent = new Set((recentTexts || []).map((t) => String(t || '').trim().toLowerCase()));
  for (const item of candidates) {
    const normalized = String(item || '').trim().toLowerCase();
    if (normalized && !recent.has(normalized)) {
      return item;
    }
  }
  return candidates[0] || '';
}

function sentenceFromText(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const first = raw.split(/[.!?]\s/)[0] || raw;
  return first.trim();
}

function extractLikelyName(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 32) return null;

  const normalized = raw
    .replace(/[0-9]/g, ' ')
    .replace(/[!?.,;:()\[\]{}"/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;

  const blocked = new Set([
    'oi', 'ola', 'olá', 'bom', 'boa', 'tarde', 'dia', 'noite', 'tenho', 'quero', 'preciso', 'passa', 'valor',
  ]);
  if (parts.some((p) => blocked.has(p.toLowerCase()))) return null;

  const validName = parts.every((p) => /^[A-Za-zÀ-ÿ']{2,}$/.test(p));
  if (!validName) return null;

  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

function getTimeGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Bom dia!';
  if (hour >= 12 && hour < 18) return 'Boa tarde!';
  return 'Boa noite!';
}

function normalizeTextForSignals(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHistoryForFallback(history = []) {
  if (!Array.isArray(history)) return [];

  return history
    .map((entry) => {
      if (!entry) return null;

      if (typeof entry === 'string') {
        const raw = entry.trim();
        if (!raw) return null;

        const leadMatch = raw.match(/^lead:\s*(.*)$/i);
        if (leadMatch) return { from: 'user', text: String(leadMatch[1] || '').trim() };

        const botMatch = raw.match(/^bot:\s*(.*)$/i);
        if (botMatch) return { from: 'bot', text: String(botMatch[1] || '').trim() };

        return { from: 'unknown', text: raw };
      }

      if (typeof entry === 'object') {
        const from = entry.from === 'user' || entry.from === 'bot' ? entry.from : 'unknown';
        const text = String(entry.text || '').trim();
        if (!text) return null;
        return { from, text };
      }

      return null;
    })
    .filter(Boolean);
}

function _snippetLinesForFallback(snippets = []) {
  if (!Array.isArray(snippets)) return [];

  return snippets
    .flatMap((snippet) => String(snippet?.text || '').split(/\n+/))
    .map((line) => String(line || '').trim())
    .filter(Boolean);
}

function _cleanFallbackSnippetLine(line = '') {
  let out = String(line || '').trim();
  out = out.replace(/^"([^"]+)"\s*:\s*/, '$1: ');
  out = out.replace(/^"|"$/g, '');
  out = out.replace(/,+$/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function _buildDirectCommercialLine(context = {}, normalizedMessage = '') {
  const message = normalizeTextForSignals(normalizedMessage);
  const asksPrice = /(quanto|valor|preco|preço|orcamento|orçamento|investimento|parcel)/.test(message);
  const asksLogistics = /(frete|entrega|prazo|montagem|instalacao|instalação|envio|transport)/.test(message);
  if (!asksPrice && !asksLogistics) return null;

  const lines = _snippetLinesForFallback(context?.kbSnippets || []);
  const normalizedLines = lines.map((line) => ({
    raw: _cleanFallbackSnippetLine(line),
    norm: normalizeTextForSignals(line),
  }));

  const priceLine = normalizedLines.find((item) => /^preco\s*:/.test(item.norm))?.raw
    || normalizedLines.find((item) => /^valor\s*:/.test(item.norm))?.raw
    || normalizedLines.find((item) => item.norm.includes('preco') || item.norm.includes('valor'))?.raw
    || '';
  const conditionLine = normalizedLines.find((item) => item.norm.includes('condicoes') || item.norm.includes('parcel'))?.raw || '';
  const logisticsLine = normalizedLines.find((item) => /(frete|entrega|prazo|montagem|instalacao|envio|logistica)/.test(item.norm))?.raw || '';

  const parts = [];

  if (asksPrice) {
    if (priceLine) {
      const clean = String(priceLine)
        .replace(/^pre[cç]o:\s*/i, '')
        .replace(/^valor:\s*/i, '')
        .trim();
      parts.push(clean ? `Sobre valor, referência atual: ${clean}.` : `Sobre valor, eu te passo a condição mais assertiva conforme o pacote.`);
    } else {
      parts.push('Sobre valor, eu te passo a condição mais assertiva conforme o pacote e o volume que você precisa.');
    }

    if (conditionLine) {
      const clean = String(conditionLine).replace(/^condi[cç][oõ]es:\s*/i, '').trim();
      if (clean) parts.push(`Condição comercial de referência: ${clean}.`);
    }
  }

  if (asksLogistics) {
    if (logisticsLine) {
      const clean = String(logisticsLine)
        .replace(/^frete:\s*/i, '')
        .replace(/^entrega:\s*/i, '')
        .replace(/^"|"$/g, '')
        .replace(/"/g, '')
        .replace(/[.]+$/g, '')
        .trim();
      parts.push(`Sobre entrega, ${clean || logisticsLine}.`);
    } else {
      parts.push('Sobre entrega e montagem, organizamos conforme sua cidade e o prazo desejado.');
    }
  }

  if (parts.length === 0) return null;
  return parts.join(' ');
}

function _buildEarlyCommercialValueLine(context = {}, normalizedMessage = '') {
  const message = normalizeTextForSignals(normalizedMessage);
  const facts = context?.commercialContext?.facts || {};
  const snippets = Array.isArray(context?.kbSnippets) ? context.kbSnippets : [];
  const hasProductSnippet = snippets.some((snippet) => !_isPolicySnippet(snippet));

  const wantsAttraction = /(atrativo|atrair|fluxo|mais clientes|movimentar|faturar|area de lazer|área de lazer)/.test(message)
    || facts.goal === 'aumentar_fluxo'
    || facts.goal === 'espaco_kids';

  const isCommercialBusiness = facts.businessType === 'loja' || facts.businessType === 'restaurante' || facts.businessType === 'buffet';

  if (wantsAttraction) {
    return hasProductSnippet
      ? 'Perfeito, para aumentar fluxo e permanencia das familias, o ideal e montar uma estrutura com forte impacto visual e ticket recorrente.'
      : 'Perfeito, para aumentar fluxo e permanencia das familias, faz sentido estruturar um espaco kids com apelo comercial real.';
  }

  if (isCommercialBusiness) {
    return 'Entendi seu cenario, a proposta aqui e usar o playground como alavanca de permanencia e conversao dentro da operacao.';
  }

  return null;
}

function _extractPriceHintFromSnippet(snippet = {}) {
  const lines = String(snippet?.text || '').split(/\n+/).map((line) => String(line || '').trim());
  const priceLine = lines.find((line) => /^pre[cç]o\s*:/i.test(line) || /^valor\s*:/i.test(line));
  if (!priceLine) return '';

  const clean = _cleanFallbackSnippetLine(priceLine)
    .replace(/^pre[cç]o\s*:/i, '')
    .replace(/^valor\s*:/i, '')
    .trim();

  return clean;
}

function _presentationPriorityScore(snippet = {}, facts = {}) {
  const title = normalizeTextForSignals(String(snippet?.title || ''));
  if (!title) return 0;

  let score = 0;

  // Prioridade comercial do funil: foco em Brinquedao e pacote principal.
  if (/brinquedao|brinquedao gigante|cama elastica/.test(title)) score += 120;
  if (/pacote marketing|pacote/.test(title) && /brinquedao|cama elastica/.test(title)) score += 110;

  // Itens secundarios ficam abaixo do produto principal.
  if (/area baby|espumad/.test(title)) score += 35;
  if (/parede de escalada|tombo legal|gira gira|kid play/.test(title)) score += 20;

  if (facts.goal === 'aumentar_fluxo' || facts.goal === 'espaco_kids') {
    if (/brinquedao|cama elastica/.test(title)) score += 25;
    if (/area baby|espumad/.test(title)) score += 5;
  }

  return score;
}

function _buildPresentationRecommendation(context = {}, facts = {}) {
  const snippets = Array.isArray(context?.kbSnippets) ? context.kbSnippets : [];
  const catalogSnippets = snippets.filter((snippet) => !_isPolicySnippet(snippet));
  const primary = catalogSnippets
    .map((snippet, index) => ({ snippet, index, score: _presentationPriorityScore(snippet, facts) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.snippet)[0] || null;

  if (primary) {
    const title = String(primary.title || 'estrutura principal').trim();
    const priceHint = _extractPriceHintFromSnippet(primary);

    if (facts.goal === 'aumentar_fluxo' || facts.goal === 'espaco_kids') {
      return priceHint
        ? `Pelo seu cenário, a recomendação mais assertiva é ${title}, com referência de ${priceHint}, por gerar impacto visual e aumentar permanência das famílias.`
        : `Pelo seu cenário, a recomendação mais assertiva é ${title}, por gerar impacto visual e aumentar permanência das famílias.`;
    }

    return priceHint
      ? `Com base no que você trouxe, a melhor indicação agora é ${title}, com referência de ${priceHint}.`
      : `Com base no que você trouxe, a melhor indicação agora é ${title}.`;
  }

  return 'Com base no seu cenário, eu já consigo te indicar uma configuração com alta aderência comercial para gerar fluxo e conversão.';
}

function extractCommercialContextFromMessage(message, questionIntents = [], currentCommercialContext = {}, quotedMessage = null) {
  const lower = normalizeTextForSignals(message);
  const lowerQuoted = normalizeTextForSignals(quotedMessage || '');
  const facts = { ...(currentCommercialContext?.facts || {}) };
  const answersByIntent = { ...(currentCommercialContext?.answersByIntent || {}) };
  const signals = Array.isArray(currentCommercialContext?.signals) ? currentCommercialContext.signals.slice() : [];
  const opportunities = Array.isArray(currentCommercialContext?.opportunities) ? currentCommercialContext.opportunities.slice() : [];
  const lastIntent = Array.isArray(questionIntents) && questionIntents.length > 0
    ? questionIntents[questionIntents.length - 1]
    : '';

  if (lastIntent) {
    answersByIntent[lastIntent] = String(message || '').trim();
  }

  const isAffirmative = /^(sim|isso|isso mesmo|exato|certo|correto|quero|quero sim|pode ser|ok|perfeito|claro|com certeza)$/.test(lower);
  const isNegative = /^(nao|não|ainda nao|ainda não|depois|mais tarde|agora nao|agora não)$/.test(lower);

  if (quotedMessage && (isAffirmative || isNegative)) {
    answersByIntent.reply_to_quote = `${String(quotedMessage || '').trim()} => ${String(message || '').trim()}`;

    if (/(do zero|montar um? espaco|montar um? espaço|abrir um? espaco|abrir um? espaço|quero montar|pensando em montar)/.test(lowerQuoted)) {
      if (isAffirmative) {
        facts.situation = 'do_zero';
        signals.push('citacao_confirma_montar_do_zero');
      }
    }

    if (/(ja tem|já tem|ja possui|já possui|complementar|completar|ja existe|já existe)/.test(lowerQuoted)) {
      if (isAffirmative) {
        facts.situation = 'already_has_structure';
        signals.push('citacao_confirma_estrutura_existente');
      }
    }

    if (/(restaurante|buffet|loja|area de lazer|área de lazer|espaco kids|espaço kids)/.test(lowerQuoted)) {
      if (isAffirmative) {
        facts.goal = facts.goal || 'espaco_kids';
        signals.push('citacao_confirma_contexto_comercial');
      }
    }
  }

  if (/(do zero|montar um? espaco|montar um? espaço|abrir um? espaco|abrir um? espaço|pensando em montar|quero montar|pretendo montar|montar um projeto)/.test(lower)) {
    facts.situation = 'do_zero';
    signals.push('lead_quer_montar_do_zero');
  }

  if (/(ja tenho|já tenho|ja tem|já tem|complementar|completar|ja possui|já possui|ja existe|já existe)/.test(lower)) {
    facts.situation = 'already_has_structure';
    signals.push('lead_ja_tem_estrutura');
  }

  if (/(restaurante)/.test(lower)) {
    facts.businessType = 'restaurante';
    opportunities.push('restaurante_com_espaco_kids');
  }

  if (/(buffet|buffet infantil)/.test(lower)) {
    facts.businessType = 'buffet';
    opportunities.push('buffet_infantil');
  }

  if (/(loja|lojista|minha loja)/.test(lower)) {
    facts.businessType = 'loja';
    opportunities.push('loja_com_atracao_de_clientes');
  }

  if (/(area de lazer|área de lazer|espaco kids|espaço kids|kids)/.test(lower)) {
    facts.goal = 'espaco_kids';
    signals.push('objetivo_espaco_kids');
  }

  if (/(atrair|movimentar|vender mais|mais clientes|faturar|fluxo|encher|lotar)/.test(lower)) {
    facts.goal = 'aumentar_fluxo';
    signals.push('objetivo_aumentar_fluxo');
  }

  if (/(quanto|valor|preco|preço|orcamento|orçamento|investimento|parcel|parcelar|parcelas)/.test(lower)) {
    facts.budgetSignal = 'asked_budget_or_price';
    signals.push('buscando_preco_ou_investimento');
  }

  if (/(urgente|agora|imediato|essa semana|hoje|o quanto antes)/.test(lower)) {
    facts.urgency = 'immediate';
    signals.push('urgencia_imediata');
  }

  if (/(sem pressa|avaliando|depois|mais tarde|pesquisando|cotando)/.test(lower)) {
    facts.urgency = 'evaluating';
    signals.push('urgencia_avaliacao');
  }

  if (/(foto|fotos|video|vídeo|videos|vídeos|mostrar|me manda|me envie|quero ver)/.test(lower)) {
    signals.push('quer_midia');
  }

  if (/(restaurante.*kids|kids.*restaurante|buffet.*kids|kids.*buffet)/.test(lower)) {
    opportunities.push('espaco_kids_em_negocio_existente');
  }

  const dedupe = (items) => [...new Set((Array.isArray(items) ? items : []).filter(Boolean))].slice(-12);

  return {
    facts,
    answersByIntent,
    signals: dedupe(signals),
    opportunities: dedupe(opportunities),
  };
}

function buildFallbackResponse(context = {}) {
  const mode = context.mode || 'inbound';
  const stage = String(context.stage || 'conexao').toLowerCase();
  const originalMessage = String(context.message || '').trim();
  const message = normalizeTextForSignals(originalMessage);
  const history = normalizeHistoryForFallback(context.history);
  const recentBotTexts = history
    .filter((h) => h && h.from === 'bot')
    .slice(-4)
    .map((h) => h.text || '');

  if (mode === 'proactive') {
    const status = String(context.followupStatus || 'default_pause');
    const line = pickFirstNonRepeated([
      `Oi! Tudo bem? Só passando para retomar de onde paramos.`,
      `Fico à disposição se quiser continuar a conversa de onde deixamos.`,
    ], recentBotTexts);
    return {
      stage: stage || 'diagnostico',
      reason: 'fallback-proactive',
      client_name: null,
      pronto: false,
      messages: [line],
    };
  }

  // Funil por estágio
  if (stage === 'conexao') {
    const hasOngoingConversation = history.filter((h) => h && h.text).length >= 2;

    const hasStrongCommercialSignal = /(quanto|valor|preco|preço|orcamento|orçamento|investimento|condi[cç][aã]o|parcel|frete|entrega|prazo|montagem|instala[cç][aã]o|video|vídeo|foto|fotos|catalogo|catálogo)/.test(message);
    const hasEngagedIntent = /(preciso|quero|interesse|avaliando|cotando|atrativo|area de lazer|área de lazer|minha loja|cliente|fluxo)/.test(message);

    if (hasStrongCommercialSignal || (hasOngoingConversation && hasEngagedIntent)) {
      const directCommercialLine = _buildDirectCommercialLine(context, message);
      const earlyValueLine = _buildEarlyCommercialValueLine(context, message);
      const diagnosticQuestion = pickFirstNonRepeated([
        'Para te direcionar com precisão, você quer montar do zero ou complementar uma estrutura que já existe?',
        'Me confirma um ponto: você está iniciando operação kids agora ou já atua com esse público?',
      ], recentBotTexts);

      const messages = directCommercialLine
        ? [directCommercialLine, diagnosticQuestion]
        : [(earlyValueLine || pickFirstNonRepeated([
            'Perfeito, te explico isso. Para eu te direcionar certo, você quer montar do zero ou complementar uma estrutura que já existe?',
            'Ótimo ponto. Antes de te passar o melhor caminho, me conta se você está começando agora ou se já opera com espaço kids.',
          ], recentBotTexts)), diagnosticQuestion];

      return {
        stage: 'diagnostico',
        reason: 'fallback-conexao-commercial-signal',
        client_name: null,
        pronto: false,
        messages,
      };
    }

    if (hasOngoingConversation) {
      return {
        stage: 'diagnostico',
        reason: 'fallback-conexao-ongoing-history',
        client_name: null,
        pronto: false,
        messages: [pickFirstNonRepeated([
          'Perfeito, seguimos por aqui. Para eu te orientar melhor, você vai montar um espaço novo ou complementar um que já existe?',
          'Entendi. Vamos continuar de onde paramos, qual é a sua principal dúvida neste momento?',
          'Fechado. Para eu te ajudar melhor agora, você está iniciando operação kids ou já atua com esse público?',
        ], recentBotTexts)],
      };
    }

    // Se nome já existe (ou veio em mensagem curta), evita repetir onboarding.
    const knownName = String(context.name || '').trim();
    const inferredName = knownName ? null : extractLikelyName(originalMessage);
    const effectiveName = knownName || inferredName || '';

    if (effectiveName) {
      const messages = [
        pickFirstNonRepeated([
          `Perfeito, ${effectiveName}.`,
          `Prazer, ${effectiveName}.`,
        ], recentBotTexts),
        pickFirstNonRepeated([
          'Me conta seu cenário para eu te indicar a melhor configuração.',
          'Você já tem espaço definido para montagem ou está avaliando as opções?',
          'Você quer montar do zero ou complementar algo que já existe?',
        ], recentBotTexts),
      ];

      return {
        stage: 'conexao',
        reason: 'fallback-conexao-name-known',
        client_name: effectiveName,
        pronto: false,
        messages: messages.filter(Boolean),
      };
    }

    // Acolhimento + interesse comercial, SEM perguntas técnicas
    const greeting = getTimeGreeting();
    const messages = [
      pickFirstNonRepeated([
        greeting,
        'Bom dia!',
        'Boa tarde!',
        'Boa noite!',
      ], recentBotTexts),
      pickFirstNonRepeated([
        'Pode me dizer seu nome?',
        'Com quem estou falando?',
        'Me fala seu nome, por favor.',
      ], recentBotTexts),
    ];
    return {
      stage: 'conexao',
      reason: 'fallback-conexao',
      client_name: null,
      pronto: false,
      messages: messages.filter(Boolean),
    };
  }

  if (stage === 'diagnostico') {
    const facts = context?.commercialContext?.facts || {};
    const directCommercialLine = _buildDirectCommercialLine(context, message);

    const hasSituation = Boolean(facts.situation)
      || /(do zero|iniciando|começando|comecando|ja trabalho|já trabalho|ja tenho|já tenho|ja atuo|já atuo|segmento kids|espaco kids|espaço kids)/.test(message);

    const hasIntent = Boolean(facts.goal)
      || /(estou buscando|procuro|quero|preciso|interesse|buscando|avaliando|cotando|orçamento|orcamento|do zero|complementar|ja tenho|já tenho|ja atuo|já atuo)/.test(message);

    const hasUrgency = Boolean(facts.urgency)
      || /(urgente|agora|essa semana|esse mes|esse mês|imediato|logo|depois|sem pressa|avaliando)/.test(message);

    const missing = [];
    if (!hasSituation) missing.push('se você está iniciando a operação kids ou já trabalha com isso');
    if (!hasIntent) missing.push('se você quer montar do zero ou complementar uma operação que já existe');
    if (!hasUrgency) missing.push('se sua necessidade é imediata ou se ainda está avaliando');

    const collectedSignals = [hasSituation, hasIntent, hasUrgency].filter(Boolean).length;
    if (collectedSignals >= 2) {
      return {
        stage: 'apresentacao',
        reason: 'fallback-diagnostico-auto-advance',
        client_name: null,
        pronto: false,
        messages: [
          _buildPresentationRecommendation(context, facts),
          'Se fizer sentido, eu já te envio a condição completa com valor e logística para sua cidade.',
        ],
      };
    }

    let msg = 'Perfeito, com isso eu já consigo te mostrar a opção mais aderente para o seu cenário.';
    if (missing.length === 1) {
      msg = `Perfeito. Para fechar o direcionamento, me conta ${missing[0]}.`;
    } else if (missing.length > 1) {
      const toAsk = missing.slice(0, 2);
      msg = pickFirstNonRepeated([
        `Para eu te direcionar com objetividade, me conta ${toAsk.join(', ')}.`,
        `Fechado, só preciso de mais um ponto: ${toAsk.join(', ')}.`,
      ], recentBotTexts);
    }

    const messages = directCommercialLine
      ? [
          directCommercialLine,
          missing.length > 0
            ? `Para eu te direcionar melhor, me conta ${missing[0]}.`
            : 'Se você quiser, eu já te sugiro o pacote mais aderente para o seu cenário.',
        ]
      : [msg];

    return {
      stage: 'diagnostico',
      reason: 'fallback-diagnostico',
      client_name: null,
      pronto: false,
      messages,
    };
  }

  if (stage === 'apresentacao') {
    // Mostrar valor, não fazer mais perguntas técnicas
    const msg = pickFirstNonRepeated([
      'O Brinquedão com Cama Elástica é o coração do projeto e o que mais gera impacto visual.',
      'Essa estrutura é praticamente nova, com muito pouco uso, e está bem abaixo do valor de mercado.',
    ], recentBotTexts);

    const cta = pickFirstNonRepeated([
      'Se fizer sentido para você, eu já te envio a condição completa com valor e logística para sua cidade.',
      'Quer que eu te monte agora a melhor condição para fechar com segurança?',
    ], recentBotTexts);

    return {
      stage: 'apresentacao',
      reason: 'fallback-apresentacao',
      client_name: null,
      pronto: false,
      messages: [msg, cta],
    };
  }

  if (stage === 'validacao') {
    // Validar se faz sentido
    const msg = pickFirstNonRepeated([
      'Faz sentido para você?',
      'Isso encaixa no que você procura?',
      'Quer que eu ajuste algo?',
    ], recentBotTexts);
    return {
      stage: 'validacao',
      reason: 'fallback-validacao',
      client_name: null,
      pronto: false,
      messages: [msg],
    };
  }

  if (stage === 'objecoes') {
    // Validar preocupação, reforçar valor, próximo passo
    const msg = pickFirstNonRepeated([
      'Entendo sua preocupação. Na prática, o que importa é escolher algo que realmente resolva a necessidade.',
      'Isso é totalmente normal considerar. Posso te ajudar a ver isso de forma mais clara.',
    ], recentBotTexts);
    return {
      stage: 'objecoes',
      reason: 'fallback-objecoes',
      client_name: null,
      pronto: false,
      messages: [msg],
    };
  }

  if (stage === 'negociacao') {
    // Opções, condições, próximo passo
    const msg = pickFirstNonRepeated([
      'Se você tiver interesse em levar todos os brinquedos, consigo estruturar uma condição bem competitiva.',
      'Quer que eu organize a proposta para você analisar?',
    ], recentBotTexts);
    return {
      stage: 'negociacao',
      reason: 'fallback-negociacao',
      client_name: null,
      pronto: false,
      messages: [msg],
    };
  }

  if (stage === 'fechamento') {
    // Confirmar desfecho
    const msg = pickFirstNonRepeated([
      'Então fechamos dessa forma?',
      'Quer que eu organize o resumo final?',
    ], recentBotTexts);
    return {
      stage: 'fechamento',
      reason: 'fallback-fechamento',
      client_name: null,
      pronto: false,
      messages: [msg],
    };
  }

  // Fallback genérico (se estágio for unknown)
  const messages = [
    'Entendi sua mensagem.',
    'Como posso te ajudar melhor?',
  ];
  return {
    stage: 'conexao',
    reason: 'fallback-generic',
    client_name: null,
    pronto: false,
    messages: messages.filter(Boolean),
  };
}

async function callLLM(systemPrompt, userPrompt, context = {}) {

  if (!anthropicClient) {
    // API key não configurada, retorna fallback contextual
    return buildFallbackResponse(context);
  }

  try {
    const response = await anthropicClient.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content?.[0]?.text?.trim() || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Se a resposta não for JSON, transforma em uma mensagem simples
      return {
        stage: 'unknown',
        reason: 'non-json-response',
        client_name: null,
        pronto: false,
        messages: cleaned ? [cleaned] : ['Desculpe, não entendi a resposta do modelo.']
      };
    }

    const messages = Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages
      : (parsed.reply ? [parsed.reply] : ['Desculpe, não entendi a resposta.']);

    return {
      stage: parsed.stage || 'unknown',
      reason: parsed.reason || '',
      client_name: parsed.client_name || null,
      pronto: parsed.pronto === true,
      messages,
    };
  } catch (err) {
    console.error('[Engine] Erro ao chamar Anthropic:', err.message);
    return buildFallbackResponse(context);
  }
}

async function generateResponse({ phone, name, message, history = [], stage = null, summary = null, quotedMessage = null, quotedAuthor = null, quotedIsBot = false }) {
  const dialogState = dialog.getState(phone);
  const effectiveStage = String(stage || dialogState?.stage || 'conexao').toLowerCase();
  let effectiveName = String(name || dialogState?.name || '').trim() || null;

  if (!effectiveName && effectiveStage === 'conexao') {
    const inferredName = extractLikelyName(message);
    if (inferredName) {
      dialog.setName(phone, inferredName);
      effectiveName = inferredName;
    }
  }

  const kb = loadKB();
  const retrieval = retrieveWithCoverage(kb, message, {
    topK: 5,
    minPolicy: 2,
    minCatalog: 2,
    maxTotal: 7,
    returnMeta: true,
  });
  const cachedCritical = _getCachedCriticalSnippets(phone, kb);
  const snippets = _mergeSnippetLists(retrieval.snippets, cachedCritical, 7);
  _rememberCriticalSnippets(phone, snippets);
  _recordRetrievalTelemetry({
    mode: 'inbound',
    phone: String(phone || ''),
    query: String(message || ''),
    selectedTitles: snippets.map((snippet) => String(snippet?.title || '')).slice(0, 10),
    cachedInjectedTitles: cachedCritical.map((snippet) => String(snippet?.title || '')).slice(0, 6),
    topSignals: Array.isArray(retrieval?.meta?.topSignals) ? retrieval.meta.topSignals : [],
    selectedPolicyCount: Number(retrieval?.meta?.selectedPolicyCount || 0),
    selectedCatalogCount: Number(retrieval?.meta?.selectedCatalogCount || 0),
    totalWithSignal: Number(retrieval?.meta?.totalWithSignal || 0),
  });
  const system = templates.buildSystem();
  const persistedSummary = summary || dialog.getSummary(phone) || null;
  const currentCommercialContext = dialog.getCommercialContext(phone);
  const questionIntents = dialog.getQuestionIntents(phone);
  const extractedCommercialContext = extractCommercialContextFromMessage(message, questionIntents, currentCommercialContext, quotedMessage);
  dialog.updateCommercialContext(phone, extractedCommercialContext);
  const refreshedCommercialContext = dialog.getCommercialContext(phone);
  const userPrompt = templates.buildUserPrompt({
    phone,
    name: effectiveName,
    message,
    quotedMessage,
    kb_snippets: snippets,
    history,
    stage: effectiveStage,
    summary: persistedSummary,
    commercialContext: refreshedCommercialContext,
  });
  const llmResult = await callLLM(system, userPrompt, {
    mode: 'inbound',
    phone,
    name: effectiveName,
    message,
    history,
    stage: effectiveStage,
    summary: persistedSummary,
    commercialContext: refreshedCommercialContext,
    quotedMessage,
    quotedAuthor,
    quotedIsBot,
    kbSnippets: snippets,
  });
  
  // Atualiza o Dialog Manager com o histórico e estado
  dialog.addMessage(phone, 'user', message, quotedMessage ? {
    type: 'quoted_reply',
    quoted_message: quotedMessage,
    quoted_author: quotedAuthor || null,
    quoted_is_bot: !!quotedIsBot,
  } : {});
  
  // Lead Scoring: detecta sinais de interesse
  const lower = (message || '').toLowerCase();
  if (/preço|valor|quanto|cust|detalh|especificação|entrega|pagamento|parcel/.test(lower)) {
    dialog.updateScore(phone, 10); // Pergunta específica = interesse
  }
  if (/sim|quero|compr|vamos|fechar|interesse|gost|perfeito|ok|claro/.test(lower)) {
    dialog.updateScore(phone, 15); // Sinais positivos
  }
  if (/foto|vídeo|video|mostre|ve|mostra/.test(lower)) {
    dialog.updateScore(phone, 5); // Curiosidade/visualização
  }
  if (/caro|maracaro|não|difícil|dúvida|depois|ainda não|não sei/.test(lower)) {
    dialog.updateScore(phone, 3); // Objeção, mas ainda engajado
  }
  
  if (llmResult.client_name && !name) {
    dialog.setName(phone, llmResult.client_name);
  }
  
  dialog.updateStage(phone, llmResult.stage);
  dialog.addMessage(phone, 'bot', llmResult.messages.join('\n'));
  
  const currentState = dialog.getState(phone);
  const closingSignal = evaluateClosingSignal(message, llmResult, currentState);
  
  return {
    ...llmResult,
    kb_snippets: snippets,
    dialog_state: currentState,
    closing_signal: closingSignal,
  };
}

function evaluateClosingSignal(userMessage, llmResult, currentState) {
  const lower = (userMessage || '').toLowerCase();
  const stage = (currentState?.stage || 'unknown').toLowerCase();
  const score = Number(currentState?.score || 0);

  const hasIntentToClose = /(vou fechar|fecha hoje|vamos fechar|pode fechar|quero fechar|me manda contrato|manda contrato|dados para pagamento|dados de pagamento|pix|como pagar|forma de pagamento|reserva|sinal)/.test(lower);
  const nearAutonomyLimit = /(ultimo preço|último preço|melhor preço final|dados de pagamento|me passa o pix|chave pix|pode emitir|emite|gera contrato|contrato|nota fiscal|fechar agora)/.test(lower);
  const hasDecisionLanguage = /(gostei|perfeito|faz sentido|ok, pode|vamos nessa|quero avançar|vamos avançar|seguimos|combina pra mim)/.test(lower);
  const stageIsAdvanced = stage === 'negociacao' || stage === 'fechamento';
  const isReady = llmResult?.pronto === true;

  const checkpoints = [];
  if (stageIsAdvanced) checkpoints.push(`Estágio em ${stage}`);
  if (score >= 35) checkpoints.push(`Score ${score}`);
  if (hasDecisionLanguage) checkpoints.push('Linguagem de decisão do lead');
  if (hasIntentToClose) checkpoints.push('Intenção explícita de fechamento');
  if (nearAutonomyLimit) checkpoints.push('Chegando no limite de autonomia do bot');
  if (isReady) checkpoints.push('Modelo marcou lead pronto');

  let level = 'none';
  if (isReady || hasIntentToClose) {
    level = 'closing_now';
  } else if (stage === 'fechamento' || (stage === 'negociacao' && score >= 45)) {
    level = 'very_hot';
  } else if (stageIsAdvanced || (score >= 35 && hasDecisionLanguage)) {
    level = 'hot';
  }

  const notifyOwner = (level === 'closing_now' || level === 'very_hot')
    && (isReady || hasIntentToClose || nearAutonomyLimit || (stage === 'fechamento' && score >= 55));

  return {
    level,
    is_advanced: level !== 'none',
    notify_owner: notifyOwner,
    autonomy_boundary: nearAutonomyLimit || isReady,
    stage,
    score,
    checkpoints,
  };
}

async function generateProactiveFollowup({
  phone,
  name = null,
  history = [],
  stage = null,
  summary = null,
  followupStatus = 'default_pause',
}) {
  const kb = loadKB();
  const retrievalSeed = `retomada ativa ${stage || ''} followup continuidade negociação`;
  const retrieval = retrieveWithCoverage(kb, retrievalSeed, {
    topK: 5,
    minPolicy: 2,
    minCatalog: 1,
    maxTotal: 7,
    returnMeta: true,
  });
  const cachedCritical = _getCachedCriticalSnippets(phone, kb);
  const snippets = _mergeSnippetLists(retrieval.snippets, cachedCritical, 7);
  _rememberCriticalSnippets(phone, snippets);
  _recordRetrievalTelemetry({
    mode: 'proactive',
    phone: String(phone || ''),
    query: retrievalSeed,
    selectedTitles: snippets.map((snippet) => String(snippet?.title || '')).slice(0, 10),
    cachedInjectedTitles: cachedCritical.map((snippet) => String(snippet?.title || '')).slice(0, 6),
    topSignals: Array.isArray(retrieval?.meta?.topSignals) ? retrieval.meta.topSignals : [],
    selectedPolicyCount: Number(retrieval?.meta?.selectedPolicyCount || 0),
    selectedCatalogCount: Number(retrieval?.meta?.selectedCatalogCount || 0),
    totalWithSignal: Number(retrieval?.meta?.totalWithSignal || 0),
  });
  const system = templates.buildSystem();
  const persistedSummary = summary || dialog.getSummary(phone) || null;
  const commercialContext = dialog.getCommercialContext(phone);

  const proactiveInstruction = [
    'Retomada ativa: o cliente ficou inativo após a última mensagem do atendimento.',
    `Status da pausa: ${followupStatus}.`,
    'Com base no histórico e no estágio atual, gere 1 ou 2 mensagens curtas para retomar a conversa.',
    'A mensagem deve soar humana, contextual e orientada a próximo passo.',
    'Não repetir literalmente a última mensagem já enviada.',
  ].join(' ');

  const userPrompt = templates.buildUserPrompt({
    phone,
    name,
    message: proactiveInstruction,
    kb_snippets: snippets,
    history,
    stage,
    summary: persistedSummary,
    commercialContext,
  });

  const llmResult = await callLLM(system, userPrompt, {
    mode: 'proactive',
    phone,
    name,
    message: proactiveInstruction,
    history,
    stage,
    followupStatus,
    summary: persistedSummary,
    commercialContext,
    kbSnippets: snippets,
  });
  const messages = Array.isArray(llmResult.messages)
    ? llmResult.messages.filter((m) => m && m.trim()).slice(0, 2)
    : [];

  return {
    ...llmResult,
    messages: messages.length > 0
      ? messages
      : ['Oi, ficou pendente um ponto da sua negociação. Quer que eu te ajude a fechar isso agora?'],
    kb_snippets: snippets,
  };
}

function getDialogState(phone) {
  return dialog.getState(phone);
}

function getDialogHistory(phone, limit) {
  const rawHistory = dialog.getHistory(phone, limit);
  return rawHistory.map(h => `${h.from === 'user' ? 'Lead' : 'Bot'}: ${h.text}`);
}

module.exports = {
  loadKB,
  retrieve,
  retrieveWithCoverage,
  getRetrievalTelemetry,
  generateResponse,
  generateProactiveFollowup,
  getDialogState,
  getDialogHistory,
  dialog,
};
