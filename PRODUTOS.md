# 🎪 Catálogo de Produtos

## Como adicionar novos produtos

### 1. Editar `knowledge/catalog.json`

Adicione um novo objeto no array `"produtos"`:

```json
{
  "id": "id_unico_do_produto",
  "nome": "Nome do Produto",
  "descricao": "Descrição detalhada...",
  "material": "Materiais utilizados",
  "dimensoes": "Dimensões",
  "faixa_etaria": "Idade recomendada",
  "preco": "R$ X.XXX,00",
  "opcoes_pagamento": [
    "À vista",
    "Parcelado em até Nx"
  ],
  "entrega": {
    "prazo": "Prazo em dias",
    "frete": "Valor ou Consultar",
    "instalacao": "Sim/Não ou valor",
    "regiao": "Região de atendimento"
  },
  "destaque": "Pontos principais de venda",
  "midia": {
    "fotos": [
      "https://exemplo.com/foto1.jpg",
      "https://exemplo.com/foto2.jpg"
    ],
    "videos": [
      "https://youtube.com/video1",
      "https://youtube.com/video2"
    ]
  }
}
```

### 2. Adicionar fotos/vídeos

Use URLs externas (Google Drive, OneDrive, YouTube, etc):

```json
"midia": {
  "fotos": [
    "https://drive.google.com/uc?id=1ABC123...",
    "https://drive.google.com/uc?id=1DEF456..."
  ],
  "videos": [
    "https://youtu.be/xyz123"
  ]
}
```

---

## 📋 Produtos Cadastrados

### 1. ✅ Brinquedão Gigante + Cama Elástica Profissional
- **Preço:** R$ 40.000,00 (à vista)
- **Dimensões:** 7,4m × 6,35m × 4,4m
- **Idade:** 3 a 12 anos
- **Status:** Pronto
- **Fotos/Vídeos:** Aguardando links

---

### 2. ⏳ [Próximo produto]
*Aguardando detalhes...*

---

## 📸 Como obter URLs de fotos (Google Drive)

1. Faça upload da foto no Google Drive
2. Compartilhe a foto (qualquer um com o link pode ver)
3. Clique com botão direito → "Obter ID"
4. Use a URL: `https://drive.google.com/uc?id=SEU_ID_AQUI`

---

## 🎥 Como obter URLs de vídeos (YouTube)

1. Upload do vídeo no YouTube
2. Compartilhe (público)
3. Copie o link: `https://youtu.be/ID_DO_VIDEO`

---

**Dica:** Para validar que o catálogo está correto, rode:
```bash
npm test
```

Se o JSON estiver inválido, o teste vai falhar com erro de parse.
