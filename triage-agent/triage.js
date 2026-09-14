/**
 * AGENTE DE TRIAGEM — VOZ DA OPERAÇÃO v6
 * 100% gratuito — Gemini free tier
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://voz-da-operacao-default-rtdb.firebaseio.com";
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || "";
const WA_NUMBERS = (process.env.WHATSAPP_NUMBERS || "").split(",").filter(Boolean);
const WA_APIKEYS = (process.env.WHATSAPP_APIKEYS || "").split(",").filter(Boolean);
const STATUS_OPEN = ["Aberto", "Em andamento", "Pendente", "Aguardando usuario"];
let GEMINI_URL = "";

async function discoverModel() {
  console.log("🔎 Descobrindo modelo...");
  const skip = ["embedding","tts","image","audio","video","transcribe","veo","lyria","aqa","nano","live","customtools","robotics","computer-use","antigravity","deep-research","native-audio"];
  const prefs = ["gemini-3.6-flash","gemini-3.5-flash","gemini-3.7-flash","gemini-3.8-flash"];
  for (const ver of ["v1beta"]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${GEMINI_KEY}`);
      if (!r.ok) continue;
      const names = ((await r.json()).models || []).map(m => m.name.replace("models/",""));
      for (const p of prefs) {
        const m = names.find(n => n.startsWith(p));
        if (m) { GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${m}:generateContent?key=${GEMINI_KEY}`; console.log(`  ✓ ${m}\n`); return m; }
      }
      const fb = names.find(n => n.includes("flash") && !skip.some(s => n.includes(s)));
      if (fb) { GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${fb}:generateContent?key=${GEMINI_KEY}`; console.log(`  ✓ ${fb}\n`); return fb; }
    } catch(e) { console.log(`  err: ${e.message}`); }
  }
  console.error("❌ Nenhum modelo"); process.exit(1);
}

async function fbGet(p) { const r = await fetch(`${FIREBASE_URL}/${p}.json`); return r.json(); }
async function fbSet(p, v) { await fetch(`${FIREBASE_URL}/${p}.json`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(v) }); }

const PROMPT = `Você é um triador WMS da Ferreira Costa (CD Cabo).
Domínios: Via Cega, Endereçamento, Separação, Conferência, Estoque, TMS, Fulfillment.
Schemas Oracle: MAXXON, SFC. DB Links: @fcbkp_cab.com, @fcbkp_ObcCabo.com.
Tabelas Via Cega: VCEGA, VCEGA_IT (usa PRODUTO), VCEGA_IT_CONF, WMS_VCEGA_UMA. Sempre COD_EMPRESA no WHERE.
Analise o ticket abaixo. Retorne JSON com: dominio, severidade (Crítico/Alto/Médio/Baixo), hipotese, sql_queries [{titulo, query}], proximos_passos [strings], resumo.`;

async function analyzeTicket(ticket) {
  const info = `${ticket.id}: ${ticket.title}. Tipo: ${ticket.type||"N/A"}. Criticidade: ${ticket.criticality}. Status: ${ticket.status}. Descrição: ${ticket.desc||"Sem descrição"}. Solicitante: ${ticket.requester}. Doc: ${ticket.doc||"N/A"}. Data: ${ticket.createdAt}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${PROMPT}\n\nTICKET: ${info}` }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                dominio: { type: "string" },
                severidade: { type: "string", enum: ["Crítico", "Alto", "Médio", "Baixo"] },
                hipotese: { type: "string" },
                sql_queries: { type: "array", items: { type: "object", properties: { titulo: { type: "string" }, query: { type: "string" } }, required: ["titulo", "query"] } },
                proximos_passos: { type: "array", items: { type: "string" } },
                resumo: { type: "string" }
              },
              required: ["dominio", "severidade", "hipotese", "sql_queries", "proximos_passos", "resumo"]
            }
          },
        }),
      });

      if (res.status === 503 || res.status === 429) {
        console.log(`     ⏳ ${res.status} — aguardando ${attempt * 3}s...`);
        await new Promise(r => setTimeout(r, attempt * 3000));
        continue;
      }

      const raw = await res.text();

      if (!res.ok) {
        console.log(`     ⚠ Gemini ${res.status}: ${raw.slice(0, 150)}`);
        // Se responseMimeType não é suportado, tenta sem
        if (raw.includes("responseMimeType") || raw.includes("responseSchema")) {
          console.log("     ↻ Tentando sem JSON mode...");
          return await analyzeTicketFallback(info);
        }
        throw new Error(`${res.status}`);
      }

      // Parse a resposta da API
      let data;
      try { data = JSON.parse(raw); } catch(e) {
        console.log(`     📝 Raw (não é JSON API): ${raw.slice(0,200)}`);
        throw new Error("Resposta não é JSON válido da API");
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.log(`     📝 Sem text em candidates. Keys: ${JSON.stringify(Object.keys(data))}`);
        throw new Error("Sem texto na resposta");
      }

      console.log(`     📝 Resposta (${text.length} chars): ${text.slice(0, 100)}...`);

      // Com responseMimeType, o text já deve ser JSON puro
      try { return JSON.parse(text); } catch(e) {
        // Tentar extrair JSON
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch(e2) { /* fallback */ }
        }
        console.log("     ↻ JSON inválido, tentando fallback...");
        return await analyzeTicketFallback(info);
      }
    } catch(e) {
      if (attempt === 3) {
        console.error(`  ✗ Erro final: ${e.message}`);
        return { dominio:"Erro", severidade:"Médio", hipotese:"Falha: "+e.message, sql_queries:[], proximos_passos:["Analisar manualmente"], resumo:"Análise falhou" };
      }
      console.log(`     ⚠ Tentativa ${attempt}: ${e.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

// Fallback sem JSON mode — pede JSON no prompt
async function analyzeTicketFallback(info) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${PROMPT}\n\nRespire fundo. Retorne SOMENTE um JSON válido, nada mais.\n\nTICKET: ${info}` }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Fallback ${res.status}`);
  const data = JSON.parse(raw);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  console.log(`     📝 Fallback (${text.length} chars): ${text.slice(0, 100)}...`);
  const clean = text.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("Fallback: JSON não encontrado");
}

function buildTeamsCard(results, dateStr) {
  const c = {"Crítico":0,Alto:0,"Médio":0,Baixo:0};
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
  const body = [
    {type:"TextBlock",text:`🔍 Triagem Automática — ${dateStr}`,weight:"bolder",size:"medium"},
    {type:"TextBlock",text:`🔴 ${c["Crítico"]} Crítico · 🟠 ${c.Alto} Alto · 🟡 ${c["Médio"]} Médio · 🟢 ${c.Baixo} Baixo`,spacing:"small"},
    {type:"TextBlock",text:`Domínios: ${domLine}`,spacing:"small",isSubtle:true,size:"small"},
    {type:"TextBlock",text:"───────────────────",spacing:"medium"},
    {type:"TextBlock",text:lines,wrap:true,spacing:"small",size:"small"},
  ];
  return {type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{$schema:"http://adaptivecards.io/schemas/adaptive-card.json",type:"AdaptiveCard",version:"1.4",body}}]};
}

async function sendTeams(results, dateStr) {
  if (!TEAMS_WEBHOOK) return;
  try { const r = await fetch(TEAMS_WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(buildTeamsCard(results,dateStr))}); console.log(r.ok?"  ✓ Teams":"  ✗ Teams "+r.status); } catch(e) { console.log("  ✗ Teams:",e.message); }
}

async function sendWhatsApp(criticals, dateStr) {
  if (!WA_NUMBERS.length || !criticals.length) return;
  const msg = encodeURIComponent(`⚠️ TRIAGEM ${dateStr}\n${criticals.length} CRÍTICO(S):\n${criticals.map(r=>`🔴 ${r.ticket.id}: ${r.analysis.resumo}`).join("\n")}`);
  for (let i=0;i<WA_NUMBERS.length;i++) {
    const ak=WA_APIKEYS[i]||WA_APIKEYS[0]; if(!ak) continue;
    try { await fetch(`https://api.callmebot.com/whatsapp.php?phone=${WA_NUMBERS[i]}&text=${msg}&apikey=${ak}`); } catch(e) {}
  }
}

async function main() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric",timeZone:"America/Recife"});
  const dateKey = now.toISOString().split("T")[0];

  console.log(`\n${"═".repeat(50)}\n  AGENTE DE TRIAGEM — ${dateStr}\n${"═".repeat(50)}\n`);
  if (!GEMINI_KEY) { console.error("❌ Sem GEMINI_API_KEY"); process.exit(1); }

  await discoverModel();

  console.log("📋 Carregando tickets...");
  const raw = await fbGet("tickets");
  if (!raw) { console.log("  Vazio."); return; }
  const all = Object.entries(raw).map(([k,v])=>({...v,_key:k}));
  const open = all.filter(t=>STATUS_OPEN.includes(t.status));
  console.log(`  ${all.length} total · ${open.length} abertos\n`);
  if (!open.length) { console.log("✅ Bom dia!"); return; }

  const existing = await fbGet(`triagens/${dateKey}`) || {};
  const pending = open.filter(t=>!existing[t._key]);
  console.log(`  ${Object.keys(existing).length} já triados · ${pending.length} pendentes\n`);

  const results = [];
  for (const [k,v] of Object.entries(existing)) { const t=open.find(x=>x._key===k); if(t) results.push({ticket:t,analysis:v}); }

  for (let i=0; i<pending.length; i++) {
    const t = pending[i];
    console.log(`🔍 [${i+1}/${pending.length}] ${t.id} — ${(t.title||"").slice(0,50)}`);
    const analysis = await analyzeTicket(t);
    console.log(`   → ${analysis.severidade} | ${analysis.dominio} | ${analysis.resumo}`);
    try { await fbSet(`triagens/${dateKey}/${t._key}`,{...analysis,ticketId:t.id,analyzedAt:new Date().toISOString()}); } catch(e) {}
    results.push({ticket:t,analysis});
    if (i<pending.length-1) await new Promise(r=>setTimeout(r,2000));
  }

  const crits = results.filter(r=>r.analysis.severidade==="Crítico");
  console.log(`\n${"═".repeat(50)}\n  ${results.length} triados | 🔴 ${crits.length} Críticos\n${"═".repeat(50)}\n`);
  console.log("📨 Notificando...");
  await sendTeams(results, dateStr);
  await sendWhatsApp(crits, dateStr);
  console.log("✅ Concluído!\n");
}

main().catch(e => { console.error("💥",e); process.exit(1); });
