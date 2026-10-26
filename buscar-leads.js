const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const CIDADES = ['Petrópolis', 'Três Rios', 'Paraíba do Sul', 'Areal'];
const BUSCAS = [
  { termo: 'ar condicionado instalacao manutencao', categoria: 'Ar Condicionado' },
  { termo: 'oficina mecanica auto center', categoria: 'Oficina Mecânica' },
  { termo: 'dentista consultorio odontologico', categoria: 'Dentista' },
  { termo: 'pet shop banho e tosa', categoria: 'Pet Shop' },
  { termo: 'energia solar instalacao', categoria: 'Energia Solar' },
  { termo: 'academia musculacao', categoria: 'Academia' },
];
const META = Number(process.env.META) || 300; // leads novos por execução, somados aos que já estão no leads.json
const SALVAR_A_CADA = 15;
const MODO_AVALIACOES = process.argv.includes('--avaliacoes');
const MAX_ROLAGENS = 45;
const ARQUIVO = path.join(__dirname, 'leads.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// "Sites" que não são site próprio: redes sociais, agregadores de link, WhatsApp etc.
const HOSTS_GENERICOS = [
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'wa.me', 'whatsapp.com', 'linktr.ee', 'linktree.com',
  'bit.ly', 'tinyurl.com', 'youtube.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com',
  'ifood.com.br', 'google.com', 'goo.gl', 'business.site', 'negocio.site', 'beacons.ai', 'taplink.cc',
  'olx.com.br', 'mercadolivre.com.br', 'doctoralia.com.br', 'booksy.com', 'canva.site',
];

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function hostGenerico(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return HOSTS_GENERICOS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return true;
  }
}

// O Maps às vezes embrulha o link em /url?q=<destino>
function limparUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('google.') && u.pathname === '/url') return u.searchParams.get('q') || '';
    return url;
  } catch {
    return '';
  }
}

function ehInstagram(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am';
  } catch {
    return false;
  }
}

function telefoneValido(tel) {
  const d = (tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  return d.length === 10 || d.length === 11 ? d : null;
}

function cidadeDoEndereco(endereco) {
  const e = semAcento(endereco);
  return CIDADES.find((c) => e.includes(semAcento(c))) || null;
}

const novos = []; // leads sem site próprio aceitos nesta execução
const vistos = new Set(); // telefones e nomes já aceitos (inclui os do leads.json)
const locaisVisitados = new Set();
const idDoLocal = (url) => ((url || '').match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/) || [])[1] || url;

// Leads de execuções anteriores: são mantidos e servem para não repetir telefone/nome
const existentes = fs.existsSync(ARQUIVO) ? JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) : [];
for (const lead of existentes) {
  if (lead.phoneUnformatted) vistos.add(lead.phoneUnformatted);
  if (lead.title) vistos.add(semAcento(lead.title));
  if (lead.mapsUrl) locaisVisitados.add(idDoLocal(lead.mapsUrl));
}

function salvar() {
  fs.writeFileSync(ARQUIVO, JSON.stringify([...existentes, ...novos], null, 2));
}

// Pausa aleatória de 1 a 2 s entre consultas, para não disparar bloqueio/CAPTCHA
const pausa = () => dormir(1000 + Math.random() * 1000);

async function novaPagina(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'pt-BR,pt;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const tipo = req.resourceType();
    const url = req.url();
    const bloquear =
      ['image', 'font', 'media', 'ping'].includes(tipo) ||
      // O CSS do próprio Maps tem de carregar: sem ele o painel deixa de rolar e a lista para nos 40 resultados
      (tipo === 'stylesheet' && !/google\.com\/maps|gstatic\.com\/maps|\/maps\/_\//.test(url) && process.env.BLOQUEAR_CSS === '1') ||
      /\/maps\/vt|\/kh\?|googleusercontent\.com|gstatic\.com\/.*\.(png|jpg|svg|woff2?)|doubleclick|google-analytics|\/log204|\/gen_204/.test(url);
    if (bloquear) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  return page;
}

async function aceitarConsentimento(page) {
  if (!page.url().includes('consent.google')) return;
  const botao = await page.$('button[aria-label*="Aceitar"], button[aria-label*="Accept"], form[action*="save"] button');
  if (botao) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), botao.click()]);
  }
}

// Pesquisa nicho+cidade, rola o painel e devolve os cartões encontrados
async function listarResultados(page, nicho, cidade) {
  const termo = `${nicho} em ${cidade} RJ`;
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(termo)}?hl=pt-BR`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await aceitarConsentimento(page);
  await page.waitForSelector('div[role="feed"], h1.DUwDvf', { timeout: 20000 }).catch(() => {});

  if (!(await page.$('div[role="feed"]'))) {
    // Resultado único: o Maps abre direto a ficha do local
    return (await page.$('h1.DUwDvf')) ? [{ href: page.url(), nome: '', site: '' }] : [];
  }

  let anterior = 0;
  let parado = 0;
  for (let i = 0; i < MAX_ROLAGENS && parado < 4; i++) {
    const { total, fim } = await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      const cartoes = feed.querySelectorAll('a.hfpxzc');
      feed.scrollTop = feed.scrollHeight;
      if (cartoes.length) cartoes[cartoes.length - 1].scrollIntoView();
      return { total: cartoes.length, fim: /final da lista|end of the list/i.test(feed.innerText) };
    });
    if (fim) break;
    parado = total === anterior ? parado + 1 : 0;
    anterior = total;
    // Rolagem "real" com a roda do rato sobre o painel, para disparar o carregamento de mais resultados
    await page.mouse.move(250, 500);
    await page.mouse.wheel({ deltaY: 3000 });
    await dormir(1000);
  }

  return page.evaluate(() =>
    [...document.querySelectorAll('div[role="feed"] a.hfpxzc')].map((a) => {
      const cartao = a.closest('div.Nv2PK') || a.parentElement;
      const site = cartao.querySelector('a.lcr4fd, a[data-value="Website"], a[data-value="Site"]');
      return { href: a.href, nome: a.getAttribute('aria-label') || '', site: site ? site.href : '', texto: cartao.innerText || '' };
    })
  );
}

async function extrairLocal(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1.DUwDvf', { timeout: 15000 });
  await page
    .waitForSelector('[data-item-id^="phone:tel:"], [data-item-id="address"]', { timeout: 4000 })
    .catch(() => {});
  return page.evaluate(() => {
    const rotulo = (el) => (el ? (el.getAttribute('aria-label') || el.innerText || '').replace(/^[^:]+:\s*/, '').trim() : '');
    const tel = document.querySelector('[data-item-id^="phone:tel:"]');
    const site = document.querySelector('a[data-item-id="authority"]');
    // Nota e nº de avaliações, no bloco logo abaixo do nome (ex.: "4,8 (123)")
    const avaliacoes = () => {
      const bloco = document.querySelector('div.F7nice');
      if (!bloco) return { totalScore: null, reviewsCount: 0 };
      const texto = bloco.innerText || '';
      const rotulos = [...bloco.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' | ');
      const nota = texto.match(/\d[.,]\d/);
      const qtd = rotulos.match(/([\d.]+)\s*(avalia|review|coment)/i) || texto.match(/\(([\d.]+)\)/);
      return {
        totalScore: nota ? parseFloat(nota[0].replace(',', '.')) : null,
        reviewsCount: qtd ? parseInt(qtd[1].replace(/\./g, ''), 10) : 0,
      };
    };
    // Instagram listado noutro ponto da ficha (ex.: secção de perfis na web)
    const instagram = document.querySelector('div[role="main"] a[href*="instagram.com"]');
    const principal = document.querySelector('div[role="main"]')?.innerText || '';
    return {
      categoria: (document.querySelector('button.DkEaL')?.innerText || '').trim(),
      fechado: /fechado (temporariamente|permanentemente)|(temporarily|permanently) closed/i.test(principal),
      // Cardápio e botões de pedido/reserva: também podem apontar para um site ou sistema próprio
      outrosLinks: [...document.querySelectorAll('a[data-item-id="menu"], a[data-item-id^="action:"]')].map((a) => a.href),
      nome: (document.querySelector('h1.DUwDvf')?.innerText || '').trim(),
      telefone: tel ? rotulo(tel) || tel.getAttribute('data-item-id').replace('phone:tel:', '') : '',
      endereco: rotulo(document.querySelector('[data-item-id="address"]')),
      siteUrl: site ? site.href : '',
      instagramUrl: instagram ? instagram.href : '',
      mapsUrl: location.href,
      ...avaliacoes(),
    };
  });
}

// Esquema final gravado no leads.json
function montarLead({ nome, nicho, cidade, telefone, digitos, endereco, mapsUrl, siteUrl, instagramUrl, temSite, totalScore, reviewsCount }) {
  return {
    title: nome,
    subTitle: null,
    description: null,
    ownerDescription: null,
    price: null,
    categoryName: nicho,
    address: endereco,
    neighborhood: null,
    street: null,
    city: cidade,
    postalCode: null,
    state: 'Rio de Janeiro',
    countryCode: 'BR',
    phone: telefone,
    phoneUnformatted: digitos,
    claimThisBusiness: true,
    location: { lat: null, lng: null },
    locatedIn: null,
    floor: null,
    plusCode: null,
    menu: null,
    servicesLink: null,
    totalScore: totalScore ?? null,
    permanentlyClosed: false,
    temporarilyClosed: false,
    placeId: null,
    categories: [nicho],
    fid: null,
    cid: null,
    reviewsCount: reviewsCount ?? 0,
    reviewsDistribution: { oneStar: 0, twoStar: 0, threeStar: 0, fourStar: 0, fiveStar: 0 },
    imagesCount: 0,
    imageCategories: [],
    scrapedAt: new Date().toISOString(),
    reserveTableUrl: null,
    googleFoodUrl: null,
    hotelStars: null,
    hotelDescription: null,
    checkInDate: null,
    checkOutDate: null,
    hotelAds: [],
    popularTimesLiveText: null,
    popularTimesLivePercent: null,
    popularTimesHistogram: {},
    openingHours: [],
    mapsUrl,
    siteUrl,
    instagramUrl,
    temSite,
  };
}

// Visita a ficha e classifica o lead. Devolve true se entrou nos prioritários.
async function processar(page, candidato, nicho, cidadeBusca) {
  const id = idDoLocal(candidato.href);
  if (locaisVisitados.has(id)) return false;
  locaisVisitados.add(id);

  let dados;
  try {
    await pausa();
    dados = await extrairLocal(page, candidato.href);
  } catch {
    return false;
  }

  const nome = dados.nome || candidato.nome;
  const digitos = telefoneValido(dados.telefone);
  if (!nome || !digitos) return false;

  // Descarta resultados de cidades vizinhas que o Maps mistura na busca
  const cidade = dados.endereco ? cidadeDoEndereco(dados.endereco) : cidadeBusca;
  if (!cidade) return false;

  const chaveNome = semAcento(nome);
  if (vistos.has(digitos) || vistos.has(chaveNome)) return false;
  vistos.add(digitos).add(chaveNome);

  // Link de Instagram no campo de website não é site: vai para instagramUrl
  const link = limparUrl(dados.siteUrl);
  const siteUrl = link && !ehInstagram(link) ? link : null;
  const instagramUrl = (ehInstagram(link) ? link : limparUrl(dados.instagramUrl)) || null;
  // Só conta como site um domínio próprio (redes sociais, WhatsApp, encurtadores etc. não contam)
  const temSite = Boolean(siteUrl) && !hostGenerico(siteUrl);
  const lead = montarLead({
    nome,
    nicho,
    cidade,
    telefone: dados.telefone,
    digitos,
    endereco: dados.endereco,
    mapsUrl: dados.mapsUrl || candidato.href,
    siteUrl,
    instagramUrl,
    temSite,
    totalScore: dados.totalScore,
    reviewsCount: dados.reviewsCount,
  });

  // Só entram leads sem site próprio (a oportunidade de venda)
  if (temSite) return false;
  novos.push(lead);
  const motivo = instagramUrl ? 'só Instagram' : siteUrl ? 'link genérico' : 'sem site';
  console.log(`  [${novos.length}/${META}] ${nicho} · ${cidade} · ${nome} — ${lead.phone} (${motivo})`);
  if (novos.length % SALVAR_A_CADA === 0) {
    salvar();
    console.log(`  -- gravado: ${existentes.length + novos.length} leads no ficheiro (${novos.length} novos)`);
  }
  return true;
}

// Modo --avaliacoes: revisita os perfis já gravados e preenche totalScore e reviewsCount.
// Devolve true se o Maps bloquear com CAPTCHA.
async function atualizarAvaliacoes(page) {
  const limite = Number(process.env.LIMITE) || Infinity;
  const pendentes = existentes.filter((l) => l.mapsUrl && l.totalScore == null && !l.reviewsCount).slice(0, limite);
  console.log(`> A atualizar avaliações de ${pendentes.length} perfis (de ${existentes.length} na base)`);
  let feitos = 0;
  let falhas = 0;
  for (const lead of pendentes) {
    try {
      await pausa();
      // Uma segunda tentativa cobre os carregamentos que falham por timeout
      const dados = await extrairLocal(page, lead.mapsUrl).catch(() => extrairLocal(page, lead.mapsUrl));
      lead.totalScore = dados.totalScore;
      lead.reviewsCount = dados.reviewsCount;
      feitos++;
      const nota = dados.totalScore == null ? 'sem avaliações' : `${dados.totalScore} ★ (${dados.reviewsCount})`;
      console.log(`  [${feitos + falhas}/${pendentes.length}] ${lead.title} — ${nota}`);
    } catch (e) {
      falhas++;
      console.log(`  [${feitos + falhas}/${pendentes.length}] ! ${lead.title}: ${e.message.split('\n')[0]}`);
    }
    if (page.url().includes('/sorry/')) return true;
    if ((feitos + falhas) % SALVAR_A_CADA === 0) {
      salvar();
      console.log(`  -- gravado (${feitos} atualizados, ${falhas} falhas)`);
    }
  }
  salvar();
  console.log(`\n${feitos} perfis atualizados, ${falhas} falhas`);
  return false;
}

const abrirNavegador = () =>
  puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--lang=pt-BR',
    ],
  });

// Reutilizado pelo buscar-delivery.js
module.exports = { abrirNavegador, novaPagina, listarResultados, extrairLocal, hostGenerico, limparUrl, semAcento, pausa, idDoLocal };

if (require.main === module) (async () => {
  const browser = await abrirNavegador();
  const encerrar = async (codigo) => {
    salvar();
    await browser.close().catch(() => {});
    process.exit(codigo);
  };
  process.on('SIGINT', () => encerrar(130));
  process.on('SIGTERM', () => encerrar(143));

  const inicio = Date.now();
  let bloqueado = false;
  try {
    const page = await novaPagina(browser);

    if (MODO_AVALIACOES) bloqueado = await atualizarAvaliacoes(page);

    busca: for (const { termo, categoria } of MODO_AVALIACOES ? [] : BUSCAS) {
      for (const cidade of CIDADES) {
        let cartoes = [];
        try {
          await pausa();
          cartoes = await listarResultados(page, termo, cidade);
        } catch (e) {
          console.log(`! Falha na busca "${termo}" em ${cidade}: ${e.message}`);
        }
        if (page.url().includes('/sorry/')) {
          bloqueado = true;
          break busca;
        }
        // Cartões com site próprio não são oportunidade: nem se visita a ficha
        const semSite = cartoes.filter((c) => !c.site || hostGenerico(limparUrl(c.site)));
        console.log(`\n> "${termo}" em ${cidade}: ${cartoes.length} resultados (${semSite.length} sem site próprio)`);

        for (const c of semSite) {
          await processar(page, c, categoria, cidade);
          if (page.url().includes('/sorry/')) {
            bloqueado = true;
            break busca;
          }
          if (novos.length >= META) break busca;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  salvar();
  const segundos = Math.round((Date.now() - inicio) / 1000);
  if (!MODO_AVALIACOES) console.log(`\n${novos.length} leads novos + ${existentes.length} existentes = ${existentes.length + novos.length} em ${ARQUIVO}, em ${segundos}s`);
  if (bloqueado) console.log('Atenção: o Google Maps pediu CAPTCHA; a recolha parou e o que já havia foi gravado.');
  else if (!MODO_AVALIACOES && novos.length < META) console.log(`Atenção: todas as buscas foram varridas e só havia ${novos.length} leads novos sem site, abaixo da meta de ${META}.`);
})().catch((e) => {
  console.error('Erro fatal:', e);
  salvar();
  process.exit(1);
});
