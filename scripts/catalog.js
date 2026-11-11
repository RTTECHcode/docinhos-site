const products = [
// [nome, imagem, categoria, preço em centavos, descrição]
['Monte seu copo','Copão da Felicidade - Monte do Seu Jeito.avif','Copos da felicidade',1800,'Monte do seu jeito: escolha o tamanho, até 2 brigadeiros, 2 frutas, 2 recheios e 2 toppings.'],
['Copo da Felicidade - Brownie, Brigadeiro, Ninho e Kinder','Copo da Felicidade - Brownie, Brigadeiro, Ninho e Kinder.avif','Copos da felicidade',2000,'Delicioso Copo da Felicidade com Kinder Bueno: camadas de brigadeiro de ninho, kinder, chocolate e muito amor.'],
['Copo da Felicidade - Brownie com Ninho e Brigadeiro','Copo da Felicidade - Brownie com Ninho e Brigadeiro.avif','Copos da felicidade',1800,'Delicioso Copo da Felicidade: brownie macio, ninho cremoso e brigadeiro irresistível em uma só embalagem.'],
['Copo da Felicidade - Brownie, Brigadeiro e Maracujá','Copo da Felicidade - Brownie, Brigadeiro e Maracujá.avif','Copos da felicidade',1800,'Delicie-se com nosso Copo da Felicidade: Brownie macio, Brigadeiro cremoso e Brigadeiro de maracujá.'],
['Copo da Felicidade de Oreo - Brownie, Ninho e Oreo','Copo da Felicidade de Oreo - Brownie, Ninho e Oreo.avif','Copos da felicidade',1800,'Delicioso copo com camadas de brownie, creme de Oreo e creme de Ninho, finalizado com pedaços crocantes.'],
['Delícia de Nutella - Copo da Felicidade Ninho com Nutella','Delícia de Nutella - Copo da Felicidade Ninho com Nutella.avif','Copos da felicidade',2200,''],
['Fatia de Brownie - Ninho com Nutella','Fatia de Brownie - Ninho com Nutella.avif','Doces no pote',2000,'Uma fatia de brownie fresquinho, coberto com uma camada de ninho e finalizada com nutella.'],
['Brigadeiros - Bicho de Pé, Ninho e Chocolate','Brigadeiros - Bicho de Pé, Ninho e Chocolate.avif','Doces no pote',1299,''],
['Brigadeiros - Brigadeiro Tradicional, Ninho e Confete','Brigadeiros - Brigadeiro Tradicional, Ninho e Confete.avif','Doces no pote',1299,''],
['Brigadeiros - Brigadeiro tradicional e Confete','Brigadeiros - Brigadeiro tradicional e Confete.avif','Doces no pote',1299,''],
['Brigadeiros - Brigadeiro tradicional e Ninho','Brigadeiros - Brigadeiro tradicional e Ninho.avif','Doces no pote',1299,''],
['Surpresa Mix! Uva e morango','Surpresa Mix! Uva e morango.avif','Doces no pote',1300,'Delicioso mix de sabores com uva e morango frescos, cobertos com brigadeiro de ninho e chocolate.'],
['Surpresa de Morango - Bombom de morango','Surpresa de Morango - Bombom de morango.avif','Doces no pote',1300,'Delicioso doce feito com morangos frescos, brigadeiro de ninho e chocolate. Surpreenda-se com cada colherada.'],
['Surpresa de Uva - Bombom de Uva','Surpresa de Uva - Bombom de Uva.avif','Doces no pote',1300,'Deliciosa Surpresa de Uva: uma combinação irresistível de uvas frescas, brigadeiro de chocolate e muito mais.'],
['Geladinho Gourmet de Chocolate Branco - Laka','Geladinho Gourmet de Chocolate Branco - Laka.avif','Geladinhos Gourmet',600,'Refrescante e cremoso, nosso Geladinho Laka é feito com o delicioso sabor do chocolate branco.'],
['Geladinho Gourmet de Chocolate com Nutella','Geladinho Gourmet de Chocolate com Nutella.avif','Geladinhos Gourmet',600,'Delicioso geladinho de chocolate com Nutella, perfeito para quem deseja se refrescar com muito sabor.'],
['Geladinho Gourmet de Limão','Geladinho Gourmet de Limão.avif','Geladinhos Gourmet',600,'Refrescante geladinho de limão, perfeito para os dias quentes. Uma delícia cítrica e refrescante.'],
['Geladinho Gourmet de Limão com Nutella','Geladinho Gourmet de Limão com Nutella.avif','Geladinhos Gourmet',600,''],
['Geladinho Gourmet de Maracujá','Geladinho Gourmet de Maracujá.avif','Geladinhos Gourmet',600,'Refrescante geladinho de maracujá, perfeito para os dias quentes. Delicioso e doce na medida certa.'],
['Geladinho Gourmet de Maracujá com Nutella','Geladinho Gourmet de Maracujá com Nutella.avif','Geladinhos Gourmet',600,'Delicioso geladinho de maracujá com Nutella, perfeito para refrescar e adoçar seu dia de forma única.'],
['Geladinho Gourmet de Morango','Geladinho Gourmet de Morango.avif','Geladinhos Gourmet',600,'Refrescante geladinho de morango, perfeito para os dias quentes, feito com frutas frescas selecionadas.'],
['Geladinho Gourmet de Morango com Nutella','Geladinho Gourmet de Morango com Nutella.avif','Geladinhos Gourmet',600,'Geladinho saboroso e refrescante de morango com Nutella, perfeito para se deliciar em dias quentes.'],
['Geladinho Gourmet de Ninho com Morango','Geladinho Gourmet de Ninho com Morango.avif','Geladinhos Gourmet',600,'Geladinho de Ninho cremoso com geleia de pedacinhos de morango fresco, refrescante e saboroso.'],
['Geladinho Gourmet de Ninho com Nutella','Geladinho Gourmet de Ninho com Nutella.avif','Geladinhos Gourmet',600,'Delicioso Geladinho de Ninho cremoso com Nutella, perfeito para adoçar o seu dia com sabor irresistível.'],
['Geladinho Gourmet de Ninho com Oreo','Geladinho Gourmet de Ninho com Oreo.avif','Geladinhos Gourmet',600,'Refrescante geladinho com sabor cremoso do leite Ninho e pedacinhos crocantes de biscoito Oreo.'],
['Geladinho Gourmet de Ninho com Ovomaltine','Geladinho Gourmet de Ninho com Ovomaltine.avif','Geladinhos Gourmet',600,'Delicioso geladinho de Ninho cremoso com crocantes de Ovomaltine, perfeito para refrescar e adoçar.'],
['Geladinho Gourmet de Paçoca - Paçoquita','Geladinho Gourmet de Paçoca - Paçoquita.avif','Geladinhos Gourmet',600,'Delicioso geladinho de Paçoquita, perfeito para matar a sede e se refrescar com um sabor irresistível.'],
['Açaí 300ml - Monte Seu Copo','Açaí 300ml - Monte Seu Copo.avif','Açaí',1500,'Delicioso açaí 300ml, cremoso e refrescante. Monte o seu com até 3 complementos.'],
['Açaí 500ml - Monte seu copo','Açaí 500ml - Monte seu copo.avif','Açaí',2000,'Delicioso açaí cremoso, servido em copo de 500ml. Monte o seu com até 5 complementos.'],
['Açaí Trufado 300ml - Brigadeiro de Chocolate','Açaí Trufado - Brigadeiro de Chocolate.avif','Açaí',1800,''],
['Açaí Trufado 300ml - Brigadeiro de Ninho','Açaí Trufado - Brigadeiro de Ninho.avif','Açaí',1800,''],
['Surpresa de Morango - Na Travessa - Tamanho familia','Surpresa de Morango - Na Travessa - Tamanho familia.avif','Para família',6000,'Deliciosas camadas de brigadeiro de ninho, com pedaços de morango e finalizada com brigadeiro de chocolate.'],
['Surpresa de Uva - Na Travessa - Tamanho familia','Surpresa de Uva - Na Travessa - Tamanho familia.avif','Para família',5500,'Deliciosas camadas de brigadeiro de ninho, com pedaços de uva finalizadas com brigadeiro de chocolate.']
];

// Complementos: kind = size (escolha 1) | additional (adicionais)
const complements = [
  { name: 'Copo 250ml', price_cents: 0, kind: 'size' },
  { name: 'Copo 300ml', price_cents: 300, kind: 'size' },
  { name: 'Copo 500ml', price_cents: 1700, kind: 'size' },
  { name: 'Recheio de Brownie', price_cents: 0, kind: 'additional' },
  { name: 'Recheio de Pedaços de Oreo', price_cents: 100, kind: 'additional' },
  { name: 'Recheio de Kitkat', price_cents: 199, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Recheio de Bis', price_cents: 100, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Brigadeiro de Chocolate', price_cents: 0, kind: 'additional' },
  { name: 'Brigadeiro de Ninho', price_cents: 0, kind: 'additional' },
  { name: 'Brigadeiro de Kinder', price_cents: 199, kind: 'additional' },
  { name: 'Brigadeiro de Oreo', price_cents: 100, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Fruta - Banana', price_cents: 0, kind: 'additional' },
  { name: 'Fruta - Uva', price_cents: 0, kind: 'additional' },
  { name: 'Fruta - Morango', price_cents: 0, kind: 'additional' },
  { name: 'Topping - Pedaço de Brownie', price_cents: 0, kind: 'additional' },
  { name: 'Topping - Nutella', price_cents: 299, kind: 'additional' },
  { name: 'Topping - Creme de Ovomaltine', price_cents: 199, kind: 'additional' },
  { name: 'Topping - Biscoito Oreo', price_cents: 100, kind: 'additional' },
  { name: 'Topping - Ferrero Rocher', price_cents: 299, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Topping - Tubes de Morango', price_cents: 100, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Topping - Tubes de Avelã', price_cents: 100, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Topping - Kinder Bueno', price_cents: 299, kind: 'additional' }, // CONFIRMAR PREÇO
  { name: 'Banana', price_cents: 100, kind: 'additional' },
  { name: 'Confetes (tipo M&M)', price_cents: 100, kind: 'additional' },
  { name: 'Creme de Ovomaltine', price_cents: 250, kind: 'additional' },
  { name: 'Granola', price_cents: 100, kind: 'additional' },
  { name: 'Leite Condensado', price_cents: 100, kind: 'additional' },
  { name: 'Leite em Pó', price_cents: 100, kind: 'additional' },
  { name: 'Nutella', price_cents: 250, kind: 'additional' },
  { name: 'Ovomaltine em pó', price_cents: 100, kind: 'additional' },
  { name: 'Paçoca', price_cents: 100, kind: 'additional' },
  { name: 'Uva', price_cents: 100, kind: 'additional' }
];

// Renomeações em place (preservam o id do produto). O seed só aplica se o nome antigo existe e o novo não.
const renames = [
  ['Copão da Felicidade', 'Monte seu copo'],
  ['Açaí Trufado - Brigadeiro de Chocolate', 'Açaí Trufado 300ml - Brigadeiro de Chocolate'],
  ['Açaí Trufado - Brigadeiro de Ninho', 'Açaí Trufado 300ml - Brigadeiro de Ninho']
];

// Produtos que recebem complementos
const copoSizes = ['Copo 250ml', 'Copo 300ml', 'Copo 500ml'];
// Grupos de escolha do "Monte seu copo" (ordem = sort_order): cada um com mín 0 e máx 2, opções com max_quantity 1.
const copoGroups = [
  { key: 'brigadeiro', label: 'Escolha o brigadeiro', options: ['Brigadeiro de Chocolate', 'Brigadeiro de Ninho', 'Brigadeiro de Kinder', 'Brigadeiro de Oreo'] },
  { key: 'fruta', label: 'Escolha sua fruta', options: ['Fruta - Banana', 'Fruta - Uva', 'Fruta - Morango'] },
  { key: 'recheio', label: 'Escolha o recheio', options: ['Recheio de Brownie', 'Recheio de Pedaços de Oreo', 'Recheio de Kitkat', 'Recheio de Bis'] },
  { key: 'topping', label: 'Escolha o topping', options: ['Topping - Pedaço de Brownie', 'Topping - Nutella', 'Topping - Creme de Ovomaltine', 'Topping - Biscoito Oreo', 'Topping - Ferrero Rocher', 'Topping - Tubes de Morango', 'Topping - Tubes de Avelã', 'Topping - Kinder Bueno'] }
];
const acaiExtras = ['Banana','Confetes (tipo M&M)','Creme de Ovomaltine','Granola','Leite Condensado','Leite em Pó','Nutella','Ovomaltine em pó','Paçoca','Uva'];

// [produto, chave, rótulo, mín, máx, ordem]
const productGroups = [];
// [produto, complemento, max_quantity, chave do grupo | null]
const productComplements = [];
for (const [name] of products.filter(p => p[2] === 'Copos da felicidade' && /Monte/.test(p[0]))) {
  for (const c of copoSizes) productComplements.push([name, c, 1, null]);
  copoGroups.forEach((g, idx) => {
    productGroups.push([name, g.key, g.label, 0, 2, idx]);
    for (const o of g.options) productComplements.push([name, o, 1, g.key]);
  });
}
for (const [name] of products.filter(p => p[2] === 'Açaí' && /Monte/.test(p[0]))) {
  productGroups.push([name, 'complementos', 'Escolha seus complementos', 0, /300ml/.test(name) ? 3 : 5, 0]);
  for (const c of acaiExtras) productComplements.push([name, c, 1, 'complementos']);
}

module.exports = { products, complements, productComplements, productGroups, renames };
