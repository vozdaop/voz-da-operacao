/**
 * AGENTE DE TRIAGEM — VOZ DA OPERAÇÃO (FINAL)
 * 100% gratuito — Gemini free tier
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://voz-da-operacao-default-rtdb.firebaseio.com";
const TEAMS_WEBHOOK = process.env.TEAMS_WEBHOOK_URL || "";
const WA_NUMBERS = (process.env.WHATSAPP_NUMBERS || "").split(",").filter(Boolean);
const WA_APIKEYS = (process.env.WHATSAPP_APIKEYS || "").split(",").filter(Boolean);
const STATUS_OPEN = ["Aberto","Em andamento","Pendente","Aguardando usuario"];
let GEMINI_URL = "";

async function discoverModel() {
  const skip = ["embedding","tts","image","audio","video","transcribe","veo","lyria","aqa","nano","live","customtools","robotics","computer","antigravity","deep-research","native-audio","preview-tts","clip"];
  const prefs = ["gemini-3.6-flash","gemini-3.5-flash","gemini-3.7-flash","gemini-3.8-flash"];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    if (!r.ok) throw new Error(r.status);
    const names = ((await r.json()).models||[]).map(m=>m.name.replace("models/",""));
    for (const p of prefs) { const m=names.find(n=>n.startsWith(p)); if(m){GEMINI_URL=`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`;console.log(`  ✓ ${m}`);return;} }
    const fb=names.find(n=>n.includes("flash")&&!skip.some(s=>n.includes(s)));
    if(fb){GEMINI_URL=`https://generativelanguage.googleapis.com/v1beta/models/${fb}:generateContent?key=${GEMINI_KEY}`;console.log(`  ✓ ${fb}`);return;}
  } catch(e) { console.log(`  Erro: ${e.message}`); }
  console.error("❌ Sem modelo"); process.exit(1);
}

async function fbGet(p){return(await fetch(`${FIREBASE_URL}/${p}.json`)).json();}
async function fbSet(p,v){await fetch(`${FIREBASE_URL}/${p}.json`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)});}

async function analyzeTicket(ticket) {
  const info = [ticket.id, ticket.title, `Tipo:${ticket.type||"?"}`, `Crit:${ticket.criticality}`, `Status:${ticket.status}`, ticket.desc||"", `De:${ticket.requester}`, `Doc:${ticket.doc||"?"}`, ticket.createdAt].join(" | ");

  const prompt = `Analise este ticket de operação logística WMS (Ferreira Costa, CD Cabo).
Domínios possíveis: Via Cega, Endereçamento, Separação, Conferência, Estoque, TMS, Fulfillment.
Banco Oracle, schemas MAXXON e SFC.

TICKET: ${info}

Retorne um JSON com estes campos:
- dominio: um dos domínios acima
- severidade: Crítico, Alto, Médio ou Baixo
- hipotese: causa raiz provável (1 frase curta)
- sql: uma query SQL Oracle para investigar
- passos: 2 próximos passos concretos separados por ponto-e-vírgula
- resumo: diagnóstico em 1 frase curta`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          contents: [{parts:[{text:prompt}]}],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: "application/json"
          }
        })
      });

      if (res.status === 503 || res.status === 429) {
        console.log(`     ⏳ ${res.status}, aguardando ${attempt*4}s...`);
        await new Promise(r=>setTimeout(r,attempt*4000));
        continue;
      }

      const raw = await res.text();
      if (!res.ok) {
        // Se responseMimeType falhar, tenta sem
        if (raw.includes("responseMimeType")) {
          console.log("     ↻ JSON mode não suportado, tentando sem...");
          return await fallbackAnalysis(prompt);
        }
        throw new Error(`${res.status}: ${raw.slice(0,150)}`);
      }

      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Sem resposta");

      console.log(`     📝 ${text.length} chars`);

      const parsed = JSON.parse(text.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim());

      // Normalizar pro formato padrão
      return {
        dominio: parsed.dominio || "Outro",
        severidade: parsed.severidade || "Médio",
        hipotese: parsed.hipotese || parsed.hipótese || "Não determinada",
        sql_queries: parsed.sql ? [{titulo:"Investigação",query:parsed.sql}] : (parsed.sql_queries||[]),
        proximos_passos: parsed.passos ? parsed.passos.split(";").map(s=>s.trim()) : (parsed.proximos_passos||[]),
        resumo: parsed.resumo || "Sem resumo"
      };

    } catch(e) {
      if (attempt === 3) {
        console.error(`  ✗ ${e.message}`);
        return {dominio:"Erro",severidade:"Médio",hipotese:e.message,sql_queries:[],proximos_passos:["Analisar manualmente"],resumo:"Análise falhou"};
      }
      console.log(`     ⚠ Tentativa ${attempt}: ${e.message.slice(0,80)}`);
      await new Promise(r=>setTimeout(r,attempt*3000));
    }
  }
}

async function fallbackAnalysis(prompt) {
  const res = await fetch(GEMINI_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      contents:[{parts:[{text:prompt+"\n\nIMPORTANTE: retorne SOMENTE o JSON, nada mais."}]}],
      generationConfig:{temperature:0.1,maxOutputTokens:4096}
    })
  });
  const data = await (await res).json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  console.log(`     📝 fallback ${text.length} chars`);
  const match = text.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Fallback sem JSON");
  const p = JSON.parse(match[0]);
  return {
    dominio:p.dominio||"Outro", severidade:p.severidade||"Médio",
    hipotese:p.hipotese||p.hipótese||"?",
    sql_queries:p.sql?[{titulo:"Investigação",query:p.sql}]:(p.sql_queries||[]),
    proximos_passos:p.passos?p.passos.split(";").map(s=>s.trim()):(p.proximos_passos||[]),
    resumo:p.resumo||"?"
  };
}

function buildTeamsCard(results, dateStr) {
  const c={"Crítico":0,Alto:0,"Médio":0,Baixo:0}; const doms={};
  results.forEach(r=>{if(c[r.analysis.severidade]!==undefined)c[r.analysis.severidade]++;doms[r.analysis.dominio]=(doms[r.analysis.dominio]||0)+1;});
  const domLine=Object.entries(doms).sort((a,b)=>b[1]-a[1]).map(([d,n])=>`${d}: ${n}`).join(" · ");
  const ord={"Crítico":0,Alto:1,"Médio":2,Baixo:3,Erro:4};
  const sorted=[...results].sort((a,b)=>(ord[a.analysis.severidade]||4)-(ord[b.analysis.severidade]||4));
  const lines=sorted.slice(0,15).map(r=>{const s=r.analysis.severidade;const e=s==="Crítico"?"🔴":s==="Alto"?"🟠":s==="Médio"?"🟡":"🟢";return`${e} **${r.ticket.id}** — ${r.analysis.resumo}`;}).join("\n\n");
  return{type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{$schema:"http://adaptivecards.io/schemas/adaptive-card.json",type:"AdaptiveCard",version:"1.4",body:[
    {type:"TextBlock",text:`🔍 Triagem — ${dateStr}`,weight:"bolder",size:"medium"},
    {type:"TextBlock",text:`🔴${c["Crítico"]} 🟠${c.Alto} 🟡${c["Médio"]} 🟢${c.Baixo}`,spacing:"small"},
    {type:"TextBlock",text:domLine,spacing:"small",isSubtle:true,size:"small"},
    {type:"TextBlock",text:"─────────────",spacing:"medium"},
    {type:"TextBlock",text:lines,wrap:true,spacing:"small",size:"small"}
  ]}}]};
}

async function main() {
  const now=new Date();
  const dateStr=now.toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric",timeZone:"America/Recife"});
  const dateKey=now.toISOString().split("T")[0];

  console.log(`\n══ AGENTE DE TRIAGEM — ${dateStr} ══\n`);
  if(!GEMINI_KEY){console.error("❌ Sem GEMINI_API_KEY");process.exit(1);}
  await discoverModel();

  const raw=await fbGet("tickets");
  if(!raw){console.log("Vazio.");return;}
  const all=Object.entries(raw).map(([k,v])=>({...v,_key:k}));
  const open=all.filter(t=>STATUS_OPEN.includes(t.status));
  console.log(`\n📋 ${open.length} abertos de ${all.length}\n`);
  if(!open.length){console.log("✅ Bom dia!");return;}

  const existing=await fbGet(`triagens/${dateKey}`)||{};
  const pending=open.filter(t=>!existing[t._key]);
  console.log(`  ${Object.keys(existing).length} já triados · ${pending.length} pendentes\n`);

  const results=[];
  for(const[k,v]of Object.entries(existing)){const t=open.find(x=>x._key===k);if(t)results.push({ticket:t,analysis:v});}

  for(let i=0;i<pending.length;i++){
    const t=pending[i];
    console.log(`🔍 [${i+1}/${pending.length}] ${t.id} — ${(t.title||"").slice(0,50)}`);
    const a=await analyzeTicket(t);
    console.log(`   → ${a.severidade} | ${a.dominio} | ${a.resumo}`);
    try{await fbSet(`triagens/${dateKey}/${t._key}`,{...a,ticketId:t.id,analyzedAt:new Date().toISOString()});}catch(e){}
    results.push({ticket:t,analysis:a});
    if(i<pending.length-1)await new Promise(r=>setTimeout(r,3000));
  }

  const crits=results.filter(r=>r.analysis.severidade==="Crítico");
  console.log(`\n══ ${results.length} triados | 🔴 ${crits.length} Críticos ══\n`);

  if(TEAMS_WEBHOOK){try{const r=await fetch(TEAMS_WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(buildTeamsCard(results,dateStr))});console.log(r.ok?"✓ Teams":"✗ Teams "+r.status);}catch(e){console.log("✗ Teams",e.message);}}
  if(WA_NUMBERS.length&&crits.length){const msg=encodeURIComponent(`⚠️ ${dateStr}\n${crits.length} CRÍTICO(S):\n${crits.map(r=>`🔴${r.ticket.id}: ${r.analysis.resumo}`).join("\n")}`);for(let i=0;i<WA_NUMBERS.length;i++){const ak=WA_APIKEYS[i]||WA_APIKEYS[0];if(ak)try{await fetch(`https://api.callmebot.com/whatsapp.php?phone=${WA_NUMBERS[i]}&text=${msg}&apikey=${ak}`);}catch(e){}}}

  console.log("✅ Concluído!\n");
}

main().catch(e=>{console.error("💥",e);process.exit(1);});
