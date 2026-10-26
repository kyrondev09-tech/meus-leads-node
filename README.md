# meus-leads-node

Prospecção de empresas de instalação e manutenção de ar condicionado no DDD 21 (Rio de Janeiro e Grande Rio), com Puppeteer.

## Uso

```bash
npm install
node buscar-ar-21.js            # Maps + auditoria de site/Instagram + lista para o CRM
node buscar-ar-21.js --auditar  # só refaz a auditoria sobre o bruto já recolhido
node buscar-ar-21.js --gerar    # só refaz a seleção final
```

## Critérios

- Google Maps: climatização (sem automotivo), aberta, 4,5★ ou mais com 20+ avaliações, telefone do DDD 21
- Sem site profissional (sem site, só rede social/WhatsApp, ou site amador: construtor grátis, lento, sem HTTPS, não adaptado a telemóvel ou fora do ar)
- Instagram com post nos últimos 60 dias (exceções em `EXCECOES_ATIVIDADE`)

## Ficheiros

- `leads-ar-21-crm.json` / `leads-ar-21-crm.md`: os 30 leads nos campos do CRM
- `leads_ar21_bruto.json`: fichas recolhidas no Maps
- `leads_ar21_instagram.json`: auditoria de site e Instagram por empresa
- `buscar-leads.js`: funções partilhadas de busca no Maps
