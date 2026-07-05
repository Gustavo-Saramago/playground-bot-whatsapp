const { buildReply, knowledge } = require('./flows/sales-flow');
const engine = require('./engine/engine');

console.log('Base carregada:', knowledge.empresa);
console.log('---\n');

(async () => {
  const phone = '5511987654321';
  engine.dialog.reset(phone);
  
  // Simula uma conversa com 3 trocas de mensagens
  const messages = [
    'Olá, vendi uns brinquedos de um playground antigo e gostaria de saber como funciona a venda',
    'Preciso de algo atrativo para deixar a área de lazer da minha loja mais interessante',
    'Qual é o valor do escorregador e como vocês entregam?'
  ];

  for (let i = 0; i < messages.length; i++) {
    console.log(`\n[Troca ${i + 1}]`);
    console.log(`Lead: "${messages[i]}"`);
    
    const res = await engine.generateResponse({
      phone,
      name: null,
      message: messages[i],
      history: engine.getDialogHistory(phone, 5),
    });

    console.log(`Stage: ${res.stage} | Score: ${res.dialog_state.score}`);
    console.log(`Mensagens:`);
    for (const m of res.messages) console.log(`  - ${m}`);
    console.log(`KB encontrada: ${res.kb_snippets.map(s => s.title).join(', ')}`);
  }

  console.log('\n--- Estado final do lead ---');
  const finalState = engine.getDialogState(phone);
  console.log(`Nome: ${finalState.name || '(não informado)'}`);
  console.log(`Estágio: ${finalState.stage}`);
  console.log(`Score: ${finalState.score}`);
  console.log(`Histórico completo:`);
  const fullHist = engine.dialog.getFullHistory(phone);
  for (const h of fullHist) {
    console.log(`  ${h.from.toUpperCase()}: ${h.text.slice(0, 60)}${h.text.length > 60 ? '...' : ''}`);
  }
})();
