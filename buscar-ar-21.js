const fs = require('fs');
const path = require('path');
const { abrirNavegador, novaPagina, listarResultados, extrairLocal, hostGenerico, limparUrl, semAcento, pausa, idDoLocal } = require('./buscar-leads');

// Uso: node buscar-ar-21.js [--auditar | --gerar]
//   sem argumentos: recolhe fichas no Maps, audita o Instagram e gera a lista para o CRM
//   --auditar: só refaz a auditoria do Instagram sobre o bruto já recolhido (e gera a lista)
//   --gerar: só refaz a seleção final a partir do que já está gravado
const LOCAIS = [
  'Rio de Janeiro', 'Barra da Tijuca', 'Tijuca', 'Copacabana', 'Botafogo', 'Jacarepaguá', 'Recreio dos Bandeirantes',
  'Campo Grande Rio de Janeiro', 'Méier', 'Ilha do Governador', 'Niterói', 'São Gonçalo', 'Duque de Caxias',
  'Nova Iguaçu', 'Maricá', 'São João de Meriti', 'Itaboraí', 'Belford Roxo',
];
const TERMOS = ['ar condicionado instalação', 'climatização', 'manutenção split'];
const TOP = 30;
const NOTA_MIN = 4.5;
const AVALIACOES_MIN = 20;
const POST_RECENTE_DIAS = 60;
// Aprovados à mão apesar de o último post passar do limite (ex.: 62 dias, perfil grande)
const EXCECOES_ATIVIDADE = ['climademontanharefrigeracao'];
const SALVAR_A_CADA = 15;
const BRUTO = path.join(__dirname, 'leads_ar21_bruto.json');
const AUDITORIA = path.join(__dirname, 'leads_ar21_instagram.json');
const SAIDA = path.join(__dirname, 'leads-ar-21-crm.json');
const SAIDA_MD = path.join(__dirname, 'leads-ar-21-crm.md');

const AR = /ar.condicionado|climatiza|refrigera|split|hvac/;
const AUTOMOTIVO = /automotiv|autoeletric|auto eletric|oficina mecanica|veiculo|para autos|refrigeracao auto|\bcar\b/;
// Construtores grátis/amadores: site nestes domínios conta como "site amador"
const HOSTS_AMADORES = ['wixsite.com', 'negocio.site', 'business.site', 'webnode.page', 'webnode.com.br', 'site123.me', 'godaddysites.com', 'blogspot.com', 'wordpress.com', 'canva.site', 'my.canva.site', 'carrd.co', 'comunidades.net', 'ueniweb.com', 'jimdosite.com', 'webflow.io', 'netlify.app', 'vercel.app'];
const SITE_LENTO_MS = 6000;
// O Instagram mostra a parede de login a quem pede perfis depressa demais
const pausaIg = () => new Promise((r) => setTimeout(r, 5000 + Math.random() * 4000));
const VAZIOS_SEGUIDOS_MAX = 3;
// Sobe quando muda a leitura do perfil: auditorias de versões antigas são refeitas
const VERSAO_IG = 2;

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const hostEm = (h, lista) => lista.some((x) => h === x || h.endsWith('.' + x));
const digitosDoTelefone = (tel) => (tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const telefoneDDD21 = (d) => /^21(9\d{8}|[2-5]\d{7})$/.test(d);
const ehCelular = (d) => d.length === 11;
const formatarTelefone = (d) => `(${d.slice(0, 2)}) ${d.slice(2, ehCelular(d) ? 7 : 6)}-${d.slice(ehCelular(d) ? 7 : 6)}`;

function avaliacoesDoCartao(texto) {
  const m = (texto || '').match(/(\d[.,]\d)\s*\(([\d.]+)\)/);
  return m ? { nota: parseFloat(m[1].replace(',', '.')), qtd: parseInt(m[2].replace(/\./g, ''), 10) } : null;
}

// Pelo cartão já se descartam fechados, nota abaixo de 4,5 e poucas avaliações; quem tem site entra (pode ser amador/lento)
function cartaoDescartavel(c) {
  if (/fechado (temporariamente|permanentemente)|sem avalia/i.test(c.texto || '')) return true;
  const av = avaliacoesDoCartao(c.texto);
  return !av || av.nota < NOTA_MIN || av.qtd < AVALIACOES_MIN;
}

// Só perfis (instagram.com/<usuario>); posts, reels e convites não contam
function usuarioInstagram(url) {
  try {
    const u = new URL(limparUrl(url));
    if (!/(^|\.)instagram\.com$|^instagr\.am$/.test(u.hostname)) return null;
    const usuario = u.pathname.split('/').filter(Boolean)[0];
    if (!usuario || /^(p|reel|reels|explore|stories|accounts|tv|direct|invites|share)$/.test(usuario)) return null;
    return usuario.toLowerCase();
  } catch {
    return null;
  }
}

// ---------- Fase 1: Google Maps ----------

async function coletar(browser) {
  const bruto = fs.existsSync(BRUTO) ? JSON.parse(fs.readFileSync(BRUTO, 'utf8')) : [];
  const visitados = new Set(bruto.map((l) => l.id));
  const salvar = () => fs.writeFileSync(BRUTO, JSON.stringify(bruto, null, 2));
  const page = await novaPagina(browser);
  try {
    for (const termo of TERMOS) {
      for (const local of LOCAIS) {
        let cartoes = [];
        try {
          await pausa();
          cartoes = await listarResultados(page, termo, local);
        } catch (e) {
          console.log(`! Falha na busca "${termo}" em ${local}: ${e.message}`);
        }
        if (page.url().includes('/sorry/')) return console.log('Atenção: o Google Maps pediu CAPTCHA; a recolha parou.');
        const candidatos = cartoes.filter((c) => !cartaoDescartavel(c) && !visitados.has(idDoLocal(c.href)));
        console.log(`\n> "${termo}" em ${local}: ${cartoes.length} resultados, ${candidatos.length} fichas a visitar`);
        for (const c of candidatos) {
          const id = idDoLocal(c.href);
          visitados.add(id);
          try {
            await pausa();
            const dados = await extrairLocal(page, c.href).catch(() => extrairLocal(page, c.href));
            bruto.push({ id, termoBusca: termo, localBusca: local, ...dados, nome: dados.nome || c.nome, scrapedAt: new Date().toISOString() });
            console.log(`  [${bruto.length}] ${dados.nome} — ${dados.categoria} · ${dados.totalScore} ★ (${dados.reviewsCount}) ${dados.telefone}`);
          } catch (e) {
            console.log(`  ! ${c.nome}: ${e.message.split('\n')[0]}`);
          }
          if (page.url().includes('/sorry/')) return console.log('Atenção: o Google Maps pediu CAPTCHA; a recolha parou.');
          if (bruto.length % SALVAR_A_CADA === 0) salvar();
        }
        salvar();
      }
    }
  } finally {
    salvar();
    await page.close().catch(() => {});
  }
}

// Filtro do Maps: nicho certo, aberto, 4,5+ com volume, telefone 21; o site é avaliado depois
function qualificaNoMaps(l) {
  if (l.fechado) return 'fechado';
  if (!l.nome || !l.mapsUrl) return 'dados incompletos';
  if (!AR.test(semAcento(l.categoria)) && !AR.test(semAcento(l.nome))) return 'não é climatização';
  if (AUTOMOTIVO.test(semAcento(l.categoria)) || AUTOMOTIVO.test(semAcento(l.nome))) return 'automotivo';
  if (!(l.totalScore >= NOTA_MIN) || !(l.reviewsCount >= AVALIACOES_MIN)) return `abaixo de ${NOTA_MIN}★/${AVALIACOES_MIN} avaliações`;
  if (!telefoneDDD21(digitosDoTelefone(l.telefone))) return 'sem telefone do DDD 21';
  return null;
}

// ---------- Fase 2: site e Instagram ----------

// Site próprio: mede o carregamento e marca construtores grátis como amadores
async function avaliarSite(browser, url) {
  const u = limparUrl(url);
  if (!u || hostGenerico(u)) return { tipo: 'sem site', url: u || null };
  if (hostEm(host(u), HOSTS_AMADORES)) return { tipo: 'amador', url: u, motivo: `construtor grátis (${host(u)})` };
  const page = await browser.newPage();
  try {
    const inicio = Date.now();
    const resp = await page.goto(u, { waitUntil: 'load', timeout: 20000 });
    const ms = Date.now() - inicio;
    const status = resp ? resp.status() : 0;
    if (status >= 400) return { tipo: 'amador', url: u, motivo: `site responde HTTP ${status}`, ms };
    const https = page.url().startsWith('https://');
    const viewport = await page.$('meta[name="viewport"]');
    if (ms > SITE_LENTO_MS) return { tipo: 'amador', url: u, motivo: `lento (${(ms / 1000).toFixed(1)} s até carregar)`, ms };
    if (!https) return { tipo: 'amador', url: u, motivo: 'sem HTTPS', ms };
    if (!viewport) return { tipo: 'amador', url: u, motivo: 'não adaptado a telemóvel (sem meta viewport)', ms };
    return { tipo: 'profissional', url: u, ms };
  } catch (e) {
    return { tipo: 'amador', url: u, motivo: `fora do ar (${e.message.split('\n')[0].slice(0, 60)})` };
  } finally {
    await page.close().catch(() => {});
  }
}

// Sem @ no Maps: testa os @ mais prováveis a partir do nome (o DuckDuckGo responde com CAPTCHA a buscas automáticas)
function handlesProvaveis(nome) {
  const base = semAcento(nome.split(/\s[|\-–]\s|\|/)[0]);
  const palavras = base.split(/[^a-z0-9]+/).filter((w) => w && !/^(de|da|do|das|dos|e|em|ltda|me|eireli)$/.test(w));
  if (!palavras.length) return [];
  const junto = palavras.join('');
  const opcoes = [junto, palavras.join('_'), palavras.join('.'), `${junto}rj`, `${junto}_rj`];
  return [...new Set(opcoes)].filter((h) => h.length >= 4 && h.length <= 30).slice(0, 4);
}

// O perfil só conta se for do nicho e da região (telefone, cidade, "RJ" ou "Rio" na bio/nome)
function perfilConfere(ig, l) {
  if (!ig.existe) return false;
  const texto = semAcento(`${ig.nomePerfil || ''} ${ig.bio || ''}`);
  if (!/ar.?condicionado|climatiza|refrigera|split|hvac/.test(texto)) return false;
  const fone = digitosDoTelefone(l.telefone).slice(-8);
  const cidade = semAcento((l.endereco || '').match(/([^,-]+) - RJ/)?.[1]?.trim() || '');
  return (fone && (ig.bio || '').replace(/\D/g, '').includes(fone)) || (cidade && texto.includes(cidade)) || /\brj\b|\brio\b|niteroi|baixada|grande rio/.test(texto);
}

// Devolve { ig } ou, se algum palpite bateu na parede de login, { bloqueado: true } para tentar de novo depois
async function adivinharInstagram(page, l) {
  let bloqueado = false;
  for (const h of handlesProvaveis(l.nome)) {
    const ig = await auditarInstagram(page, h).catch(() => ({ usuario: h, existe: false }));
    await pausaIg();
    if (perfilConfere(ig, l)) return { ig };
    if (ig.existe && ig.seguidores == null && !ig.itensNaGrade) bloqueado = true;
  }
  return { ig: null, bloqueado };
}

// O ID do media codifica a data: os primeiros 41 bits são ms desde a época do Instagram
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function dataDoShortcode(sc) {
  let id = 0n;
  for (const ch of sc.slice(0, 11)) id = id * 64n + BigInt(ALFABETO.indexOf(ch));
  const ms = Number(id >> 23n) + 1314220021721;
  return ms > 1314220021721 && ms < Date.now() + 864e5 ? new Date(ms) : null;
}

function numeroAbreviado(s) {
  const m = (s || '').replace(/\s/g, '').match(/([\d.,]+)(mil|mi|k|m)?/i);
  if (!m) return null;
  const mult = { mil: 1e3, k: 1e3, mi: 1e6, m: 1e6 }[(m[2] || '').toLowerCase()] || 1;
  const n = mult > 1 ? parseFloat(m[1].replace(',', '.')) : parseInt(m[1].replace(/[.,]/g, ''), 10);
  return Math.round(n * mult);
}

// Perfil público, sem login: contadores, bio, link da bio e a grelha de posts/reels
async function auditarInstagram(page, usuario) {
  await page.goto(`https://www.instagram.com/${usuario}/`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const d = await page.evaluate((usuario) => {
    const desc = document.querySelector('meta[name="description"]')?.content || '';
    const og = document.querySelector('meta[property="og:description"]')?.content || '';
    const header = document.querySelector('header');
    const linksBio = [...(header?.querySelectorAll('a[href]') || [])]
      .map((a) => a.href)
      .filter((h) => !/instagram\.com\/(?!.*l\.instagram)/.test(h) || /l\.instagram\.com/.test(h));
    const grade = [...document.querySelectorAll('main a[href]')]
      .map((a) => a.getAttribute('href'))
      .map((h) => (h.match(new RegExp(`^/(?:${usuario}/)?(p|reel)/([\\w-]+)`, 'i')) || []))
      .filter((m) => m[2])
      .map((m) => ({ tipo: m[1], sc: m[2] }));
    return {
      existe: !/Esta página não está disponível|Sorry, this page isn't available/i.test(document.body.innerText) && Boolean(desc || og),
      desc,
      og,
      headerTexto: header?.innerText || '',
      linksBio,
      grade,
    };
  }, usuario);
  if (!d.existe) return { usuario, existe: false };

  const seguidores = numeroAbreviado((d.og.match(/^([\d.,]+\s*(?:mil|mi|k|m)?)\s*seguidores/i) || [])[1]);
  const posts = numeroAbreviado((d.og.match(/([\d.,]+\s*(?:mil|mi|k|m)?)\s*posts/i) || [])[1]);
  const nomePerfil = (d.og.match(/de (.+?) \(@/) || [])[1] || null;
  const bio = (d.desc.match(/no Instagram: "([\s\S]*)"$/) || [])[1] || '';
  const linkBio = d.linksBio
    .map((h) => {
      try {
        const u = new URL(h);
        return u.hostname === 'l.instagram.com' ? u.searchParams.get('u') : h;
      } catch {
        return h;
      }
    })
    .find((h) => h && !/instagram\.com|threads\.(net|com)|facebook\.com\/(privacy|help)|meta\.com|g\.co\/kgs|share\.google/.test(h)) || null;
  const vistos = new Set();
  const grade = d.grade.filter((g) => !vistos.has(g.sc) && vistos.add(g.sc)).slice(0, 12);
  const datas = grade.map((g) => dataDoShortcode(g.sc)).filter(Boolean).sort((a, b) => b - a);
  const ultimoPost = datas[0] || null;
  const diasDesdeUltimo = ultimoPost ? Math.floor((Date.now() - ultimoPost) / 864e5) : null;
  const postsUltimos90 = datas.filter((x) => Date.now() - x < 90 * 864e5).length;
  const reels = grade.filter((g) => g.tipo === 'reel').length;
  const textoTudo = `${bio}\n${d.headerTexto}`;
  const email = (textoTudo.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null;

  let tipoLinkBio = 'sem link';
  if (linkBio) {
    const h = host(linkBio);
    if (/wa\.me|whatsapp|wa\.link|abre\.ai|zap\.|chama\.|wpp/.test(h)) tipoLinkBio = 'WhatsApp direto';
    else if (/linktr\.ee|linktree|beacons\.ai|taplink|linkbio|bio\.link|lnk\.bio|campsite\.bio/.test(h)) tipoLinkBio = 'agregador de links';
    else if (hostGenerico(linkBio)) tipoLinkBio = 'rede social/genérico';
    else tipoLinkBio = 'site próprio';
  }

  return {
    usuario,
    existe: true,
    url: `https://www.instagram.com/${usuario}/`,
    nomePerfil,
    seguidores,
    posts,
    bio,
    email,
    linkBio,
    tipoLinkBio,
    ultimoPost: ultimoPost ? ultimoPost.toISOString().slice(0, 10) : null,
    diasDesdeUltimo,
    postsUltimos90,
    reelsNaGrade: reels,
    itensNaGrade: grade.length,
    ativo: diasDesdeUltimo != null && diasDesdeUltimo <= POST_RECENTE_DIAS,
    versao: VERSAO_IG,
    auditadoEm: new Date().toISOString(),
  };
}

async function auditar(browser) {
  const bruto = JSON.parse(fs.readFileSync(BRUTO, 'utf8'));
  const auditoria = fs.existsSync(AUDITORIA) ? JSON.parse(fs.readFileSync(AUDITORIA, 'utf8')) : {};
  const salvar = () => fs.writeFileSync(AUDITORIA, JSON.stringify(auditoria, null, 2));
  const fones = new Set();
  const candidatos = bruto
    .filter((l) => !qualificaNoMaps(l))
    .sort((a, b) => b.reviewsCount - a.reviewsCount)
    .filter((l) => {
      const d = digitosDoTelefone(l.telefone);
      return !fones.has(d) && fones.add(d);
    });
  console.log(`\n> Auditoria: ${candidatos.length} empresas passaram no filtro do Maps`);

  const pagIg = await browser.newPage();
  await pagIg.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
  await pagIg.setExtraHTTPHeaders({ 'accept-language': 'pt-BR,pt;q=0.9' });
  let aprovados = 0;
  let vaziosSeguidos = 0;
  try {
    for (const l of candidatos) {
      if (aprovados >= TOP * 2) break;
      const a = auditoria[l.id] || {};
      if (!a.site) a.site = await avaliarSite(browser, l.siteUrl);
      if (a.site.tipo === 'profissional') {
        auditoria[l.id] = a;
        console.log(`  - ${l.nome}: site profissional (${a.site.url}), descartado`);
        continue;
      }
      const doMaps = usuarioInstagram(l.siteUrl) || usuarioInstagram(l.instagramUrl);
      // @ já confirmado numa auditoria anterior (Maps ou busca): reaproveita-se
      const conhecido = doMaps || a.instagram?.usuario;
      // Perfil sem contadores nem grelha = o Instagram mostrou a parede de login; tenta-se de novo
      const vazio = a.instagram?.existe && a.instagram.seguidores == null && !a.instagram.itensNaGrade;
      const refazer = a.instagram === undefined || vazio || (a.instagram && a.instagram.versao !== VERSAO_IG) || (!a.instagram && a.tentativaIg !== VERSAO_IG);
      if (refazer) {
        if (conhecido) {
          const fonte = doMaps ? 'Maps' : a.instagram.fonte;
          a.instagram = { ...(await auditarInstagram(pagIg, conhecido).catch((e) => ({ usuario: conhecido, existe: false, erro: e.message }))), fonte };
          await pausaIg();
        } else {
          const { ig, bloqueado } = await adivinharInstagram(pagIg, l);
          a.instagram = ig ? { ...ig, fonte: '@ deduzido do nome' } : null;
          if (!bloqueado) a.tentativaIg = VERSAO_IG;
        }
      }
      // Site na bio do Instagram (mesmo sem site no Maps): só é descartado se for profissional
      if (a.instagram?.tipoLinkBio === 'site próprio' && a.siteBio?.url !== a.instagram.linkBio) a.siteBio = await avaliarSite(browser, a.instagram.linkBio);
      auditoria[l.id] = a;
      const ig = a.instagram;
      if (refazer) {
        const vazioAgora = ig?.existe && ig.seguidores == null && !ig.itensNaGrade;
        vaziosSeguidos = vazioAgora ? vaziosSeguidos + 1 : 0;
        if (vaziosSeguidos >= VAZIOS_SEGUIDOS_MAX) {
          salvar();
          console.log(`Atenção: ${VAZIOS_SEGUIDOS_MAX} perfis seguidos vieram vazios (parede de login do Instagram); a auditoria parou para retomar mais tarde.`);
          process.exitCode = 2;
          break;
        }
      }
      if (ig?.ativo) aprovados++;
      console.log(`  ${ig?.ativo ? '✓' : '·'} ${l.nome} — site: ${a.site.tipo}${a.site.motivo ? ` (${a.site.motivo})` : ''} · IG: ${ig ? `@${ig.usuario} ${ig.existe ? `${ig.seguidores ?? '?'} seg., último post há ${ig.diasDesdeUltimo ?? '?'} d, ${ig.reelsNaGrade}/${ig.itensNaGrade} reels` : 'indisponível'}` : 'não encontrado'}`);
      salvar();
    }
  } finally {
    salvar();
    await pagIg.close().catch(() => {});
  }
}

// ---------- Fase 3: lista para o CRM ----------

// Link curto e estável: cid derivado do fid (0x...:0x...), senão o URL da ficha
function linkDoMaps(l) {
  const fid = /^0x[0-9a-f]+:0x[0-9a-f]+$/.test(l.id || '') ? l.id : null;
  return fid ? `https://maps.google.com/?cid=${BigInt(fid.split(':')[1])}` : l.mapsUrl;
}

function notasDeAbordagem(l, a) {
  const ig = a.instagram;
  const site =
    a.site.tipo === 'sem site'
      ? 'Não tem site: o botão "Website" do Maps está vazio ou aponta para rede social/WhatsApp'
      : `Site atual é fraco (${a.site.motivo})`;
  const link = { 'WhatsApp direto': 'a bio do Instagram manda direto para o WhatsApp', 'agregador de links': 'a bio usa um agregador de links (Linktree e afins)', 'sem link': 'a bio não tem link nenhum', 'rede social/genérico': 'o link da bio aponta para outra rede social', 'site próprio': `a bio aponta para um site fraco (${a.siteBio?.motivo || 'amador'})`, 'por confirmar': 'link da bio por confirmar (o Instagram bloqueou a releitura sem login)' }[ig.tipoLinkBio];
  const conteudo = ig.reelsNaGrade >= 4 ? `publica bastante vídeo (${ig.reelsNaGrade} reels nos últimos ${ig.itensNaGrade} posts)` : `posta com regularidade (último post em ${ig.ultimoPost})`;
  const estado = ig.ativo ? 'Instagram ativo' : `Instagram grande mas com o último post há ${ig.diasDesdeUltimo} dias`;
  return `${l.totalScore}★ com ${l.reviewsCount} avaliações no Maps e ${estado} (${ig.seguidores ?? '?'} seguidores, ${conteudo}). ${site}; ${link}. Gancho: a reputação já gera procura no Maps e no Instagram, mas não há uma página rápida com serviços, área de atendimento, avaliações e botão de orçamento por WhatsApp para converter esse tráfego — propor site leve focado em instalação/manutenção de split no ${(l.endereco || '').match(/([^,-]+) - RJ/)?.[1]?.trim() || 'Grande Rio'}.`;
}

function gerar() {
  const bruto = JSON.parse(fs.readFileSync(BRUTO, 'utf8'));
  const auditoria = JSON.parse(fs.readFileSync(AUDITORIA, 'utf8'));
  const motivos = {};
  const conta = (m) => (motivos[m] = (motivos[m] || 0) + 1);
  const fones = new Set();
  const usuarios = new Set();
  const aprovados = [];
  for (const l of [...bruto].sort((a, b) => b.reviewsCount - a.reviewsCount)) {
    const m = qualificaNoMaps(l);
    if (m) {
      conta(m);
      continue;
    }
    const a = auditoria[l.id];
    if (!a) {
      conta('não auditado');
      continue;
    }
    const d = digitosDoTelefone(l.telefone);
    if (a.site.tipo === 'profissional') conta('site profissional');
    else if (!a.instagram) conta('Instagram não encontrado');
    else if (!a.instagram.existe) conta('Instagram indisponível');
    else if (AUTOMOTIVO.test(semAcento(`${a.instagram.nomePerfil || ''} ${a.instagram.bio || ''}`)) || /ar automotivo/.test(semAcento(a.instagram.nomePerfil || ''))) conta('automotivo (pelo Instagram)');
    else if (!a.instagram.ativo && !EXCECOES_ATIVIDADE.includes(a.instagram.usuario)) conta(`Instagram parado há mais de ${POST_RECENTE_DIAS} dias`);
    else if (a.instagram.tipoLinkBio === 'site próprio' && a.siteBio?.tipo === 'profissional') conta('bio aponta para site profissional');
    else if (fones.has(d) || usuarios.has(a.instagram.usuario)) conta('repetido');
    else {
      fones.add(d);
      usuarios.add(a.instagram.usuario);
      aprovados.push({ l, a, d });
    }
  }
  // Perfis mais vivos primeiro, depois volume de avaliações
  // Perfis repostos da primeira auditoria não têm postsUltimos90: a recência do último post serve para todos
  const forca = ({ l, a }) => (POST_RECENTE_DIAS - a.instagram.diasDesdeUltimo) / 6 + a.instagram.reelsNaGrade * 3 + Math.log10(l.reviewsCount) * 5;
  aprovados.sort((x, y) => forca(y) - forca(x));

  const leads = aprovados.slice(0, TOP).map(({ l, a, d }) => {
    const ig = a.instagram;
    const muitoAtivo = ig.postsUltimos90 != null ? ig.postsUltimos90 >= 6 && ig.reelsNaGrade >= 3 : ig.diasDesdeUltimo <= 15 && ig.reelsNaGrade >= 6;
    return {
      'Nome do lead / contato': ig.nomePerfil && semAcento(ig.nomePerfil) !== semAcento(l.nome) ? `${ig.nomePerfil} (${l.nome})` : l.nome,
      Empresa: l.nome,
      'E-mail': ig.email || '',
      'Telefone / WhatsApp': formatarTelefone(d),
      'Etapa do pipeline': 'Novo Lead',
      Prioridade: muitoAtivo ? 'Alta' : 'Média',
      'Origem do lead': 'Google Maps / Outbound',
      Instagram: ig.url,
      'Link do Google Maps': linkDoMaps(l),
      'Notas de Abordagem': notasDeAbordagem(l, a),
    };
  });

  fs.writeFileSync(SAIDA, JSON.stringify(leads, null, 2));
  const md = leads
    .map((x, i) => `### ${i + 1}. ${x.Empresa}\n` + Object.entries(x).map(([k, v]) => `- **${k}:** ${v || '—'}`).join('\n'))
    .join('\n\n');
  fs.writeFileSync(SAIDA_MD, `# Leads ar-condicionado DDD 21 — ${new Date().toISOString().slice(0, 10)}\n\n${md}\n`);
  console.log(`\n${aprovados.length} empresas aprovadas; ${leads.length} gravadas em ${SAIDA} e ${SAIDA_MD}`);
  console.log('Descartadas por:', motivos);
  if (leads.length < TOP) {
    console.log(`Atenção: só ${leads.length} leads cumprem todos os critérios, abaixo de ${TOP}.`);
    process.exitCode = 1;
  }
}

(async () => {
  const soGerar = process.argv.includes('--gerar');
  if (!soGerar) {
    const browser = await abrirNavegador();
    process.on('SIGINT', async () => {
      await browser.close().catch(() => {});
      process.exit(130);
    });
    try {
      if (!process.argv.includes('--auditar')) await coletar(browser);
      await auditar(browser);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  gerar();
})().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
