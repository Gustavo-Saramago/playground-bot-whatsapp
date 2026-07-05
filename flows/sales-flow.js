'use strict';

const canonicalKnowledge = require('../knowledge/canonical-base.json');

function _normalize(text) {
  return (text || '').toLowerCase();
}

function _isPositive(text) {
  const t = _normalize(text);
  return /sim|quero|vamos|interess|gost|compre|fechar|ok|claro|vamos ver|me interessa|aceito|bom/i.test(t);
}

function _isObjection(text) {
  const t = _normalize(text);
  return /caro|preço|valor|pagamento|parcel|depois|agora não|vou pensar|não sei|não tenho|difícil|cust|mais barato|demora/i.test(t);
}

function buildReply(text, context = {}) {
  const lower = _normalize(text);
  const stage = context.stage || 'conexao';

  if (!text || !text.trim()) {
    return [
      'Olá! Tudo bem? Eu sou o atendente do playground e posso te ajudar a encontrar uma solução interessante para o seu espaço.',
      'Para eu te responder com mais precisão, me conta em poucas palavras o que você está procurando.'
    ];
  }

  if (stage === 'conexao') {
    if (lower.includes('preço') || lower.includes('valor') || lower.includes('quanto')) {
      return [
        'Entendo, preço é sempre uma parte importante da decisão.',
        'O que costuma pesar mais não é só o valor, mas se o brinquedo realmente entrega resultado para o espaço e para as pessoas que vão usar.'
      ];
    }

    if (lower.includes('foto') || lower.includes('vídeo') || lower.includes('video')) {
      return [
        'Claro, visualizar ajuda muito na decisão.',
        'Posso te mostrar as opções de forma mais prática, e também te ajudar a escolher o que faz mais sentido para o seu caso.'
      ];
    }

    if (lower.includes('pagamento') || lower.includes('parcel') || lower.includes('financ')) {
      return [
        'As condições de pagamento podem ser avaliadas conforme o item, a situação e a urgência da compra.',
        'Se fizer sentido, eu posso te ajudar a encontrar uma opção mais confortável para você.'
      ];
    }

    if (_isPositive(lower)) {
      return [
        'Que bom, isso é um ótimo sinal.',
        'Para eu te orientar melhor, me diz qual tipo de espaço você tem e para quem esse brinquedo seria ideal.'
      ];
    }

    if (_isObjection(lower)) {
      return [
        'Entendo, e isso é totalmente normal na decisão.',
        'O ideal é encontrar algo que faça sentido para o seu caso e que não gere dúvida depois.',
        'Me conta um pouco mais sobre o que você espera e eu te ajudo a avaliar a melhor opção.'
      ];
    }

    return [
      'Entendo. O ponto principal é descobrir se isso faz sentido para o seu espaço e para a sua necessidade.',
      'Me fala um pouco sobre onde você quer usar, para qual público e qual tipo de impacto você espera ter.'
    ];
  }

  if (stage === 'diagnostico') {
    if (lower.includes('criança') || lower.includes('infantil') || lower.includes('kids') || lower.includes('evento')) {
      return [
        'Perfeito, isso ajuda bastante a direcionar a escolha.',
        'Quando o brinquedo chama atenção de forma rápida, ele tende a transformar o ambiente e gerar mais valor percebido.'
      ];
    }

    return [
      'Entendo. O ideal é escolher algo que realmente agregue valor ao espaço e gere impacto na primeira impressão.',
      'Se quiser, eu posso te mostrar as opções mais alinhadas com o seu cenário.'
    ];
  }

  if (stage === 'apresentacao') {
    return [
      'O que costuma funcionar melhor é mostrar o brinquedo como uma solução para atrair atenção, criar experiência e dar mais valor ao ambiente.',
      'Eu posso te apresentar as opções mais adequadas e mostrar o que faz mais sentido para o seu caso.'
    ];
  }

  if (stage === 'validação') {
    return [
      'Pelo que você falou, parece que há um bom potencial aqui.',
      'Se fizer sentido para você, eu posso te ajudar a escolher a melhor opção e te passar tudo de forma mais clara.'
    ];
  }

  if (stage === 'objecoes') {
    if (_isObjection(lower)) {
      return [
        'Entendo sua preocupação.',
        'Na prática, o mais importante é escolher algo que realmente resolva a necessidade e tenha um bom retorno para o uso pretendido.',
        'Se você quiser, eu posso te mostrar o que faz mais sentido para o seu orçamento e para o seu objetivo.'
      ];
    }
    return [
      'Tudo bem, a decisão precisa fazer sentido para você.',
      'Se quiser, eu posso te ajudar a comparar as opções de forma mais objetiva e simples.'
    ];
  }

  if (stage === 'negociacao') {
    return [
      'Para deixar a decisão mais confortável, o ideal é olhar o que entrega mais valor para o seu cenário.',
      'Eu posso te ajudar a encontrar a melhor combinação entre preço, uso e praticidade.'
    ];
  }

  if (stage === 'fechamento') {
    return [
      'Se você gostar da proposta, o próximo passo é definir qual opção faz mais sentido para você e fechar a escolha com segurança.',
      'Posso te ajudar a organizar isso de forma simples e direta.'
    ];
  }

  return [
    'Entendo. Vou te conduzir de forma clara e objetiva para encontrar a melhor solução para o seu caso.',
    'Me diga qual é a necessidade principal e eu te ajudo a avaliar as opções.'
  ];
}

module.exports = { buildReply, knowledge: canonicalKnowledge, salesPlaybook: canonicalKnowledge };
