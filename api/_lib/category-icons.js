// v5: ícone ilustrado de cada categoria (coluna categories.icon).
// Cada chave tem o arquivo public/images/icones/<chave>.svg e uma animação leve na loja (classe anim-<tipo> no styles.css).
// Só chaves desta lista entram no banco; '' ou null = categoria sem ícone.
const CATEGORY_ICONS = [
  { key: 'brigadeiro', label: 'Brigadeiro', anim: 'pula' },
  { key: 'copo', label: 'Copo', anim: 'pula' },
  { key: 'pote', label: 'Pote', anim: 'balanca' },
  { key: 'geladinho', label: 'Geladinho', anim: 'balanca' },
  { key: 'acai', label: 'Açaí', anim: 'flutua' },
  { key: 'bolo', label: 'Bolo', anim: 'flutua' },
  { key: 'cupcake', label: 'Cupcake', anim: 'pula' },
  { key: 'sorvete', label: 'Sorvete', anim: 'balanca' },
  { key: 'morango', label: 'Morango', anim: 'balanca' },
  { key: 'chocolate', label: 'Chocolate', anim: 'balanca' },
  { key: 'presente', label: 'Presente', anim: 'pula' },
  { key: 'coracao', label: 'Coração', anim: 'pulsa' },
  { key: 'estrela', label: 'Estrela', anim: 'gira' }
];
const BY_KEY = new Map(CATEGORY_ICONS.map(i => [i.key, i]));

const isIconKey = v => typeof v === 'string' && BY_KEY.has(v);

// Valor salvo no banco: chave válida ou null (vazio limpa o ícone). Lança com a mensagem para o painel.
function parseIcon(v) {
  if (v === null || v === undefined || v === '') return null;
  if (!isIconKey(v)) throw new Error('Ícone inválido.');
  return v;
}

// Bloco público usado pela loja e pelo painel: { key, src, anim } ou null.
function iconInfo(key) {
  const i = isIconKey(key) ? BY_KEY.get(key) : null;
  return i ? { key: i.key, src: `/images/icones/${i.key}.svg`, anim: i.anim } : null;
}

// Sugestão pelo nome da categoria (usada só na migração, para quem ainda não tem ícone).
function suggestIcon(name) {
  const n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/familia/.test(n)) return 'brigadeiro';
  if (/acai/.test(n)) return 'acai';
  if (/geladinho|gelinho|sacole/.test(n)) return 'geladinho';
  if (/copo|copao/.test(n)) return 'copo';
  if (/pote/.test(n)) return 'pote';
  if (/bolo|torta/.test(n)) return 'bolo';
  if (/cupcake/.test(n)) return 'cupcake';
  if (/sorvete/.test(n)) return 'sorvete';
  if (/presente|kit|cesta/.test(n)) return 'presente';
  if (/brigadeiro|doce/.test(n)) return 'brigadeiro';
  return null;
}

module.exports = { CATEGORY_ICONS, isIconKey, parseIcon, iconInfo, suggestIcon };
