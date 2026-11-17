'use strict';
// U-06 (v4): gera um par de chaves VAPID para o Web Push do painel. Só imprime na tela: não grava nada em arquivo.
// Uso (Renan): node scripts/gerar-vapid.js
// Depois, na Vercel (Settings > Environment Variables, ambiente Production), crie:
//   VAPID_PUBLIC_KEY  = a chave pública abaixo
//   VAPID_PRIVATE_KEY = a chave privada abaixo (segredo: não mande por WhatsApp nem coloque no código)
//   VAPID_SUBJECT     = mailto:seu-email@exemplo.com (um e-mail de contato real)
// Trocar as chaves depois desativa os avisos em todos os aparelhos (cada um precisa ativar de novo no painel).
const crypto = require('node:crypto');

function generate() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  let priv = ecdh.getPrivateKey();
  if (priv.length < 32) priv = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: priv.toString('base64url') };
}

if (require.main === module) {
  const k = generate();
  console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
  console.log('VAPID_SUBJECT=mailto:troque-pelo-seu-email@exemplo.com');
  console.log('\nCopie as três linhas para a Vercel (Production). A chave privada é segredo.');
}

module.exports = { generate };
