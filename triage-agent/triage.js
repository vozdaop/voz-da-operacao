/**
 * ══════════════════════════════════════════════════════════════
 *  AGENTE DE TRIAGEM AUTOMÁTICA — VOZ DA OPERAÇÃO
 *  Engenharia Logística · Ferreira Costa · CD Cabo
 *  100% GRATUITO — Google Gemini (free tier)
 *  v5 — com retry automático e parser resiliente
 * ══════════════════════════════════════════════════════════════
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://voz-da-operacao-default-rtdb.firebaseio.com";
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || "";
const WA_NUMBERS = (process.env.WHATSAPP_NUMBERS || "").split(",").filter(Boolean);
const WA_APIKEYS = (process.env.WHATSAPP_APIKEYS || "").split(",").filter(Boolean);
const STATUS_OPEN = ["Aberto", "Em andamento", "Pendente", "Aguardando usuario"];

let GEMINI_URL = "";

/* ── Auto-detect modelo ── */
async function discoverModel() {
  console.log("🔎 Descobrindo modelo...");
  const skipWords = ["embedding","tts","image","audio","video","transcribe","veo","lyria","aqa","nano","live","customtools","robotics","computer-use","antigravity","deep-research","native-audio"];
  // Preferência: 3.6 é o recomendado pelo Google, 3.5 como fallback estável
  const prefs = ["gemini-3.6-flash","gemini-3.5-flash","gemini-3.7-flash","gemini-3.8-flash","gemini-3.1-flash-lite"];

  for (const ver of ["v1beta", "v1"]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${GEMINI_KEY}`);
      if (!r.ok) continue;
      const data = await r.json();
      const names = (data.models || []).map(m => m.name.replace("models/",""));

      for (const p of prefs) {
        const match = names.find(n => n.startsWith(p));
        if (match) {
          GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${match}:generateContent?key=${GEMINI_KEY}`;
          console.log(`  ✓ ${match} (${ver})\n`);
          return match;
        }
      }
      // Fallback genérico
      const fb = names.find(n => n.includes("flash") && !skipWords.some(s => n.includes(s)));
      if (fb) {
        GEMINI_URL = `https://generativelanguage.googleapis.com/${ver}/models/${fb}:generateContent?key=${GEMINI_KEY}`;
        console.log(`  ✓ fallback: ${fb} (${ver})\n`);
        return fb;
      }
    } catch(e) { /* next */ }
  }
  console.error("❌ Nenhum modelo encontrado"); process.exit(1);
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

/* ── Chamada Gemini com retry ── */
async function callGemini(prompt, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      });

      if (res.status === 503 || res.status === 429) {
        const wait = attempt * 3000; // 3s, 6s, 9s
        console.log(`     ⏳ Modelo ocupado (${res.status}), tentativa ${attempt}/${maxRetries}, aguardando ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini ${res.status}: ${errText.slice(0,200)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Resposta vazia");
      return text;
    } catch(e) {
      if (attempt === maxRetries) throw e;
      console.log(`     ⚠ Tentativa ${attempt} falhou: ${e.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
}

/* ── Extrair JSON de forma resiliente ── */
function extractJSON(text) {
  // Limpar markdown
  let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  // Tentar parse direto
  try { return JSON.parse(clean); } catch(e) { /* continua */ }

  // Extrair primeiro objeto JSON
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch(e) { /* continua */ }

    // Tentar consertar JSON truncado/malformado
    let fixed = match[0];
    // Fechar arrays abertos
    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
    // Fechar strings abertas
    const quotes = (fixed.match(/"/g) || []).length;
    if (quotes % 2 !== 0) fixed += '"';
    // Fechar objeto
    if (!fixed.endsWith('}')) fixed += '}';
    // Remover trailing commas
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');

    try { return JSON.parse(fixed); } catch(e) { /* desiste */ }
  }

  throw new Error("JSON não extraível da resposta");
}

/* ── Análise de ticket ── */
const WMS_CONTEXT = `Você é um agente de triagem WMS da Ferreira Costa, CD Cabo de Santo Agostinho.

DOMÍNIOS: Via Cega (VCEGA, VCEGA_IT, VCEGA_IT_CONF, WMS_VCEGA_UMA — PKs compostas, sempre COD_EMPRESA no WHERE), Endereçamento (UMAs, blocado dinâmico, piso elevado), Separação (ordens, status 6=cancelado, multivolume), Conferência (reconferência, fracionamento), Estoque (divergências, bloqueio, transferência UMAs, status 2→3), TMS (transporte), Fulfillment (ecommerce).
SCHEMAS: MAXXON, SFC. DB Links: @fcbkp_cab.com, @fcbkp_ObcCabo.com.

Analise o ticket e responda SOMENTE com este JSON (sem texto extra, sem markdown):
{"dominio":"string","severidade":"Crítico|Alto|Médio|Baixo","hipotese":"causa raiz em 1 frase","sql_queries":[{"titulo":"string","query":"SQL Oracle"}],"proximos_passos":["string"],"resumo":"diagnóstico em 1 frase"}`;

async function analyzeTicket(ticket) {
  const ticketInfo = `TICKET: ${ticket.id} | TÍTULO: ${ticket.title} | TIPO: ${ticket.type||"N/A"} | CRITICIDADE: ${ticket.criticality} | STATUS: ${ticket.status} | DESCRIÇÃO: ${ticket.desc||"Sem descrição"} | SOLICITANTE: ${ticket.requester} | DOC: ${ticket.doc||"Nenhum"} | DATA: ${ticket.createdAt}`;

  try {
    const rawText = await callGemini(`${WMS_CONTEXT}\n\n${ticketInfo}`);
    return extractJSON(rawText);
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

  const body = [
    { type:"TextBlock", text:`🔍 Triagem Automática — ${dateStr}`, weight:"bolder", size:"medium" },
    { type:"TextBlock", text:`🔴 ${c["Crítico"]} Crítico · 🟠 ${c.Alto} Alto · 🟡 ${c["Médio"]} Médio · 🟢 ${c.Baixo} Baixo`, spacing:"small" },
    { type:"TextBlock", text:`Domínios: ${domLine}`, spacing:"small", isSubtle:true, size:"small" },
    { type:"TextBlock", text:"───────────────────", spacing:"medium" },
    { type:"TextBlock", text:lines, wrap:true, spacing:"small", size:"small" },
  ];
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

  if (!GEMINI_KEY) { console.error("❌ GEMINI_API_KEY não configurada!"); process.exit(1); }

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
    if (i < pending.length-1) await new Promise(r=>setTimeout(r,2000)); // 2s entre tickets
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
