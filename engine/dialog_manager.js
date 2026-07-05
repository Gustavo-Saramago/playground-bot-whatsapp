'use strict';

const fs = require('fs');
const path = require('path');

// Dialog Manager — gerencia estado, histórico e resumo por lead
const STORE_PATH = path.join(__dirname, '..', '.dialog_state.json');

function _defaultCommercialContext() {
  return {
    answersByIntent: {},
    facts: {
      businessType: null,
      situation: null,
      goal: null,
      spaceType: null,
      budgetSignal: null,
    },
    signals: [],
    opportunities: [],
    lastUpdatedAt: null,
  };
}

const dialogs = new Map(); // phone -> { stage, name, history[], summary, questionIntents[], commercialContext, createdAt, lastUpdatedAt }

function _loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return;
    }

    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    for (const [phone, dialog] of Object.entries(parsed)) {
      if (!phone || !dialog || typeof dialog !== 'object') continue;
      dialogs.set(phone, {
        phone,
        stage: dialog.stage || 'conexao',
        name: dialog.name || null,
        history: Array.isArray(dialog.history) ? dialog.history : [],
        summary: dialog.summary || null,
        questionIntents: Array.isArray(dialog.questionIntents) ? dialog.questionIntents : [],
        commercialContext: dialog.commercialContext && typeof dialog.commercialContext === 'object'
          ? {
              ..._defaultCommercialContext(),
              ...dialog.commercialContext,
              facts: {
                ..._defaultCommercialContext().facts,
                ...((dialog.commercialContext && dialog.commercialContext.facts) || {}),
              },
              signals: Array.isArray(dialog.commercialContext.signals) ? dialog.commercialContext.signals : [],
              opportunities: Array.isArray(dialog.commercialContext.opportunities) ? dialog.commercialContext.opportunities : [],
              answersByIntent: {
                ..._defaultCommercialContext().answersByIntent,
                ...((dialog.commercialContext && dialog.commercialContext.answersByIntent) || {}),
              },
            }
          : _defaultCommercialContext(),
        createdAt: dialog.createdAt ? new Date(dialog.createdAt) : new Date(),
        lastUpdatedAt: dialog.lastUpdatedAt ? new Date(dialog.lastUpdatedAt) : new Date(),
        score: Number(dialog.score || 0),
      });
    }
  } catch (err) {
    console.error('[Dialog] Falha ao carregar estado persistido:', err.message);
  }
}

function _saveStore() {
  try {
    const payload = {};
    for (const [phone, dialog] of dialogs.entries()) {
      payload[phone] = {
        phone: dialog.phone,
        stage: dialog.stage,
        name: dialog.name,
        history: dialog.history,
        summary: dialog.summary,
        questionIntents: Array.isArray(dialog.questionIntents) ? dialog.questionIntents : [],
        commercialContext: dialog.commercialContext || _defaultCommercialContext(),
        createdAt: dialog.createdAt instanceof Date ? dialog.createdAt.toISOString() : dialog.createdAt,
        lastUpdatedAt: dialog.lastUpdatedAt instanceof Date ? dialog.lastUpdatedAt.toISOString() : dialog.lastUpdatedAt,
        score: dialog.score,
      };
    }

    fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[Dialog] Falha ao salvar estado persistido:', err.message);
  }
}

_loadStore();

function _getDialog(phone) {
  if (!dialogs.has(phone)) {
    dialogs.set(phone, {
      phone,
      stage: 'conexao',
      name: null,
      history: [],
      summary: null,
      questionIntents: [],
      commercialContext: _defaultCommercialContext(),
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      score: 0, // lead score para qualificação
    });
  }
  return dialogs.get(phone);
}

function getState(phone) {
  const d = _getDialog(phone);
  return {
    stage: d.stage,
    name: d.name,
    score: d.score,
    summary: d.summary || null,
    questionIntents: Array.isArray(d.questionIntents) ? d.questionIntents.slice() : [],
    commercialContext: d.commercialContext || _defaultCommercialContext(),
    lastUpdatedAt: d.lastUpdatedAt,
  };
}

function addMessage(phone, from, text, metadata = {}) {
  const dialog = _getDialog(phone);
  dialog.history.push({
    from, // 'user' | 'bot'
    text,
    timestamp: new Date(),
    ...metadata,
  });
  dialog.lastUpdatedAt = new Date();
  _saveStore();
}

function getHistory(phone, limit = 10) {
  const dialog = _getDialog(phone);
  return dialog.history.slice(-limit);
}

function getFullHistory(phone) {
  const dialog = _getDialog(phone);
  return dialog.history;
}

function updateStage(phone, newStage) {
  const dialog = _getDialog(phone);
  const prev = dialog.stage;
  dialog.stage = newStage;
  dialog.lastUpdatedAt = new Date();
  console.log(`[Dialog] ${phone}: stage ${prev} -> ${newStage}`);
  _saveStore();
}

function setName(phone, name) {
  const dialog = _getDialog(phone);
  if (!dialog.name && name && name.trim()) {
    dialog.name = name.trim();
    console.log(`[Dialog] ${phone}: name set to ${name}`);
    _saveStore();
  }
}

function setSummary(phone, summary) {
  const dialog = _getDialog(phone);
  dialog.summary = summary;
  dialog.lastUpdatedAt = new Date();
  _saveStore();
}

function getCommercialContext(phone) {
  const dialog = _getDialog(phone);
  return dialog.commercialContext || _defaultCommercialContext();
}

function updateCommercialContext(phone, partial = {}) {
  const dialog = _getDialog(phone);
  const current = dialog.commercialContext || _defaultCommercialContext();
  const next = {
    ..._defaultCommercialContext(),
    ...current,
  };

  if (partial.facts && typeof partial.facts === 'object') {
    next.facts = {
      ..._defaultCommercialContext().facts,
      ...current.facts,
      ...partial.facts,
    };
  }

  if (partial.answersByIntent && typeof partial.answersByIntent === 'object') {
    next.answersByIntent = {
      ...current.answersByIntent,
      ...partial.answersByIntent,
    };
  }

  const mergeList = (currentList, incomingList) => {
    const out = Array.isArray(currentList) ? currentList.slice() : [];
    for (const item of Array.isArray(incomingList) ? incomingList : []) {
      if (!item) continue;
      if (!out.includes(item)) {
        out.push(item);
      }
    }
    return out.slice(-12);
  };

  next.signals = mergeList(current.signals, partial.signals);
  next.opportunities = mergeList(current.opportunities, partial.opportunities);
  next.lastUpdatedAt = new Date().toISOString();

  dialog.commercialContext = next;
  dialog.lastUpdatedAt = new Date();
  _saveStore();
}

function getSummary(phone) {
  const dialog = _getDialog(phone);
  return dialog.summary || null;
}

function updateScore(phone, delta) {
  const dialog = _getDialog(phone);
  dialog.score += delta;
  console.log(`[Dialog] ${phone}: score += ${delta} (total: ${dialog.score})`);
  _saveStore();
}

function getQuestionIntents(phone) {
  const dialog = _getDialog(phone);
  return Array.isArray(dialog.questionIntents) ? dialog.questionIntents.slice() : [];
}

function addQuestionIntents(phone, intents = []) {
  const dialog = _getDialog(phone);
  const incoming = Array.isArray(intents) ? intents.filter(Boolean) : [];
  if (incoming.length === 0) return;

  const current = Array.isArray(dialog.questionIntents) ? dialog.questionIntents.slice() : [];
  for (const intent of incoming) {
    if (!current.includes(intent)) {
      current.push(intent);
    }
  }

  dialog.questionIntents = current.slice(-8);
  dialog.lastUpdatedAt = new Date();
  _saveStore();
}

function reset(phone) {
  dialogs.delete(phone);
  console.log(`[Dialog] ${phone}: reset`);
  _saveStore();
}

module.exports = {
  getState,
  addMessage,
  getHistory,
  getFullHistory,
  updateStage,
  setName,
  setSummary,
  getSummary,
  getCommercialContext,
  updateCommercialContext,
  updateScore,
  getQuestionIntents,
  addQuestionIntents,
  reset,
  // Debug
  getAllDialogs: () => dialogs,
};
