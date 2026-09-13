/**
 * ══════════════════════════════════════════════════════════════
 *  AGENTE DE TRIAGEM AUTOMÁTICA — VOZ DA OPERAÇÃO
 *  Engenharia Logística · Ferreira Costa · CD Cabo
 *  100% GRATUITO — Google Gemini (free tier, auto-detect model)
 * ══════════════════════════════════════════════════════════════
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://voz-da-operacao-default-rtdb.firebaseio.com";
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || "";
const WA_NUMBERS = (process.env.WHATSAPP_NUMBERS || "").split(",").filter(Boolean);
const WA_APIKEYS = (process.env.WHATSAPP_APIKEYS || "").split(",").filter(Boolean);
const STATUS_OPEN = ["Aberto", "Em andamento", "Pendente", "Aguardando usuario"];

let GEMINI_URL = "";

/* ── Auto-detect: tenta cada modelo+endpoint até um funcionar ── */
async function discoverModel() {
  console.log("🔎 Descobrindo modelo disponível...\n");

  // Primeiro: listar modelos da API key
  for (const ver of ["v1beta", "v1"]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${GEMINI_KEY}`);
      if (r.ok) {
        const data = await r.json();
        const names = (data.models || []).map(m => m.name.replace("models/",""));
        console.log(`  [${ver}] ${names.length} modelos encontrados:`);
        names.forEach(n => console.log(`    - ${n}`));

        // Escolher o melhor disponível
        const prefs = ["gemini-2.5-flash","gemini-2.0-flash","gemini-1.5-flash","gemini-1.5-pro","gemini-pro"];
        for (const p of prefs) {
          const match = names.find(n => n.startsWith(p));
          if (match) {
            GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${match}:generateContent?key=${GEMINI_KEY}`;
            console.log(`\n  ✓ Selecionado: ${match} (${ver})\n`);
            return match;
          }
        }
        // Fallback: qualquer modelo que suporte generateContent
        const any = names.find(n => n.includes("gemini"));
        if (any) {
          GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${any}:generateContent?key=${GEMINI_KEY}`;
          console.log(`\n  ✓ Fallback: ${any} (${ver})\n`);
          return any;
        }
      } else {
        console.log(`  [${ver}] Listagem: ${r.status}`);
      }
    } catch(e) {
      console.log(`  [${ver}] Erro: ${e.message}`);
    }
  }

  // Se listagem não funcionou, tenta brute-force
  console.log("\n  Listagem falhou. Tentando modelos direto...\n");
  const attempts = [
    { m:"gemini-1.5-flash",        v:"v1beta" },
    { m:"gemini-1.5-flash",        v:"v1"     },
    { m:"gemini-pro",              v:"v1beta" },
    { m:"gemini-pro",              v:"v1"     },
    { m:"gemini-1.5-flash-latest", v:"v1beta" },
    { m:"gemini-1.5-flash-latest", v:"v1"     },
    { m:"gemini-2.0-flash-lite",   v:"v1beta" },
  ];

  for (const a of attempts) {
    const url = `https://generativelanguage.googleapis.com/${a.v}/models/${a.m}:generateContent?key=${GEMINI_KEY}`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents:[{parts:[{text:"Diga OK"}]}], generationConfig:{maxOutputTokens:5} }),
      });
      if (r.ok) {
        GEMINI_URL = url;
        console.log(`  ✓ ${a.v}/${a.m} funcionou!\n`);
        return a.m;
      }
      console.log(`  ✗ ${a.v}/${a.m}: ${r.status}`);
    } catch(e) {
      console.log(`  ✗ ${a.v}/${a.m}: ${e.message}`);
    }
  }

  console.error("\n❌ Nenhum modelo Gemini respondeu.");
  console.error("   Possíveis causas:");
  console.error("   1. API key inválida — recrie em aistudio.google.com");
  console.error("   2. Generative Language API não habilitada no projeto");
  console.error("      → console.cloud.google.com → APIs & Services → Enable 'Generative Language API'");
  console.error("   3. Key com restrições de API — remova restrições ou adicione 'Generative Language API'");
  process.exit(1);
}

/* ── Firebase ── */
async function fbGet(path) {
  const r = await fetch(`${FIREBASE_URL}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${path}: ${r.status}`);
  return r.json();
}
async function fbSet(path, value) {
  const r = await fetch(`${FIREBASE_URL}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase SET ${path}: ${r.status}`);
  return r.json();
}

/* ── Gemini — análise ── */
const WMS_CONTEXT = `Você é um agente de triagem especialista em WMS (Warehouse Management System) da Ferreira Costa, CD Cabo de Santo Agostinho.

DOMÍNIOS:
- Via Cega (recebimento cego): tabelas VCEGA, VCEGA_IT, VCEGA_IT_CONF, VCEGA_IT_LOG, WMS_VCEGA_UMA. PKs compostas: NR_VIACEGA + COD_EMPRESA + CODIGO_PRODUTO + SEQUENCIA. VCEGA_IT usa PRODUTO, outras usam CODIGO_PRODUTO. Sempre COD_EMPRESA no WHERE.
- Endereçamento: UMAs, endereços, blocado dinâmico, piso elevado
- Separação/Picking: ordens de separação, status picking (6=cancelado), multivolume
- Conferência: reconferência, fracionamento, contagem
- Estoque: divergências, bloqueio, transferência UMAs, liberação (status 2→3)
- TMS: transporte, rastreamento
- Fulfillment (FUL): pedidos ecommerce

SCHEMAS Oracle: MAXXON e SFC. DB Links: @fcbkp_cab.com (CABO), @fcbkp_ObcCabo.com (OBC).

INSTRUÇÕES:
1. Classifique o domínio
2. Avalie severidade real (Crítico/Alto/Médio/Baixo) pelo impacto operacional
3. Formule hipótese de causa raiz
4. Gere 1-3 SQLs Oracle para investigar (use dados do ticket como filtros)
5. Recomende próximos passos concretos

Responda APENAS com JSON válido, sem markdown, sem texto extra:
{"dominio":"string","severidade":"Crítico|Alto|Médio|Baixo","hipotese":"string","sql_queries":[{"titulo":"string","query":"SQL Oracle"}],"proximos_passos":["string"],"resumo":"1 frase"}`;

async function analyzeTicket(ticket) {
  const ticketInfo = `TICKET: ${ticket.id}\nTÍTULO: ${ticket.title}\nTIPO: ${ticket.type||"N/A"}\nCRITICIDADE: ${ticket.criticality}\nSTATUS: ${ticket.status}\nDESCRIÇÃO: ${ticket.desc||"Sem descrição"}\nSOLICITANTE: ${ticket.requester}\nDOC REF: ${ticket.doc||"Nenhum"}\nABERTO EM: ${ticket.createdAt}`;
  const fullPrompt = `${WMS_CONTEXT}\n\n--- TICKET PARA TRIAGEM ---\n${ticketInfo}`;

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0,300)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Resposta vazia");
    const jsonMatch = text.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSON não encontrado");
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`  ✗ Erro ${ticket.id}:`, e.message);
    return { dominio:"Erro", severidade:"Médio", hipotese:"Falha: "+e.message, sql_queries:[], proximos_passos:["Analisar manualmente"], resumo:"Análise falhou" };
  }
}

/* ── Teams ── */
function buildTeamsCard(results, dateStr) {
  const c = { "Crítico":0, Alto:0, "Médio":0, Baixo:0 };
  const doms = {};
  results.forEach(r => {
    if (c[r.analysis.severidade] !== undefined) c[r.analysis.severidade]++;
    doms[r.analysis.dominio] = (doms[r.analysis.dominio]||0) + 1;
  });
  const domLine = Object.entries(doms).sort((a,b)=>b[1]-a[1]).map(([d,n])=>`${d}: ${n}`).join(" · ");
  const ord = {"Crítico":0,Alto:1,"Médio":2,Baixo:3,Erro:4};
  const sorted = [...results].sort((a,b)=>(ord[a.analysis.severidade]||4)-(ord[b.analysis.severidade]||4));
  const lines = sorted.slice(0,15).map(r => {
    const s=r.analysis.severidade;
    const e = s==="Crítico"?"🔴":s==="Alto"?"🟠":s==="Médio"?"🟡":"🟢";
    return `${e} **${r.ticket.id}** — ${r.analysis.resumo}`;
  }).join("\n\n");

  const sqlLines = sorted.filter(r=>r.analysis.severidade==="Crítico" && r.analysis.sql_queries?.length>0).slice(0,3).map(r => {
    const sq=r.analysis.sql_queries[0];
    return `**${r.ticket.id}** — ${sq.titulo}:\n\`${sq.query.slice(0,200)}\``;
  }).join("\n\n");

  const body = [
    { type:"TextBlock", text:`🔍 Triagem Automática — ${dateStr}`, weight:"bolder", size:"medium" },
    { type:"TextBlock", text:`🔴 ${c["Crítico"]} Crítico · 🟠 ${c.Alto} Alto · 🟡 ${c["Médio"]} Médio · 🟢 ${c.Baixo} Baixo`, spacing:"small" },
    { type:"TextBlock", text:`Domínios: ${domLine}`, spacing:"small", isSubtle:true, size:"small" },
    { type:"TextBlock", text:"───────────────────", spacing:"medium" },
    { type:"TextBlock", text:lines, wrap:true, spacing:"small", size:"small" },
  ];
  if (sqlLines) {
    body.push(
      { type:"TextBlock", text:"───────────────────", spacing:"medium" },
      { type:"TextBlock", text:"🔎 SQLs Críticos:", weight:"bolder", size:"small" },
      { type:"TextBlock", text:sqlLines, wrap:true, size:"small", fontType:"monospace" }
    );
  }
  if (results.length>15) body.push({ type:"TextBlock", text:`_+${results.length-15} tickets_`, isSubtle:true, size:"small" });

  return { type:"message", attachments:[{ contentType:"application/vnd.microsoft.card.adaptive", content:{ $schema:"http://adaptivecards.io/schemas/adaptive-card.json", type:"AdaptiveCard", version:"1.4", body }}] };
}

async function sendTeams(results, dateStr) {
  if (!TEAMS_WEBHOOK) { console.log("  ⚠ Teams não configurado"); return; }
  try {
    const r = await fetch(TEAMS_WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(buildTeamsCard(results,dateStr)) });
    console.log(r.ok ? "  ✓ Teams enviado" : `  ✗ Teams ${r.status}`);
  } catch(e) { console.log("  ✗ Teams:",e.message); }
}

async function sendWhatsApp(criticals, dateStr) {
  if (!WA_NUMBERS.length) { console.log("  ⚠ WhatsApp não configurado"); return; }
  if (!criticals.length) { console.log("  ℹ Sem Críticos — WhatsApp não acionado"); return; }
  const lines = criticals.map(r=>`🔴 ${r.ticket.id}: ${r.analysis.resumo}`).join("\n");
  const msg = encodeURIComponent(`⚠️ TRIAGEM ${dateStr}\n${criticals.length} CRÍTICO(S):\n\n${lines}`);
  for (let i=0; i<WA_NUMBERS.length; i++) {
    const phone=WA_NUMBERS[i], apikey=WA_APIKEYS[i]||WA_APIKEYS[0];
    if (!apikey) continue;
    try {
      const r = await fetch(`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${msg}&apikey=${apikey}`);
      console.log(r.ok ? `  ✓ WhatsApp ${phone}` : `  ✗ WhatsApp ${phone}: ${r.status}`);
    } catch(e) { console.log(`  ✗ WhatsApp ${phone}:`,e.message); }
  }
}

/* ── Main ── */
async function main() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("pt-BR", { weekday:"long", day:"2-digit", month:"2-digit", year:"numeric", timeZone:"America/Recife" });
  const dateKey = now.toISOString().split("T")[0];

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  AGENTE DE TRIAGEM — ${dateStr}`);
  console.log(`${"═".repeat(50)}\n`);

  if (!GEMINI_KEY) {
    console.error("❌ GEMINI_API_KEY não configurada!");
    process.exit(1);
  }

  await discoverModel();

  console.log("📋 Carregando tickets...");
  const raw = await fbGet("tickets");
  if (!raw) { console.log("  Vazio."); return; }

  const all = Object.entries(raw).map(([k,v])=>({...v,_key:k}));
  const open = all.filter(t=>STATUS_OPEN.includes(t.status));
  console.log(`  ${all.length} total · ${open.length} abertos\n`);

  if (!open.length) {
    console.log("✅ Nenhum aberto. Bom dia!");
    if (TEAMS_WEBHOOK) await fetch(TEAMS_WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ type:"message", attachments:[{ contentType:"application/vnd.microsoft.card.adaptive", content:{ $schema:"http://adaptivecards.io/schemas/adaptive-card.json", type:"AdaptiveCard", version:"1.4", body:[{type:"TextBlock",text:`✅ ${dateStr} — Zero tickets. Bom dia!`,weight:"bolder"}]}}]})});
    return;
  }

  const existing = await fbGet(`triagens/${dateKey}`) || {};
  const pending = open.filter(t=>!existing[t._key]);
  console.log(`  ${Object.keys(existing).length} já triados · ${pending.length} pendentes\n`);

  const results = [];
  for (const [k,v] of Object.entries(existing)) {
    const t = open.find(x=>x._key===k);
    if (t) results.push({ ticket:t, analysis:v });
  }

  for (let i=0; i<pending.length; i++) {
    const t = pending[i];
    console.log(`🔍 [${i+1}/${pending.length}] ${t.id} — ${(t.title||"").slice(0,50)}`);
    const analysis = await analyzeTicket(t);
    console.log(`   → ${analysis.severidade} | ${analysis.dominio} | ${analysis.resumo}`);
    try { await fbSet(`triagens/${dateKey}/${t._key}`, { ...analysis, ticketId:t.id, analyzedAt:new Date().toISOString() }); } catch(e) { console.log(`   ⚠ Save: ${e.message}`); }
    results.push({ ticket:t, analysis });
    if (i < pending.length-1) await new Promise(r=>setTimeout(r,1000));
  }

  const criticals = results.filter(r=>r.analysis.severidade==="Crítico");
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${results.length} triados | 🔴 ${criticals.length} Críticos`);
  criticals.forEach(r=>console.log(`  ${r.ticket.id}: ${r.analysis.resumo}`));
  console.log(`${"═".repeat(50)}\n`);

  console.log("📨 Notificando...");
  await sendTeams(results, dateStr);
  await sendWhatsApp(criticals, dateStr);
  console.log("\n✅ Concluído!\n");
}

main().catch(e => { console.error("💥", e); process.exit(1); });
