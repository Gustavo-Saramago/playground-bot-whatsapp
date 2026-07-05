'use strict';

const fs = require('fs');
const path = require('path');

// Carrega o system prompt robusto do arquivo
const SYSTEM_BASE = fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'system_prompt.md'), 'utf8');

function buildSystem() {
  return SYSTEM_BASE;
}

function formatCommercialContext(commercialContext = {}) {
  const facts = commercialContext.facts || {};
  const answersByIntent = commercialContext.answersByIntent || {};
  const signals = Array.isArray(commercialContext.signals) ? commercialContext.signals : [];
  const opportunities = Array.isArray(commercialContext.opportunities) ? commercialContext.opportunities : [];

  const parts = [];
  const factEntries = [
    ['businessType', 'Tipo de negócio'],
    ['situation', 'Situação'],
    ['goal', 'Objetivo'],
    ['spaceType', 'Tipo de espaço'],
    ['budgetSignal', 'Sinal de orçamento'],
  ];

  for (const [key, label] of factEntries) {
    if (facts[key]) {
      parts.push(`${label}: ${facts[key]}`);
    }
  }

  const answerEntries = Object.entries(answersByIntent)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);

  if (answerEntries.length > 0) {
    parts.push(`Respostas já dadas: ${answerEntries.join(' | ')}`);
  }

  if (signals.length > 0) {
    parts.push(`Sinais comerciais: ${signals.join(' | ')}`);
  }

  if (opportunities.length > 0) {
    parts.push(`Oportunidades: ${opportunities.join(' | ')}`);
  }

  return parts.join('\n');
}

function buildUserPrompt({phone, name, message, quotedMessage, kb_snippets, history, stage, summary, commercialContext}) {
  const header = [];
  header.push(`Phone: ${phone}`);
  if (name) header.push(`Client Name: ${name}`);
  header.push(`Current Stage: ${stage || 'unknown'}`);
  header.push(`Known Customer Name: ${name ? 'yes' : 'no'}`);
  if ((!history || history.length === 0) && (!summary) && String(stage || '').toLowerCase() === 'conexao') {
    header.push('Lead Origin: first paid-traffic contact; greet, ask the person name, and explore commercial need; do not ask technical qualification on the first reply');
  }
  if (summary) header.push(`Session Summary: ${summary}`);
  const commercialContextText = formatCommercialContext(commercialContext);
  if (commercialContextText) header.push(`Commercial Context:\n${commercialContextText}`);
  if (quotedMessage) header.push(`Quoted Message: ${quotedMessage}`);

  const kbText = (kb_snippets || [])
    .map((s, i) => `[KB${i+1}] ${s.title}\n${s.text}`)
    .join('\n\n');

  const historyText = (history || [])
    .slice(-10)
    .map(h => `- ${h}`)
    .join('\n');

  return `${header.join('\n')}

Knowledge Base:\n${kbText}

Recent History:\n${historyText || '(no history yet)'}

New Message: ${message}`;
}

module.exports = { buildSystem, buildUserPrompt };
