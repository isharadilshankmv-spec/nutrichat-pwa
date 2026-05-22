import { useState, useRef, useEffect, useCallback } from "react";
import { supabase, supabaseEnabled } from "./supabase";

// ─── Storage ──────────────────────────────────────────────────────────────────
const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)||"null") ?? fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const defaultSettings = () => ({ calGoal:2000, proteinGoal:150, carbsGoal:250, fatGoal:65, theme:"dark", accent:"#c8f06e", name:"Friend" });

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function keyToDisplay(key) {
  const [y,m,d] = key.split("-");
  return new Date(+y,+m-1,+d).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}
function getLast7Keys() {
  return Array.from({length:7},(_,i)=>{
    const d=new Date(); d.setDate(d.getDate()-i);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }).reverse();
}

// ─── AI ───────────────────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-5";
const IS_NATIVE = typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
const API_URL = IS_NATIVE ? "https://nutrichat-pwa.vercel.app/api/chat" : "/api/chat";
const GOOGLE_AUTH_ENABLED = false; // flip to true once Google OAuth is configured in Supabase

const UNIVERSAL_PROMPT = `You are NutriChat — a calorie & macro tracker. The user just told you (by voice or text) about food they ate or their weight.

YOUR JOB: Whenever food is mentioned, ALWAYS return a populated "foods" array with nutritional estimates. NEVER return empty foods when food was mentioned.

EXAMPLES:
- "I had a Big Mac" → {"type":"food","foods":[{"name":"Big Mac","amount":"1 burger","calories":563,"protein":26,"carbs":45,"fat":33}],"text":"a Big Mac","message":"Logging your Big Mac!"}
- "McDonald's Big Mac and a large Coke" → foods: [Big Mac, Large Coke (290 cal)]
- "I weigh 73kg" → {"type":"weight","weightKg":73,"foods":[],"text":"weight: 73kg","message":"Got your weight!"}
- "Chipotle chicken bowl with rice and beans" → use Chipotle's actual menu data

RULES:
- For restaurant chains, use their specific nutritional data (McDonald's, Chipotle, Starbucks, Subway, etc.)
- "a couple of fries" or "some chips" → estimate medium portion
- Weight values: convert from lbs to kg if needed (divide by 2.205)
- For ambiguous voice input ("I had two of them"), make your best guess based on common foods, don't ask for clarification unless truly nothing is identifiable

RESPOND ONLY with valid JSON (NO markdown code blocks, NO extra text):
{
  "type": "food" | "weight" | "both" | "unclear",
  "text": "plain-English summary of what you understood",
  "foods": [{"name":"food name","amount":"serving size","calories":123,"protein":12,"carbs":15,"fat":5}],
  "weightKg": null,
  "message": "Short friendly confirmation.",
  "unclear": false
}

Only set unclear:true if you genuinely cannot identify any food, weight, or intent. Default to food detection when in doubt.`;

const PHOTO_PROMPT = `You are an expert nutritionist. Analyze this food photo, identify all items, estimate portions from visual cues. Respond ONLY with valid JSON (no markdown):
{"foods":[{"name":"food name","amount":"estimated amount","calories":123,"protein":12,"carbs":15,"fat":5}],"message":"Brief description of what you see.","unclear":false}
If not food set unclear:true.`;

async function callClaude(messages, system, maxTokens=1000) {
  let res, data;
  try {
    res = await fetch(API_URL, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model:MODEL, max_tokens:maxTokens, system, messages})
    });
    data = await res.json();
  } catch(networkErr){
    console.error("[NutriChat] Network error:", networkErr);
    throw new Error("Network error — check your connection");
  }

  console.log("[NutriChat] API status:", res.status, "data:", data);

  if(!res.ok || data.error){
    const msg = data?.error?.message || data?.error || `API ${res.status}`;
    throw new Error(msg);
  }
  const raw = data.content?.find(b=>b.type==="text")?.text;
  if(!raw){
    throw new Error("AI returned an empty response");
  }
  // Strip possible markdown fencing
  const cleaned = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try {
    return JSON.parse(cleaned);
  } catch(parseErr){
    console.error("[NutriChat] JSON parse failed. Raw:", raw);
    throw new Error("AI returned invalid format");
  }
}

async function callClaudeText(messages, system, maxTokens=1200) {
  const res = await fetch(API_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({model:MODEL, max_tokens:maxTokens, system, messages})
  });
  const data = await res.json();
  return data.content?.find(b=>b.type==="text")?.text || "";
}

// Reusable voice capture (native plugin or Web Speech API). Calls handlers and
// returns a controller with .stop(). Stops 2.5s after the last word (or 30s cap).
async function captureVoiceOnce({ onStart, onPartial, onFinal, onError }) {
  if (IS_NATIVE) {
    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      const { available } = await SpeechRecognition.available();
      if (!available) { onError?.("Speech recognition not available"); return null; }
      let perm = await SpeechRecognition.checkPermissions();
      if (perm.speechRecognition !== "granted") perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== "granted") { onError?.("Allow microphone access in Settings"); return null; }
      let transcript = "", silence = null, max = null, done = false;
      const finish = async () => {
        if (done) return; done = true;
        clearTimeout(silence); clearTimeout(max);
        try { await SpeechRecognition.stop(); } catch {}
        try { await SpeechRecognition.removeAllListeners(); } catch {}
        onFinal?.(transcript.trim());
      };
      await SpeechRecognition.addListener("partialResults", (data) => {
        const tx = (data.matches?.[0] || "").trim();
        if (tx) { transcript = tx; onPartial?.(tx); clearTimeout(silence); silence = setTimeout(finish, 2500); }
      });
      onStart?.();
      max = setTimeout(finish, 30000);
      await SpeechRecognition.start({ language: "en-US", partialResults: true, popup: false });
      return { stop: finish };
    } catch (err) { onError?.(err?.message || "Voice error"); return null; }
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onError?.("Voice needs Chrome or Safari"); return null; }
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = "en-US";
  let transcript = "", silence = null, max = null;
  r.onstart = () => { onStart?.(); max = setTimeout(() => r.stop(), 30000); };
  r.onresult = (e) => { transcript = Array.from(e.results).map(x => x[0].transcript).join(""); onPartial?.(transcript); clearTimeout(silence); silence = setTimeout(() => r.stop(), 2500); };
  r.onend = () => { clearTimeout(silence); clearTimeout(max); onFinal?.(transcript.trim()); };
  r.onerror = (e) => { clearTimeout(silence); clearTimeout(max); if (e.error !== "no-speech" && e.error !== "aborted") onError?.(e.error); };
  r.start();
  return { stop: () => r.stop() };
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function getTheme(s) {
  const dark = s.theme !== "light";
  return {
    bg:dark?"#0d0d0d":"#f5f5f0", card:dark?"#181818":"#fff",
    card2:dark?"#1f1f1f":"#f0efe8", border:dark?"#272727":"#e0dfd8",
    accent:s.accent||"#c8f06e", accentText:dark?"#000":"#fff",
    text:dark?"#f0f0f0":"#1a1a1a", muted:dark?"#666":"#999",
    protein:"#60a5fa", carbs:"#fb923c", fat:"#f472b6", dark
  };
}

// ─── Components ───────────────────────────────────────────────────────────────
function MacroBar({label,value,max,color,t}) {
  const pct=Math.min((value/(max||1))*100,100);
  const barColor = t.dark ? color : "#1a1a1a"; // black bars in light mode
  return (
    <div style={{marginBottom:7}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
        <span style={{color:t.text,fontWeight:600}}>{label}</span>
        <span style={{color:barColor,fontWeight:600}}>{Math.round(value)}g/{max}g</span>
      </div>
      <div style={{background:t.border,borderRadius:99,height:5,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:barColor,borderRadius:99,transition:"width 0.5s ease"}}/>
      </div>
    </div>
  );
}

function FoodChip({food,t}) {
  return (
    <div style={{background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"6px 10px",fontSize:11,marginTop:6}}>
      <div style={{fontWeight:700,color:t.text,marginBottom:2}}>{food.name} <span style={{color:t.muted,fontWeight:400}}>· {food.amount}</span></div>
      <div style={{display:"flex",gap:8}}>
        <span style={{color:t.accent}}>{food.calories} cal</span>
        <span style={{color:t.protein}}>P {food.protein}g</span>
        <span style={{color:t.carbs}}>C {food.carbs}g</span>
        <span style={{color:t.fat}}>F {food.fat}g</span>
      </div>
    </div>
  );
}

function CalRing({calories,goal,t}) {
  const pct=Math.min(calories/(goal||1),1);
  const r=36, circ=2*Math.PI*r;
  const ringColor = t.dark ? t.accent : "#1a1a1a"; // dark/black ring in light mode
  return (
    <div style={{position:"relative",width:96,height:96,flexShrink:0}}>
      <svg width={96} height={96} style={{transform:"rotate(-90deg)"}}>
        <circle cx={48} cy={48} r={r} fill="none" stroke={t.border} strokeWidth={9}/>
        <circle cx={48} cy={48} r={r} fill="none" stroke={ringColor} strokeWidth={9}
          strokeDasharray={`${pct*circ} ${circ}`} strokeLinecap="round"
          style={{transition:"stroke-dasharray 0.6s ease"}}/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
        <div style={{fontSize:18,fontWeight:800,color:ringColor,lineHeight:1}}>{Math.round(calories)}</div>
        <div style={{fontSize:9,color:t.muted}}>/ {goal} cal</div>
      </div>
    </div>
  );
}

function LoadingDots({t}) {
  return (
    <div style={{display:"flex",justifyContent:"flex-start"}}>
      <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:"18px 18px 18px 4px",padding:"12px 16px"}}>
        <div style={{display:"flex",gap:5}}>
          {[0,1,2].map(d=><div key={d} style={{width:7,height:7,borderRadius:"50%",background:t.accent,animation:"dot 1.2s infinite",animationDelay:`${d*0.2}s`}}/>)}
        </div>
      </div>
    </div>
  );
}

const ACCENTS = ["#c8f06e","#60a5fa","#f472b6","#fb923c","#a78bfa","#34d399","#f87171","#fbbf24"];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [settings, setSettings] = useState(()=>load("nc_settings",defaultSettings()));
  const [allData, setAllData] = useState(()=>load("nc_data",{}));
  const [tab, setTab] = useState("chat");
  const [messages, setMessages] = useState([
    {role:"assistant", text:"Hey! Describe a meal, snap a photo, or say something like \"Chipotle burrito bowl\" — I handle it all 🍽️"}
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [smartLoading, setSmartLoading] = useState(""); // "summary"|"suggest"|""
  const [weeklySummary, setWeeklySummary] = useState("");
  const [mealSuggestions, setMealSuggestions] = useState(null);
  const [calMonth, setCalMonth] = useState(()=>{const d=new Date();return{y:d.getFullYear(),m:d.getMonth()};});
  const [selectedDay, setSelectedDay] = useState(null);
  const fileRef = useRef(null);
  const bottomRef = useRef(null);

  // Native keyboard handling: with resize:"none" the webview never shifts (no black
  // margin / no zoom-stuck). We lift the layout by the keyboard height instead.
  const [kbOffset, setKbOffset] = useState(0);
  useEffect(()=>{
    if(!IS_NATIVE) return;
    let showSub, hideSub;
    (async()=>{
      try {
        const { Keyboard } = await import("@capacitor/keyboard");
        showSub = await Keyboard.addListener("keyboardWillShow", (info)=>setKbOffset(info?.keyboardHeight||0));
        hideSub = await Keyboard.addListener("keyboardWillHide", ()=>setKbOffset(0));
      } catch {}
    })();
    return ()=>{ showSub?.remove?.(); hideSub?.remove?.(); };
  },[]);
  const t = getTheme(settings);
  const today = todayKey();
  const todayFoods = allData[today]?.foods || [];
  const totals = todayFoods.reduce((a,f)=>({
    calories:a.calories+(f.calories||0), protein:a.protein+(f.protein||0),
    carbs:a.carbs+(f.carbs||0), fat:a.fat+(f.fat||0)
  }),{calories:0,protein:0,carbs:0,fat:0});

  const [weightLog, setWeightLog] = useState(()=>load("nc_weight",[]));
  const [weightInput, setWeightInput] = useState("");
  const [foodSearch, setFoodSearch] = useState("");
  const [foodResults, setFoodResults] = useState([]);
  const [foodSearching, setFoodSearching] = useState(false);
  const [chartRange, setChartRange] = useState(30);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState(""); // "" | "listening" | "processing"
  const [liveTranscript, setLiveTranscript] = useState("");
  const recognitionRef = useRef(null);
  const voiceTranscriptRef = useRef("");

  useEffect(()=>{save("nc_weight",weightLog);},[weightLog]);

  const logWeight = ()=>{
    const w = parseFloat(weightInput);
    if(isNaN(w)||w<=0||w>500) return;
    const entry = {date:todayKey(), weight:w, time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})};
    setWeightLog(prev=>{
      const filtered=prev.filter(e=>e.date!==todayKey());
      return [...filtered,entry].sort((a,b)=>a.date.localeCompare(b.date));
    });
    setWeightInput("");
  };

  // ── Food search (Open Food Facts) ──
  const searchFoods = useCallback(async(q)=>{
    setFoodSearch(q);
    if(!q.trim()){setFoodResults([]);return;}
    setFoodSearching(true);
    try {
      const res=await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,brands,serving_size,serving_quantity,nutriments`);
      const data=await res.json();
      const results=(data.products||[])
        .filter(p=>p.product_name&&p.nutriments?.['energy-kcal_100g'])
        .map(p=>{
          const n=p.nutriments,servG=parseFloat(p.serving_quantity)||100,fac=servG/100;
          return {
            name:p.product_name,brand:p.brands,
            amount:p.serving_size||`${servG}g`,
            calories:Math.round((n['energy-kcal_100g']||0)*fac),
            protein:Math.round((n.proteins_100g||0)*fac*10)/10,
            carbs:Math.round((n.carbohydrates_100g||0)*fac*10)/10,
            fat:Math.round((n.fat_100g||0)*fac*10)/10,
          };
        });
      setFoodResults(results);
    } catch {setFoodResults([]);}
    setFoodSearching(false);
  },[]);

  // ── Voice input: native Capacitor plugin or Web Speech API ──
  const startVoiceNative = async ()=>{
    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      const { available } = await SpeechRecognition.available();
      if(!available){
        setMessages(prev=>[...prev,{role:"assistant",text:"Speech recognition not available on this device."}]);
        return;
      }
      let perm = await SpeechRecognition.checkPermissions();
      if(perm.speechRecognition !== "granted") perm = await SpeechRecognition.requestPermissions();
      if(perm.speechRecognition !== "granted"){
        setMessages(prev=>[...prev,{role:"assistant",text:"Please allow microphone and speech access in Settings."}]);
        return;
      }

      voiceTranscriptRef.current = "";
      setLiveTranscript(""); setVoiceStatus("listening"); setIsRecording(true);

      let silenceTimer = null;
      let maxTimer = null;
      let processed = false;

      const cleanupAndProcess = async()=>{
        if(processed) return;
        processed = true;
        clearTimeout(silenceTimer); clearTimeout(maxTimer);
        try { await SpeechRecognition.stop(); } catch {}
        try { await SpeechRecognition.removeAllListeners(); } catch {}
        recognitionRef.current = null;
        setIsRecording(false); setVoiceStatus(""); setLiveTranscript("");
        const text = voiceTranscriptRef.current.trim();
        voiceTranscriptRef.current = "";
        if(!text || loading) return;
        setMessages(prev=>[...prev,{role:"user", text, isVoice:true}]);
        setLoading(true);
        try {
          const parsed = await callClaude([{role:"user",content:text}], buildFoodPrompt());
          dispatchResult(parsed, "voice");
        } catch(err) { setMessages(prev=>[...prev,{role:"assistant",text:`⚠️ ${err.message||"Something went wrong"}. Please try again!`}]); }
        setLoading(false);
      };

      recognitionRef.current = { stop: cleanupAndProcess };

      await SpeechRecognition.addListener("partialResults", (data)=>{
        const text = (data.matches?.[0] || "").trim();
        if(text){
          voiceTranscriptRef.current = text;
          setLiveTranscript(text);
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(cleanupAndProcess, 2500);
        }
      });

      maxTimer = setTimeout(cleanupAndProcess, 30000);
      await SpeechRecognition.start({ language:"en-US", partialResults:true, popup:false });
    } catch(err) {
      console.error("[NutriChat Native Voice]", err);
      setIsRecording(false); setVoiceStatus(""); setLiveTranscript("");
      setMessages(prev=>[...prev,{role:"assistant",text:`Voice error: ${err.message||"unknown"}`}]);
    }
  };

  const startVoice = ()=>{
    if(isRecording){ recognitionRef.current?.stop(); return; }

    if(IS_NATIVE){ startVoiceNative(); return; }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){
      setMessages(prev=>[...prev,{role:"assistant",text:"Voice input needs Chrome or Safari (iOS 14.5+). Try typing instead!"}]);
      return;
    }

    const r = new SR();
    recognitionRef.current = r;
    voiceTranscriptRef.current = "";

    r.continuous = true;     // keep listening through natural pauses
    r.interimResults = true; // show words as they're spoken
    r.lang = "en-US";
    r.maxAlternatives = 1;

    let silenceTimer = null;
    let maxTimer = null;

    const stopNow = ()=>{ clearTimeout(silenceTimer); clearTimeout(maxTimer); r.stop(); };

    r.onstart = ()=>{
      setIsRecording(true); setVoiceStatus("listening"); setLiveTranscript("");
      maxTimer = setTimeout(stopNow, 30000); // 30s hard cap
    };

    r.onresult = (e)=>{
      const transcript = Array.from(e.results).map(x=>x[0].transcript).join("");
      voiceTranscriptRef.current = transcript;
      setLiveTranscript(transcript);
      // Reset the silence countdown on every new word — stops 2.5s after last word
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(stopNow, 2500);
    };

    r.onend = async()=>{
      clearTimeout(silenceTimer); clearTimeout(maxTimer);
      setIsRecording(false); setVoiceStatus(""); setLiveTranscript("");
      const text = voiceTranscriptRef.current.trim();
      voiceTranscriptRef.current = "";
      if(!text || loading) return;

      setMessages(prev=>[...prev,{role:"user", text, isVoice:true}]);
      setLoading(true);
      try {
        const parsed = await callClaude([{role:"user",content:text}], buildFoodPrompt());
        dispatchResult(parsed, "voice");
      } catch(err) { setMessages(prev=>[...prev,{role:"assistant",text:`⚠️ ${err.message||"Something went wrong"}. Please try again!`}]); }
      setLoading(false);
    };

    r.onerror = (e)=>{
      clearTimeout(silenceTimer); clearTimeout(maxTimer);
      setIsRecording(false); setVoiceStatus(""); setLiveTranscript("");
      voiceTranscriptRef.current = "";
      if(e.error!=="no-speech" && e.error!=="aborted"){
        setMessages(prev=>[...prev,{role:"assistant",text:`Mic error: ${e.error}. Please allow microphone access and try again.`}]);
      }
    };

    r.start();
  };

  const [reminders, setReminders] = useState(()=>load("nc_reminders",{
    breakfast: {enabled:false, time:"08:00"},
    lunch:     {enabled:false, time:"12:30"},
    dinner:    {enabled:false, time:"19:00"},
    protein:   {enabled:false},
  }));
  const [notifPerm, setNotifPerm] = useState(()=>typeof Notification!=="undefined"?Notification.permission:"unsupported");
  const reminderTimersRef = useRef([]);
  const proteinIntervalRef = useRef(null);

  useEffect(()=>{save("nc_reminders",reminders);},[reminders]);

  // Schedule meal reminders
  useEffect(()=>{
    reminderTimersRef.current.forEach(clearTimeout);
    reminderTimersRef.current=[];
    if(notifPerm!=="granted") return;
    const meals=[
      {key:"breakfast", label:"Breakfast 🍳", body:"Time to log your breakfast!"},
      {key:"lunch",     label:"Lunch 🥗",     body:"Don't forget to log your lunch!"},
      {key:"dinner",    label:"Dinner 🍽️",    body:"Time to log your dinner!"},
    ];
    meals.forEach(({key,label,body})=>{
      const r=reminders[key];
      if(!r?.enabled) return;
      const [h,m]=r.time.split(":").map(Number);
      const now=new Date();
      const next=new Date(now.getFullYear(),now.getMonth(),now.getDate(),h,m,0,0);
      if(next<=now) next.setDate(next.getDate()+1);
      const tid=setTimeout(()=>{
        new Notification(`NutriChat — ${label}`,{body,icon:"/icon-192.png"});
        setReminders(prev=>({...prev})); // retrigger for next day
      }, next-now);
      reminderTimersRef.current.push(tid);
    });
  },[reminders,notifPerm]);

  // Protein hourly reminder (5am–9pm)
  useEffect(()=>{
    if(proteinIntervalRef.current) clearInterval(proteinIntervalRef.current);
    if(notifPerm!=="granted"||!reminders.protein?.enabled) return;
    const fireIfActive=()=>{
      const h=new Date().getHours();
      if(h<5||h>=21) return; // silent 9pm–5am
      const proteinSoFar=Math.round(totals.protein);
      const goal=settings.proteinGoal;
      const pct=Math.round((proteinSoFar/goal)*100);
      new Notification("NutriChat — Protein Check 💪",{
        body: proteinSoFar>=goal
          ? `Goal hit! You've had ${proteinSoFar}g of protein today 🎉`
          : `${proteinSoFar}g / ${goal}g protein so far (${pct}%). Keep it up!`,
        icon:"/icon-192.png"
      });
    };
    // fire at next top of hour
    const now=new Date();
    const msToNextHour=(60-now.getMinutes())*60000-(now.getSeconds()*1000);
    const initTid=setTimeout(()=>{
      fireIfActive();
      proteinIntervalRef.current=setInterval(fireIfActive,3600000);
    },msToNextHour);
    reminderTimersRef.current.push(initTid);
    return ()=>{ if(proteinIntervalRef.current) clearInterval(proteinIntervalRef.current); };
  },[reminders.protein,notifPerm,totals.protein,settings.proteinGoal]);

  const requestNotifPerm = async()=>{
    if(typeof Notification==="undefined"){setNotifPerm("unsupported");return;}
    const p=await Notification.requestPermission();
    setNotifPerm(p);
  };
  const updReminder=(key,patch)=>setReminders(prev=>({...prev,[key]:{...prev[key],...patch}}));

  // ── SMS Reminders (Twilio) ──
  const [smsConfig, setSmsConfig] = useState(()=>load("nc_sms",{phone:"",enabled:false}));
  const [smsSaving, setSmsSaving] = useState(false);
  const [smsStatus, setSmsStatus] = useState("");
  useEffect(()=>{save("nc_sms",smsConfig);},[smsConfig]);

  const saveSmsConfig = async()=>{
    if(!smsConfig.phone||smsConfig.phone.trim().length<8){setSmsStatus("Enter a valid phone number (with country code, e.g. +14155551234)");return;}
    setSmsSaving(true); setSmsStatus("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const body = { phone: smsConfig.phone.trim(), timezone: tz, reminders: smsConfig.enabled ? reminders : {} };
      const r = await fetch("https://nutrichat-pwa.vercel.app/api/save-reminders", {
        method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error||"Save failed");
      setSmsStatus("✓ Saved! Reminders synced to the cron server.");
    } catch(err){ setSmsStatus(`⚠️ ${err.message}`); }
    setSmsSaving(false);
  };

  const sendTestSms = async()=>{
    if(!smsConfig.phone||smsConfig.phone.trim().length<8){setSmsStatus("Enter a phone number first");return;}
    setSmsSaving(true); setSmsStatus("Sending test SMS…");
    try {
      const r = await fetch("https://nutrichat-pwa.vercel.app/api/test-sms",{
        method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({phone:smsConfig.phone.trim()})
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error||"Send failed");
      setSmsStatus("✓ Test SMS sent! Check your phone.");
    } catch(err){ setSmsStatus(`⚠️ ${err.message}`); }
    setSmsSaving(false);
  };

  // ── Siri hands-free logging ──
  const [siriKey] = useState(()=>{
    let k=localStorage.getItem("nc_siri_key");
    if(!k){ k=(typeof crypto!=="undefined"&&crypto.randomUUID)?crypto.randomUUID():(Math.random().toString(36).slice(2)+Date.now().toString(36)); localStorage.setItem("nc_siri_key",k); }
    return k;
  });
  const [siriBusy, setSiriBusy] = useState(false);
  const [siriStatus, setSiriStatus] = useState("");
  const linkSiri = async()=>{
    if(!supabaseEnabled){ setSiriStatus("⚠️ Sign in first to link Siri."); return; }
    setSiriBusy(true); setSiriStatus("");
    try {
      const { data:{ session } } = await supabase.auth.getSession();
      if(!session){ setSiriStatus("⚠️ Please sign in first."); setSiriBusy(false); return; }
      const r = await fetch("https://nutrichat-pwa.vercel.app/api/siri",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ action:"register", key:siriKey, accessToken:session.access_token, refreshToken:session.refresh_token, timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC") })
      });
      const d = await r.json();
      if(!r.ok) throw new Error(d.error||"Link failed");
      setSiriStatus("✓ Siri linked to your account! Set up the Shortcut below (one time).");
    } catch(err){ setSiriStatus(`⚠️ ${err.message}`); }
    setSiriBusy(false);
  };

  const remaining = {
    calories: Math.max(0, settings.calGoal - totals.calories),
    protein: Math.max(0, settings.proteinGoal - totals.protein),
    carbs: Math.max(0, settings.carbsGoal - totals.carbs),
    fat: Math.max(0, settings.fatGoal - totals.fat),
  };

  useEffect(()=>{save("nc_data",allData);},[allData]);
  useEffect(()=>{save("nc_settings",settings);},[settings]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  // ── Remembered foods — the app learns your usual items so the AI reuses them ──
  const [knownFoods, setKnownFoods] = useState(()=>load("nc_known_foods",{}));
  const knownFoodsRef = useRef(knownFoods);
  useEffect(()=>{ knownFoodsRef.current = knownFoods; save("nc_known_foods", knownFoods); },[knownFoods]);
  const recordFoods = useCallback((foods)=>{
    if(!Array.isArray(foods)||!foods.length) return;
    setKnownFoods(prev=>{
      const next={...prev};
      for(const f of foods){
        if(!f?.name||typeof f.calories!=="number") continue;
        const key=f.name.trim().toLowerCase();
        next[key]={ name:f.name, amount:f.amount||"1 serving", calories:f.calories, protein:f.protein||0, carbs:f.carbs||0, fat:f.fat||0, count:(prev[key]?.count||0)+1 };
      }
      return next;
    });
  },[]);
  // System prompt augmented with the user's frequent foods (read via ref so it's always current)
  function buildFoodPrompt(){
    const top=Object.values(knownFoodsRef.current||{}).sort((a,b)=>(b.count||0)-(a.count||0)).slice(0,25);
    if(!top.length) return UNIVERSAL_PROMPT;
    const list=top.map(f=>`- ${f.name} (${f.amount}): ${f.calories} cal, P${f.protein} C${f.carbs} F${f.fat}`).join("\n");
    return UNIVERSAL_PROMPT+`\n\nUSER'S FREQUENT FOODS — if the user mentions one of these (or an obvious match/abbreviation), REUSE these exact numbers instead of estimating:\n${list}`;
  }

  const addFoods = useCallback((foods)=>{
    const time=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    recordFoods(foods);
    setAllData(prev=>{
      const day=prev[today]||{foods:[]};
      return {...prev,[today]:{...day,foods:[...day.foods,...foods.map(f=>({...f,time}))]}};
    });
  },[today,recordFoods]);

  // Add foods to a SPECIFIC date (used by the calendar day add).
  const addFoodsToDate = useCallback((foods, dateKey)=>{
    const time=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    recordFoods(foods);
    setAllData(prev=>{
      const day=prev[dateKey]||{foods:[]};
      return {...prev,[dateKey]:{...day,foods:[...day.foods,...foods.map(f=>({...f,time}))]}};
    });
  },[recordFoods]);

  // ── Calendar day add (voice or text → that date) ──
  const [dayAddText, setDayAddText] = useState("");
  const [dayAddLoading, setDayAddLoading] = useState(false);
  const [dayAddStatus, setDayAddStatus] = useState("");
  const [dayVoiceActive, setDayVoiceActive] = useState(false);
  const [dayVoiceTranscript, setDayVoiceTranscript] = useState("");
  const [dayPending, setDayPending] = useState(null); // {foods, text} awaiting confirm
  const dayVoiceCtrlRef = useRef(null);
  // Reset the day-add box whenever you switch to a different date
  useEffect(()=>{ setDayPending(null); setDayAddStatus(""); setDayAddText(""); },[selectedDay]);

  const addToDay = useCallback(async(text)=>{
    const t=(text||"").trim();
    if(!t) return;
    setDayAddLoading(true); setDayAddStatus(""); setDayPending(null);
    try {
      const parsed = await callClaude([{role:"user",content:t}], buildFoodPrompt());
      const type = parsed.type || "food";
      if(!parsed.unclear && parsed.foods?.length && (type==="food"||type==="both")){
        // Hold for confirmation instead of adding immediately
        setDayPending({ foods: parsed.foods, text: parsed.text || t });
        setDayAddText("");
      } else {
        setDayAddStatus(parsed.message || "Couldn't find a food in that — try again.");
      }
    } catch(err){ setDayAddStatus(`⚠️ ${err.message||"Something went wrong"}`); }
    setDayAddLoading(false);
  },[]);

  const confirmDayFoods = useCallback((dateKey)=>{
    if(!dayPending?.foods?.length || !dateKey) return;
    addFoodsToDate(dayPending.foods, dateKey);
    setDayAddStatus(`✅ Added to ${keyToDisplay(dateKey)}`);
    setDayPending(null);
  },[dayPending, addFoodsToDate]);

  const cancelDayFoods = useCallback(()=>{
    setDayPending(null);
    setDayAddStatus("No worries — tell me again.");
  },[]);

  const startDayVoice = useCallback(async(dateKey)=>{
    if(dayVoiceActive){ dayVoiceCtrlRef.current?.stop?.(); return; }
    setDayVoiceTranscript(""); setDayAddStatus("");
    dayVoiceCtrlRef.current = await captureVoiceOnce({
      onStart: ()=>setDayVoiceActive(true),
      onPartial: (tx)=>setDayVoiceTranscript(tx),
      onFinal: (tx)=>{ setDayVoiceActive(false); setDayVoiceTranscript(""); dayVoiceCtrlRef.current=null; if(tx) addToDay(tx); },
      onError: (msg)=>{ setDayVoiceActive(false); setDayVoiceTranscript(""); setDayAddStatus(`⚠️ ${msg}`); },
    });
  },[dayVoiceActive, addToDay]);

  const dispatchResult = useCallback((parsed, source="text")=>{
    if(parsed.unclear){
      setMessages(prev=>[...prev,{role:"assistant",text:parsed.message||"Could you be more specific?"}]);
      return;
    }
    const type = parsed.type || "food";
    const isFood = (type==="food"||type==="both") && parsed.foods?.length;
    // Typed text adds immediately; voice/photo/barcode ask for confirmation first
    const needsConfirm = isFood && source!=="text";

    if(isFood && !needsConfirm) addFoods(parsed.foods);

    // Weight always logged immediately
    if((type==="weight"||type==="both") && parsed.weightKg){
      const w = parseFloat(parsed.weightKg);
      if(!isNaN(w) && w>0 && w<500){
        const entry={date:todayKey(),weight:+w.toFixed(1),time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})};
        setWeightLog(prev=>[...prev.filter(e=>e.date!==todayKey()),entry].sort((a,b)=>a.date.localeCompare(b.date)));
      }
    }
    setMessages(prev=>[...prev,{
      role:"assistant",
      text: needsConfirm
        ? `${parsed.text||parsed.message||"Here's what I found"}\n\nAdd this to your diary?`
        : parsed.message||"Got it!",
      foods: isFood ? parsed.foods : null,
      weightLogged:(type==="weight"||type==="both")?parsed.weightKg:null,
      pendingConfirm: needsConfirm,
    }]);
  },[addFoods, today]);

  const confirmFoods = useCallback((foods)=>{
    addFoods(foods);
    setMessages(prev=>{
      const updated=[...prev];
      for(let i=updated.length-1;i>=0;i--){
        if(updated[i].pendingConfirm){
          updated[i]={...updated[i],pendingConfirm:false,text:`✅ Added to your diary!`};
          break;
        }
      }
      return updated;
    });
  },[addFoods]);

  const cancelFoods = useCallback(()=>{
    setMessages(prev=>{
      const updated=[...prev];
      for(let i=updated.length-1;i>=0;i--){
        if(updated[i].pendingConfirm){
          updated[i]={...updated[i],pendingConfirm:false,text:"No problem! Tell me what you actually had."};
          break;
        }
      }
      return updated;
    });
  },[]);

  // ── Send text ──
  const sendText = async()=>{
    const text=input.trim(); if(!text||loading) return;
    setInput(""); setMessages(prev=>[...prev,{role:"user",text}]); setLoading(true);
    try {
      const parsed = await callClaude([{role:"user",content:text}], buildFoodPrompt());
      dispatchResult(parsed);
    } catch(err) { setMessages(prev=>[...prev,{role:"assistant",text:`⚠️ ${err.message||"Something went wrong"}. Please try again!`}]); }
    setLoading(false);
  };

  // ── Photo ──
  const sendPhoto = async(file)=>{
    if(!file||loading) return; setLoading(true);
    const reader=new FileReader();
    reader.onload=async(e)=>{
      const b64=e.target.result.split(",")[1];
      const preview=e.target.result;
      setMessages(prev=>[...prev,{role:"user",text:"📸 Photo uploaded",imagePreview:preview}]);
      try {
        const parsed=await callClaude([{role:"user",content:[
          {type:"image",source:{type:"base64",media_type:file.type||"image/jpeg",data:b64}},
          {type:"text",text:"Analyze this food photo and estimate nutritional content."}
        ]}],PHOTO_PROMPT);
        dispatchResult(parsed,"photo");
      } catch { setMessages(prev=>[...prev,{role:"assistant",text:"Couldn't analyze photo. Try again!"}]); }
      setLoading(false);
    };
    reader.readAsDataURL(file);
  };

  // ── AI Weekly Summary ──
  const generateWeeklySummary = async()=>{
    setSmartLoading("summary"); setWeeklySummary("");
    const keys=getLast7Keys();
    const weekData=keys.map(k=>{
      const foods=allData[k]?.foods||[];
      const tot=foods.reduce((a,f)=>({cal:a.cal+(f.calories||0),p:a.p+(f.protein||0),c:a.c+(f.carbs||0),f:a.f+(f.fat||0)}),{cal:0,p:0,c:0,f:0});
      return {date:keyToDisplay(k), calories:Math.round(tot.cal), protein:Math.round(tot.p), carbs:Math.round(tot.c), fat:Math.round(tot.f), entries:foods.length};
    });
    const sys=`You are a supportive and knowledgeable nutrition coach. Analyze the user's weekly food tracking data and give them a warm, insightful summary. Include: overall calorie trend, protein consistency, best day, areas to improve, and 2-3 specific actionable tips. Be encouraging, specific, and conversational. 2-3 short paragraphs max. No bullet points. Use the user's name if provided.`;
    const prompt=`My name is ${settings.name}. My goals: ${settings.calGoal} cal, ${settings.proteinGoal}g protein, ${settings.carbsGoal}g carbs, ${settings.fatGoal}g fat per day.\n\nHere's my last 7 days:\n${weekData.map(d=>`${d.date}: ${d.calories} cal, P${d.protein}g, C${d.carbs}g, F${d.fat}g (${d.entries} entries logged)`).join("\n")}\n\nPlease give me a weekly summary and tips.`;
    try {
      const text=await callClaudeText([{role:"user",content:prompt}],sys,1200);
      setWeeklySummary(text);
    } catch { setWeeklySummary("Couldn't generate summary. Try again!"); }
    setSmartLoading("");
  };

  // ── AI Meal Suggestions ──
  const generateMealSuggestions = async()=>{
    setSmartLoading("suggest"); setMealSuggestions(null);
    const sys=`You are a meal planning expert. Based on the user's remaining macro budget for the day, suggest 3 meal or snack ideas that would fit well. Respond ONLY with valid JSON (no markdown):
{"suggestions":[{"name":"meal name","description":"1 short sentence","calories":300,"protein":25,"carbs":30,"fat":8,"emoji":"🥗"}]}
Make meals practical, delicious, and varied. Fit within the remaining budget but don't need to be exact.`;
    const prompt=`My remaining macro budget today:
Calories: ${Math.round(remaining.calories)} kcal
Protein: ${Math.round(remaining.protein)}g  
Carbs: ${Math.round(remaining.carbs)}g
Fat: ${Math.round(remaining.fat)}g

Suggest 3 meals or snacks that fit this budget. Consider it's ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}.`;
    try {
      const parsed=await callClaude([{role:"user",content:prompt}],sys);
      setMealSuggestions(parsed.suggestions||[]);
    } catch { setMealSuggestions([]); }
    setSmartLoading("");
  };

  // ── Log suggested meal ──
  const logSuggestion = (s)=>{
    addFoods([{name:s.name,amount:"1 serving",calories:s.calories,protein:s.protein,carbs:s.carbs,fat:s.fat}]);
    setMessages(prev=>[...prev,{role:"assistant",text:`Logged ${s.emoji} ${s.name}! (+${s.calories} cal)`}]);
    setTab("chat");
  };

  // ── Barcode state ──
  const [barcodeActive, setBarcodeActive] = useState(false);
  const [barcodeStatus, setBarcodeStatus] = useState("");
  const barcodeVideoRef = useRef(null);
  const barcodeControlsRef = useRef(null);

  // ── Body fat state ──
  const [bodyFatLog, setBodyFatLog] = useState(()=>load("nc_bodyfat",[]).filter(e=>typeof e.bodyFat==="number"&&e.bodyFat>0));
  const [bodyFatLoading, setBodyFatLoading] = useState(false);
  const [bodyFatResult, setBodyFatResult] = useState(null);
  const bodyFatFileRef = useRef(null);
  useEffect(()=>{save("nc_bodyfat",bodyFatLog);},[bodyFatLog]);

  // ── Auth + cloud sync (Supabase) ──
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!supabaseEnabled); // if no Supabase, skip auth
  const [cloudLoaded, setCloudLoaded] = useState(!supabaseEnabled);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState("signin"); // "signin" | "signup"
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const cloudSyncTimer = useRef(null);

  // Detect existing session + subscribe to auth changes
  useEffect(()=>{
    if(!supabaseEnabled) return;
    supabase.auth.getSession().then(({data})=>{ setSession(data.session); setAuthReady(true); });
    const { data:sub } = supabase.auth.onAuthStateChange((_e, sess)=>{
      setSession(sess);
      if(!sess) setCloudLoaded(false);
    });
    return ()=>sub.subscription.unsubscribe();
  },[]);

  // On login, pull this account's cloud data (fresh start if none yet)
  useEffect(()=>{
    if(!supabaseEnabled || !session){ return; }
    let cancelled = false;
    (async()=>{
      const { data } = await supabase.from("user_state")
        .select("data, settings, weight, bodyfat")
        .eq("user_id", session.user.id).maybeSingle();
      if(cancelled) return;
      if(data){
        setAllData(data.data || {});
        if(data.settings) setSettings(s=>({...s, ...data.settings}));
        setWeightLog(Array.isArray(data.weight)?data.weight:[]);
        setBodyFatLog(Array.isArray(data.bodyfat)?data.bodyfat:[]);
      } else {
        // New account → start empty (per fresh-start choice)
        setAllData({}); setWeightLog([]); setBodyFatLog([]);
      }
      setCloudLoaded(true);
    })();
    return ()=>{ cancelled = true; };
  },[session]);

  // Debounced push to cloud whenever synced data changes
  useEffect(()=>{
    if(!supabaseEnabled || !session || !cloudLoaded) return;
    clearTimeout(cloudSyncTimer.current);
    cloudSyncTimer.current = setTimeout(()=>{
      supabase.from("user_state").upsert({
        user_id: session.user.id,
        data: allData, settings, weight: weightLog, bodyfat: bodyFatLog,
        updated_at: new Date().toISOString(),
      }).then(({error})=>{ if(error) console.error("[NutriChat sync]", error.message); });
    }, 1500);
    return ()=>clearTimeout(cloudSyncTimer.current);
  },[allData, settings, weightLog, bodyFatLog, session, cloudLoaded]);

  const signInEmail = async()=>{
    if(!authEmail || !authPassword){ setAuthError("Enter email and password"); return; }
    setAuthBusy(true); setAuthError("");
    try {
      const creds = { email: authEmail.trim().toLowerCase(), password: authPassword };
      const { data, error } = authMode==="signup"
        ? await supabase.auth.signUp(creds)
        : await supabase.auth.signInWithPassword(creds);
      if(error){
        console.error("[NutriChat auth]", error);
        setAuthError(error.message);
      } else if(authMode==="signup" && !data?.session){
        setAuthError("Account created! Check your email to confirm, then tap Sign in.");
      }
      // On success with a session, onAuthStateChange logs the user in automatically.
    } catch(err){
      console.error("[NutriChat auth]", err);
      setAuthError(err?.message || "Sign-in failed. Try again.");
    }
    setAuthBusy(false);
  };

  const signInGoogle = async()=>{
    if(!GOOGLE_AUTH_ENABLED){
      setAuthError("Google sign-in is being set up — please use email for now.");
      return;
    }
    setAuthBusy(true); setAuthError("");
    try {
      const redirectTo = IS_NATIVE ? "com.nutrichat.app://login-callback" : window.location.origin;
      const { error } = await supabase.auth.signInWithOAuth({ provider:"google", options:{ redirectTo } });
      if(error){ console.error("[NutriChat google]", error); setAuthError(error.message); setAuthBusy(false); }
    } catch(err){ setAuthError(err?.message||"Google sign-in failed"); setAuthBusy(false); }
  };

  const signOut = async()=>{
    if(supabaseEnabled) await supabase.auth.signOut();
    setSession(null); setCloudLoaded(false);
  };

  // ── Barcode scanner (ZXing + Open Food Facts) ──
  const startBarcode = async()=>{
    setBarcodeActive(true); setBarcodeStatus("Starting camera...");
    try {
      const {BrowserMultiFormatReader} = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      let foundBarcode = false;
      const controls = await reader.decodeFromVideoDevice(null, barcodeVideoRef.current, async(result, err)=>{
        if(!result || foundBarcode) return;
        foundBarcode = true;
        controls?.stop();
        const code = result.getText();
        setBarcodeStatus(`Found barcode ${code} — looking up product...`);
        try {
          // Look up via our backend proxy (handles User-Agent + AU database fallback)
          const res = await fetch(`https://nutrichat-pwa.vercel.app/api/barcode?code=${encodeURIComponent(code)}`);
          const data = await res.json();
          if(data.found && data.food){
            stopBarcode(); setTab("chat");
            // Ask for confirmation before adding (consistent with voice/photo)
            setMessages(prev=>[...prev,{role:"assistant",text:`🔍 Scanned: ${data.food.name}\n\nAdd this to your diary?`,foods:[data.food],pendingConfirm:true}]);
          } else {
            setBarcodeStatus(`Barcode ${code} isn't in the food database. Tip: close this and just describe it in chat (e.g. "Tim Tams, 2 biscuits") or snap a photo.`);
            foundBarcode = false; // allow retry
          }
        } catch { setBarcodeStatus("Lookup failed — check your connection and try again."); foundBarcode=false; }
      });
      barcodeControlsRef.current = controls;
    } catch(e) { setBarcodeStatus("Camera access denied."); setBarcodeActive(false); }
  };

  const stopBarcode = ()=>{
    barcodeControlsRef.current?.stop();
    barcodeControlsRef.current = null;
    if(barcodeVideoRef.current?.srcObject){
      barcodeVideoRef.current.srcObject.getTracks().forEach(t=>t.stop());
      barcodeVideoRef.current.srcObject = null;
    }
    setBarcodeActive(false); setBarcodeStatus("");
  };

  // ── Body fat estimator ──
  const BODY_FAT_RULES = `You are an expert body composition analyst. You will estimate body fat percentage from a photo.

STRICT CONSISTENCY RULES — apply these the same way every single time:
1. The person is wearing underwear only. Estimate based on visible muscle definition, fat distribution around abdomen, waist, chest, hips, and thighs.
2. Use the US Navy / visual estimation method. Anchor your estimate to these visual markers:
   - ~6-9%: Visible abs, clear muscle separation, veins on arms and abs
   - ~10-14%: Abs visible, some definition, slight waist
   - ~15-19%: Soft abs, some definition, noticeable waist
   - ~20-24%: No visible abs, soft midsection, some roundness
   - ~25-29%: Significant softness, belly protrudes, limited muscle outline
   - ~30%+: Significant fat covering most muscle
3. Give a single number (not a range). Round to nearest 0.5%.
4. Be consistent — the same body should get the same number across photos.
5. Do NOT adjust based on lighting flattery. Be objective and honest.

Respond ONLY with valid JSON:
{"bodyFat": 18.5, "category": "Fitness|Average|Obese|Athletic|Essential Fat", "notes": "2-3 sentence honest description of what you see and how you arrived at the number.", "confidence": "high|medium|low"}
If image is not suitable (not a person, fully clothed, too dark): {"bodyFat": null, "notes": "Reason why estimate isn't possible.", "confidence": "none"}`;

  const analyseBodyFat = (file)=>{
    if(!file) return;
    setBodyFatLoading(true); setBodyFatResult(null);
    const reader = new FileReader();
    reader.onload = async(e)=>{
      const b64 = e.target.result.split(",")[1];
      const preview = e.target.result;
      try {
        const res = await fetch(API_URL,{
          method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({model:MODEL,max_tokens:600,
            system:BODY_FAT_RULES,
            messages:[{role:"user",content:[
              {type:"image",source:{type:"base64",media_type:file.type||"image/jpeg",data:b64}},
              {type:"text",text:"Please estimate my body fat percentage from this photo using your strict consistency rules."}
            ]}]})
        });
        const data = await res.json();
        console.log("[NutriChat BF] status:", res.status, "data:", data);
        if(!res.ok || data.error){
          const msg = data?.error?.message || data?.error || `API ${res.status}`;
          setBodyFatResult({bodyFat:null,notes:`⚠️ ${msg}`,confidence:"none"});
          setBodyFatLoading(false); return;
        }
        const raw = data.content?.find(b=>b.type==="text")?.text;
        if(!raw){
          setBodyFatResult({bodyFat:null,notes:"AI returned an empty response. Try again.",confidence:"none"});
          setBodyFatLoading(false); return;
        }
        const cleaned = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
        let parsed;
        try { parsed = JSON.parse(cleaned); }
        catch {
          console.error("[NutriChat BF] parse failed. Raw:", raw);
          setBodyFatResult({bodyFat:null,notes:"Couldn't parse AI response. Try a clearer photo.",confidence:"none"});
          setBodyFatLoading(false); return;
        }
        if(typeof parsed.bodyFat === "number" && parsed.bodyFat > 0){
          const entry={date:todayKey(),time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),bodyFat:parsed.bodyFat,category:parsed.category||"",notes:parsed.notes||"",confidence:parsed.confidence||"medium",preview};
          setBodyFatLog(prev=>[...prev,entry]);
        }
        setBodyFatResult(parsed);
      } catch(err) { setBodyFatResult({bodyFat:null,notes:`⚠️ ${err.message||"Analysis failed"}. Try again.`,confidence:"none"}); }
      setBodyFatLoading(false);
    };
    reader.readAsDataURL(file);
  };
  const getDaysInMonth=(y,m)=>new Date(y,m+1,0).getDate();
  const getFirstDay=(y,m)=>new Date(y,m,1).getDay();
  const mkKey=(y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const getDayTotals=(key)=>(allData[key]?.foods||[]).reduce((a,f)=>({cal:a.cal+(f.calories||0),p:a.p+(f.protein||0),c:a.c+(f.carbs||0),f:a.f+(f.fat||0)}),{cal:0,p:0,c:0,f:0});

  const upd=(k,v)=>setSettings(s=>({...s,[k]:v}));
  const iStyle={background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 14px",color:t.text,fontSize:16,outline:"none",width:"100%",fontFamily:"inherit"};
  const sdTotals=selectedDay?getDayTotals(selectedDay):null;
  const sdFoods=selectedDay?(allData[selectedDay]?.foods||[]):[];

  // ── Auth gate ──
  if(supabaseEnabled && (!authReady || (session && !cloudLoaded))){
    return (
      <div style={{background:t.bg,height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:t.text,fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:30,fontWeight:800,marginBottom:10}}>Nutri<span style={{color:t.accent}}>Chat</span></div>
          <div style={{color:t.muted,fontSize:14}}>{!authReady?"Loading…":"Syncing your data…"}</div>
        </div>
      </div>
    );
  }
  if(supabaseEnabled && !session){
    return (
      <div style={{background:t.bg,height:"100%",overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,color:t.text,fontFamily:"'DM Sans','Segoe UI',sans-serif",width:"100%",maxWidth:420,margin:"0 auto"}}>
        <div style={{fontSize:34,fontWeight:800,marginBottom:6}}>Nutri<span style={{color:t.accent}}>Chat</span></div>
        <div style={{color:t.muted,fontSize:14,marginBottom:28,textAlign:"center"}}>Your AI calorie & macro tracker</div>

        <div style={{width:"100%",background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:20}}>
          <div style={{fontWeight:800,fontSize:18,marginBottom:16}}>{authMode==="signup"?"Create your account":"Welcome back"}</div>

          <input type="email" placeholder="Email" value={authEmail} autoCapitalize="none" autoCorrect="off"
            onChange={e=>setAuthEmail(e.target.value)}
            style={{width:"100%",background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 14px",color:t.text,fontSize:15,outline:"none",marginBottom:10,boxSizing:"border-box"}}/>
          <div style={{position:"relative",marginBottom:14}}>
            <input type={showPassword?"text":"password"} placeholder="Password" value={authPassword}
              autoCapitalize="none" autoCorrect="off"
              onChange={e=>setAuthPassword(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")signInEmail();}}
              style={{width:"100%",background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"12px 44px 12px 14px",color:t.text,fontSize:15,outline:"none",boxSizing:"border-box"}}/>
            <button type="button" onClick={()=>setShowPassword(s=>!s)}
              aria-label={showPassword?"Hide password":"Show password"}
              style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",cursor:"pointer",fontSize:18,padding:6,lineHeight:1}}>
              {showPassword?"🙈":"👁️"}
            </button>
          </div>

          <button onClick={signInEmail} disabled={authBusy}
            style={{width:"100%",background:t.accent,color:t.accentText,border:"none",borderRadius:10,padding:"13px",fontSize:15,fontWeight:700,cursor:authBusy?"wait":"pointer",opacity:authBusy?0.6:1,marginBottom:12}}>
            {authBusy?"Please wait…":(authMode==="signup"?"Sign up":"Sign in")}
          </button>

          <div style={{display:"flex",alignItems:"center",gap:10,margin:"10px 0"}}>
            <div style={{flex:1,height:1,background:t.border}}/>
            <span style={{color:t.muted,fontSize:12}}>or</span>
            <div style={{flex:1,height:1,background:t.border}}/>
          </div>

          <button onClick={signInGoogle} disabled={authBusy}
            style={{width:"100%",background:t.card2,color:t.text,border:`1px solid ${t.border}`,borderRadius:10,padding:"13px",fontSize:15,fontWeight:700,cursor:authBusy?"wait":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
            <svg width="18" height="18" viewBox="0 0 48 48" style={{flexShrink:0}}>
              <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
              <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
              <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
              <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001 6.19 5.238 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
            </svg>
            Continue with Google
          </button>

          {authError&&<div style={{marginTop:14,fontSize:13,color:authError.startsWith("Check")?t.accent:"#f87171",lineHeight:1.5}}>{authError}</div>}

          <div style={{marginTop:18,textAlign:"center",fontSize:13,color:t.muted}}>
            {authMode==="signup"?"Already have an account? ":"New here? "}
            <span onClick={()=>{setAuthMode(authMode==="signup"?"signin":"signup");setAuthError("");}}
              style={{color:t.accent,fontWeight:700,cursor:"pointer"}}>
              {authMode==="signup"?"Sign in":"Create one"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{background:t.bg,height:kbOffset>0?`calc(100% - ${kbOffset}px)`:"100%",fontFamily:"'DM Sans','Segoe UI',sans-serif",color:t.text,display:"flex",flexDirection:"column",width:"100%",maxWidth:480,margin:"0 auto",overflow:"hidden",transition:"height 0.2s ease"}}>

      {/* ── HEADER ── */}
      <div style={{paddingTop:"calc(env(safe-area-inset-top) + 14px)",paddingLeft:16,paddingRight:16,paddingBottom:0,borderBottom:`1px solid ${t.border}`,background:t.bg,flexShrink:0,zIndex:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <span style={{fontSize:20,fontWeight:800,letterSpacing:-0.5}}>Nutri<span style={{color:t.accent}}>Chat</span></span>
            <div style={{fontSize:11,color:t.muted}}>Hey {settings.name} 👋</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
          <CalRing calories={totals.calories} goal={settings.calGoal} t={t}/>
          <div style={{flex:1}}>
            <MacroBar label="Protein" value={totals.protein} max={settings.proteinGoal} color={t.protein} t={t}/>
            <MacroBar label="Carbs" value={totals.carbs} max={settings.carbsGoal} color={t.carbs} t={t}/>
            <MacroBar label="Fat" value={totals.fat} max={settings.fatGoal} color={t.fat} t={t}/>
          </div>
        </div>
        <div style={{display:"flex"}}>
          {[["chat","💬"],["smart","✨"],["log","🍽️"],["weight","⚖️"],["progress","📈"],["body","🫂"],["calendar","📅"],["settings","⚙️"]].map(([id,icon])=>(
            <button key={id} onClick={()=>{setTab(id);setSelectedDay(null);}} style={{
              flex:1,padding:"8px 0",background:"transparent",border:"none",
              borderBottom:`2px solid ${tab===id?t.accent:"transparent"}`,
              color:tab===id?t.accent:t.muted,cursor:"pointer",fontSize:id==="smart"?13:11,fontWeight:700,transition:"all 0.2s"
            }}>{icon}</button>
          ))}
        </div>
      </div>

      {/* ── CHAT TAB ── */}
      {tab==="chat"&&(
        <>
          <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,display:"flex",flexDirection:"column",gap:10,minHeight:0}}>
            {messages.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                <div style={{
                  maxWidth:"85%",background:m.role==="user"?t.accent:t.card,
                  color:m.role==="user"?t.accentText:t.text,
                  borderRadius:m.role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px",
                  padding:"10px 14px",fontSize:14,lineHeight:1.5,
                  border:m.role==="assistant"?`1px solid ${t.border}`:"none"
                }}>
                  {m.imagePreview&&<img src={m.imagePreview} alt="food" style={{width:"100%",borderRadius:10,marginBottom:6,maxHeight:180,objectFit:"cover"}}/>}
                  {m.isVoice&&<div style={{fontSize:11,opacity:0.75,marginBottom:4}}>🎙️ via voice</div>}
                  <div>{m.text}</div>
                  {m.foods?.map((f,fi)=><FoodChip key={fi} food={f} t={t}/>)}
                  {m.pendingConfirm&&(
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={()=>confirmFoods(m.foods)}
                        style={{flex:1,padding:"9px 12px",background:t.accent,color:t.accentText,border:"none",borderRadius:20,fontWeight:700,cursor:"pointer",fontSize:13}}>
                        ✓ Yes, add this!
                      </button>
                      <button onClick={cancelFoods}
                        style={{flex:1,padding:"9px 12px",background:t.card2,color:t.text,border:`1px solid ${t.border}`,borderRadius:20,fontWeight:600,cursor:"pointer",fontSize:13}}>
                        ✗ No, try again
                      </button>
                    </div>
                  )}
                  {m.weightLogged&&(
                    <div style={{background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"6px 10px",fontSize:12,marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:16}}>⚖️</span>
                      <span style={{fontWeight:700,color:t.accent}}>{m.weightLogged} kg</span>
                      <span style={{color:t.muted}}>logged to weight tracker</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading&&<LoadingDots t={t}/>}
            <div ref={bottomRef}/>
          </div>
          <div style={{paddingTop:10,paddingLeft:12,paddingRight:12,paddingBottom:"calc(env(safe-area-inset-bottom) + 12px)",borderTop:`1px solid ${t.border}`,background:t.bg,flexShrink:0}}>
            {/* Live transcript bubble — appears while speaking */}
            {voiceStatus==="listening"&&(
              <div style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"flex-end"}}>
                  <div style={{
                    maxWidth:"85%",background:t.accent,color:t.accentText,
                    borderRadius:"18px 18px 4px 18px",padding:"10px 14px",fontSize:14,lineHeight:1.5
                  }}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:18,animation:"micpulse 1s infinite"}}>🎙️</span>
                      <span style={{fontStyle:liveTranscript?"normal":"italic",opacity:liveTranscript?1:0.7}}>
                        {liveTranscript||"Listening… speak now"}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{textAlign:"right",fontSize:10,color:t.muted,marginTop:4}}>Tap 🎙️ to stop</div>
              </div>
            )}
            {voiceStatus==="processing"&&(
              <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                <div style={{background:t.accent,color:t.accentText,borderRadius:"18px 18px 4px 18px",padding:"10px 14px",fontSize:13}}>
                  <span style={{fontStyle:"italic"}}>"{voiceTranscriptRef.current||liveTranscript}"</span>
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={()=>fileRef.current?.click()}
                style={{background:t.card2,border:`1px solid ${t.border}`,borderRadius:12,width:46,height:46,cursor:"pointer",fontSize:20,flexShrink:0}}>📷</button>
              <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{if(e.target.files[0])sendPhoto(e.target.files[0]);e.target.value="";}}/>
              <button onClick={startBarcode} title="Scan barcode"
                style={{background:t.card2,border:`1px solid ${t.border}`,borderRadius:12,width:46,height:46,cursor:"pointer",fontSize:20,flexShrink:0}}>🔍</button>
              <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendText()}
                placeholder="Food, restaurant, or 'I weigh 73kg'..." style={{...iStyle,flex:1}}/>
              <button onClick={startVoice} style={{
                background:isRecording?t.accent:t.card2, border:`1px solid ${isRecording?t.accent:t.border}`,
                borderRadius:12,width:46,height:46,cursor:"pointer",fontSize:20,flexShrink:0,
                animation:isRecording?"micpulse 1s infinite":"none"
              }}>🎙️</button>
              <button onClick={sendText} disabled={loading||!input.trim()}
                style={{background:t.accent,border:"none",borderRadius:12,width:46,height:46,cursor:"pointer",fontSize:20,flexShrink:0,opacity:loading||!input.trim()?0.4:1}}>↑</button>
            </div>
          </div>
        </>
      )}

      {/* ── BARCODE OVERLAY ── */}
      {barcodeActive&&(
        <div style={{position:"fixed",inset:0,background:"#000",zIndex:100,display:"flex",flexDirection:"column"}}>
          <div style={{paddingTop:"calc(env(safe-area-inset-top) + 14px)",paddingLeft:16,paddingRight:16,paddingBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{color:"#fff",fontWeight:700,fontSize:16}}>🔍 Barcode Scanner</div>
            <button onClick={stopBarcode} style={{background:"transparent",border:"1px solid #fff4",borderRadius:10,color:"#fff",padding:"6px 14px",cursor:"pointer",fontSize:14}}>Cancel</button>
          </div>
          <div style={{flex:1,position:"relative",overflow:"hidden"}}>
            <video ref={barcodeVideoRef} style={{width:"100%",height:"100%",objectFit:"cover"}} playsInline muted/>
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
              <div style={{position:"relative",width:260,height:160,border:`3px solid ${t.accent}`,borderRadius:16,boxShadow:"0 0 0 9999px rgba(0,0,0,0.55)"}}>
                {[{t:-2,l:-2,bt:"4px",bl:"4px",br:0,bb:0,rad:"12px 0 0 0"},{t:-2,r:-2,bt:"4px",br:"4px",bl:0,bb:0,rad:"0 12px 0 0"},{b:-2,l:-2,bb:"4px",bl:"4px",br:0,bt:0,rad:"0 0 0 12px"},{b:-2,r:-2,bb:"4px",br:"4px",bl:0,bt:0,rad:"0 0 12px 0"}].map((s,i)=>(
                  <div key={i} style={{position:"absolute",width:28,height:28,top:s.t,bottom:s.b,left:s.l,right:s.r,borderTop:s.bt?`${s.bt} solid ${t.accent}`:"none",borderBottom:s.bb?`${s.bb} solid ${t.accent}`:"none",borderLeft:s.bl?`${s.bl} solid ${t.accent}`:"none",borderRight:s.br?`${s.br} solid ${t.accent}`:"none",borderRadius:s.rad}}/>
                ))}
                <div style={{position:"absolute",top:"50%",left:0,right:0,height:2,background:`${t.accent}88`,animation:"scan 2s linear infinite"}}/>
              </div>
            </div>
          </div>
          <div style={{paddingTop:20,paddingLeft:20,paddingRight:20,paddingBottom:"calc(env(safe-area-inset-bottom) + 20px)",textAlign:"center",color:"#fff",fontSize:14,background:"rgba(0,0,0,0.8)",lineHeight:1.5}}>
            {barcodeStatus||"Point camera at barcode..."}
          </div>
        </div>
      )}

      {/* ── SMART FEATURES TAB ── */}
      {tab==="smart"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>✨ Smart Features</div>
          <div style={{fontSize:13,color:t.muted,marginBottom:18}}>AI-powered insights for your nutrition</div>

          {/* Remaining macros today */}
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:16,marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>📊 Remaining Today</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[
                {l:"Calories",v:Math.round(remaining.calories),u:"kcal",c:t.accent},
                {l:"Protein",v:Math.round(remaining.protein),u:"g",c:t.protein},
                {l:"Carbs",v:Math.round(remaining.carbs),u:"g",c:t.carbs},
                {l:"Fat",v:Math.round(remaining.fat),u:"g",c:t.fat},
              ].map(x=>(
                <div key={x.l} style={{background:t.card2,borderRadius:12,padding:"10px 12px"}}>
                  <div style={{fontSize:18,fontWeight:800,color:x.c}}>{x.v}<span style={{fontSize:11,fontWeight:400}}>{x.u}</span></div>
                  <div style={{fontSize:11,color:t.muted}}>{x.l} left</div>
                </div>
              ))}
            </div>
          </div>

          {/* Meal Suggestions */}
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:16,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>🍽️ Meal Suggestions</div>
                <div style={{fontSize:12,color:t.muted}}>Based on your remaining macros</div>
              </div>
              <button onClick={generateMealSuggestions} disabled={smartLoading==="suggest"}
                style={{background:t.accent,border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",fontSize:12,fontWeight:700,color:t.accentText,opacity:smartLoading==="suggest"?0.6:1}}>
                {smartLoading==="suggest"?"...":"Generate"}
              </button>
            </div>
            {smartLoading==="suggest"&&(
              <div style={{color:t.muted,fontSize:13,padding:"12px 0",textAlign:"center"}}>🤔 Thinking of meal ideas...</div>
            )}
            {mealSuggestions&&mealSuggestions.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:10}}>
                {mealSuggestions.map((s,i)=>(
                  <div key={i} style={{background:t.card2,border:`1px solid ${t.border}`,borderRadius:12,padding:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                      <div style={{fontWeight:700,fontSize:14}}>{s.emoji} {s.name}</div>
                      <button onClick={()=>logSuggestion(s)}
                        style={{background:t.accent,border:"none",borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:700,color:t.accentText,flexShrink:0}}>
                        Log it
                      </button>
                    </div>
                    <div style={{fontSize:12,color:t.muted,marginBottom:6}}>{s.description}</div>
                    <div style={{display:"flex",gap:8,fontSize:11}}>
                      <span style={{color:t.accent}}>{s.calories} cal</span>
                      <span style={{color:t.protein}}>P {s.protein}g</span>
                      <span style={{color:t.carbs}}>C {s.carbs}g</span>
                      <span style={{color:t.fat}}>F {s.fat}g</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {mealSuggestions&&mealSuggestions.length===0&&!smartLoading&&(
              <div style={{color:t.muted,fontSize:13,marginTop:8}}>Couldn't generate suggestions. Try again!</div>
            )}
          </div>

          {/* Weekly Summary */}
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:16,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>📈 Weekly Summary</div>
                <div style={{fontSize:12,color:t.muted}}>AI analysis of your last 7 days</div>
              </div>
              <button onClick={generateWeeklySummary} disabled={smartLoading==="summary"}
                style={{background:t.accent,border:"none",borderRadius:10,padding:"8px 14px",cursor:"pointer",fontSize:12,fontWeight:700,color:t.accentText,opacity:smartLoading==="summary"?0.6:1}}>
                {smartLoading==="summary"?"...":"Analyse"}
              </button>
            </div>

            {/* 7-day mini bar chart */}
            {(()=>{
              const keys=getLast7Keys();
              const maxCal=Math.max(...keys.map(k=>getDayTotals(k).cal),1);
              return (
                <div style={{display:"flex",gap:4,alignItems:"flex-end",height:50,marginBottom:12}}>
                  {keys.map((k,i)=>{
                    const dt=getDayTotals(k);
                    const h=Math.max((dt.cal/maxCal)*46,dt.cal>0?4:1);
                    const isToday=k===today;
                    return (
                      <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <div style={{width:"100%",height:h,background:isToday?t.accent:dt.cal>0?t.card2:t.border,borderRadius:4,transition:"height 0.4s"}}/>
                        <div style={{fontSize:9,color:isToday?t.accent:t.muted}}>{keyToDisplay(k).split(",")[0]}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {smartLoading==="summary"&&(
              <div style={{color:t.muted,fontSize:13,padding:"12px 0",textAlign:"center"}}>🧠 Analysing your week...</div>
            )}
            {weeklySummary&&(
              <div style={{fontSize:13,lineHeight:1.7,color:t.text,borderTop:`1px solid ${t.border}`,paddingTop:12,whiteSpace:"pre-wrap"}}>
                {weeklySummary}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LOG TAB ── */}
      {tab==="log"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          {/* ── Food Search ── */}
          <div style={{marginBottom:14}}>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:15,pointerEvents:"none"}}>🔎</span>
              <input value={foodSearch} onChange={e=>searchFoods(e.target.value)}
                placeholder="Search food database..." style={{...iStyle,paddingLeft:36,paddingRight:foodSearch?36:14}}/>
              {foodSearch&&(
                <button onClick={()=>{setFoodSearch("");setFoodResults([]);}}
                  style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",cursor:"pointer",color:t.muted,fontSize:20,lineHeight:1}}>×</button>
              )}
            </div>
            {foodSearching&&(
              <div style={{color:t.muted,fontSize:12,padding:"10px 0",textAlign:"center"}}>Searching database...</div>
            )}
            {foodResults.length>0&&(
              <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
                {foodResults.map((f,i)=>(
                  <div key={i} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</div>
                      {f.brand&&<div style={{fontSize:10,color:t.muted,marginBottom:2}}>{f.brand} · {f.amount}</div>}
                      <div style={{display:"flex",gap:8,fontSize:11}}>
                        <span style={{color:t.accent}}>{f.calories} cal</span>
                        <span style={{color:t.protein}}>P {f.protein}g</span>
                        <span style={{color:t.carbs}}>C {f.carbs}g</span>
                        <span style={{color:t.fat}}>F {f.fat}g</span>
                      </div>
                    </div>
                    <button onClick={()=>{
                      addFoods([f]);
                      setMessages(prev=>[...prev,{role:"assistant",text:`Logged ${f.name} (+${f.calories} cal) 📋`,foods:[f]}]);
                      setFoodSearch(""); setFoodResults([]);
                    }} style={{background:t.accent,border:"none",borderRadius:8,padding:"7px 12px",cursor:"pointer",fontSize:12,fontWeight:700,color:t.accentText,flexShrink:0}}>+ Log</button>
                  </div>
                ))}
              </div>
            )}
            {foodSearch&&!foodSearching&&foodResults.length===0&&(
              <div style={{color:t.muted,fontSize:12,padding:"10px 0",textAlign:"center"}}>No results — try the chat for AI estimation!</div>
            )}
          </div>

          {/* ── Today's log list ── */}
          {!foodSearch&&(
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontWeight:700,fontSize:16}}>Today's Log</div>
                <button onClick={()=>{if(window.confirm("Clear today?"))setAllData(p=>({...p,[today]:{foods:[]}}));}}
                  style={{background:"transparent",border:`1px solid ${t.border}`,color:t.muted,borderRadius:8,padding:"5px 10px",cursor:"pointer",fontSize:12}}>Clear</button>
              </div>
              {todayFoods.length===0
                ?<div style={{textAlign:"center",color:t.muted,marginTop:40,fontSize:14}}>Nothing logged yet.<br/>Search above or head to Chat!</div>
                :todayFoods.map((f,i)=>(
                  <div key={i} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <div style={{fontWeight:700}}>{f.name}</div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{fontSize:11,color:t.muted}}>{f.time}</div>
                        <button onClick={()=>setAllData(p=>({...p,[today]:{...p[today],foods:p[today].foods.filter((_,fi)=>fi!==i)}}))}
                          style={{background:"transparent",border:"none",cursor:"pointer",color:t.muted,fontSize:16,padding:0,lineHeight:1}}>×</button>
                      </div>
                    </div>
                    <div style={{fontSize:12,color:t.muted,marginBottom:6}}>{f.amount}</div>
                    <div style={{display:"flex",gap:10,fontSize:12}}>
                      <span style={{color:t.accent}}>{f.calories} kcal</span>
                      <span style={{color:t.protein}}>P {f.protein}g</span>
                      <span style={{color:t.carbs}}>C {f.carbs}g</span>
                      <span style={{color:t.fat}}>F {f.fat}g</span>
                    </div>
                  </div>
                ))
              }
            </>
          )}
        </div>
      )}

      {/* ── WEIGHT TAB ── */}
      {tab==="weight"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>⚖️ Weight Log</div>
          <div style={{fontSize:13,color:t.muted,marginBottom:16}}>Track your weight over time in kg</div>

          {/* Log today's weight */}
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:16,marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>Log Today's Weight</div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <div style={{position:"relative",flex:1}}>
                <input
                  type="number" step="0.1" min="20" max="500"
                  value={weightInput} onChange={e=>setWeightInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&logWeight()}
                  placeholder="e.g. 72.5"
                  style={{...iStyle,paddingRight:36}}
                />
                <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",color:t.muted,fontSize:13,pointerEvents:"none"}}>kg</span>
              </div>
              <button onClick={logWeight} disabled={!weightInput}
                style={{background:t.accent,border:"none",borderRadius:12,padding:"10px 18px",cursor:"pointer",fontSize:14,fontWeight:700,color:t.accentText,opacity:!weightInput?0.4:1,flexShrink:0}}>
                Save
              </button>
            </div>
            {weightLog.find(e=>e.date===todayKey())&&(
              <div style={{marginTop:10,fontSize:13,color:t.muted}}>
                Today: <span style={{color:t.accent,fontWeight:700}}>{weightLog.find(e=>e.date===todayKey()).weight} kg</span> logged at {weightLog.find(e=>e.date===todayKey()).time}
              </div>
            )}
          </div>

          {/* Mini chart */}
          {weightLog.length>=2&&(()=>{
            const recent=weightLog.slice(-14);
            const vals=recent.map(e=>e.weight);
            const mn=Math.min(...vals)-1, mx=Math.max(...vals)+1, range=mx-mn||1;
            const W=340, H=100, pad=10;
            const pts=recent.map((e,i)=>({
              x:pad+(i/(recent.length-1))*(W-pad*2),
              y:H-pad-((e.weight-mn)/range)*(H-pad*2)
            }));
            const path="M"+pts.map(p=>`${p.x},${p.y}`).join("L");
            const first=weightLog[0]?.weight, last=weightLog[weightLog.length-1]?.weight;
            const diff=last&&first?+(last-first).toFixed(1):null;
            return (
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:16,padding:16,marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontWeight:700,fontSize:14}}>Progress Chart</div>
                  {diff!==null&&(
                    <div style={{fontSize:13,fontWeight:700,color:diff<0?"#34d399":diff>0?"#f87171":t.muted}}>
                      {diff>0?"+":""}{diff} kg overall
                    </div>
                  )}
                </div>
                <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible"}}>
                  <defs>
                    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={t.accent} stopOpacity="0.3"/>
                      <stop offset="100%" stopColor={t.accent} stopOpacity="0"/>
                    </linearGradient>
                  </defs>
                  <path d={path+`L${pts[pts.length-1].x},${H} L${pts[0].x},${H} Z`} fill="url(#wg)"/>
                  <path d={path} fill="none" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  {pts.map((p,i)=>(
                    <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={t.accent}/>
                  ))}
                </svg>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:t.muted,marginTop:4}}>
                  <span>{keyToDisplay(recent[0].date).split(",")[0]}</span>
                  <span>{keyToDisplay(recent[recent.length-1].date).split(",")[0]}</span>
                </div>
              </div>
            );
          })()}

          {/* Stats row */}
          {weightLog.length>0&&(()=>{
            const vals=weightLog.map(e=>e.weight);
            const latest=vals[vals.length-1];
            const highest=Math.max(...vals);
            const lowest=Math.min(...vals);
            const avg=+(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1);
            return (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
                {[{l:"Current",v:`${latest} kg`,c:t.accent},{l:"Average",v:`${avg} kg`,c:t.text},{l:"Highest",v:`${highest} kg`,c:"#f87171"},{l:"Lowest",v:`${lowest} kg`,c:"#34d399"}].map(s=>(
                  <div key={s.l} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:800,color:s.c}}>{s.v}</div>
                    <div style={{fontSize:11,color:t.muted}}>{s.l}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* History list */}
          {weightLog.length>0&&(
            <div>
              <div style={{fontWeight:700,fontSize:12,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>History</div>
              {[...weightLog].reverse().map((e,i)=>{
                const prev=weightLog[weightLog.length-2-i];
                const diff=prev?+(e.weight-prev.weight).toFixed(1):null;
                return (
                  <div key={e.date} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"10px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:13}}>{keyToDisplay(e.date)}</div>
                      <div style={{fontSize:11,color:t.muted}}>{e.time}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontWeight:800,color:t.accent,fontSize:16}}>{e.weight} kg</div>
                        {diff!==null&&<div style={{fontSize:11,color:diff<0?"#34d399":diff>0?"#f87171":t.muted}}>{diff>0?"+":""}{diff}</div>}
                      </div>
                      <button onClick={()=>{if(window.confirm("Delete this weight entry?"))setWeightLog(prev=>prev.filter(x=>x!==e));}}
                        title="Delete entry"
                        style={{background:"transparent",border:`1px solid ${t.border}`,color:"#f87171",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:13,flexShrink:0}}>🗑️</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {weightLog.length===0&&(
            <div style={{textAlign:"center",color:t.muted,marginTop:40,fontSize:14}}>No weight logged yet.<br/>Enter your weight above to start tracking!</div>
          )}
        </div>
      )}

      {/* ── PROGRESS CHARTS TAB ── */}
      {tab==="progress"&&(()=>{
        const days = chartRange;
        const rangeData = Array.from({length:days},(_,i)=>{
          const d=new Date(); d.setDate(d.getDate()-(days-1-i));
          const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
          const foods=allData[k]?.foods||[];
          const tot=foods.reduce((a,f)=>({cal:a.cal+(f.calories||0),p:a.p+(f.protein||0)}),{cal:0,p:0});
          return {k,cal:tot.cal,protein:tot.p,hasData:foods.length>0,label:d.getDate(),weekday:d.toLocaleDateString("en",{weekday:"short"})};
        });

        const renderLineChart=(data,color,label,unit,goal)=>{
          const vals=data.map(d=>d.v);
          const nonZero=vals.filter(v=>v>0);
          const max=Math.max(...vals,goal||1,1);
          const W=340,H=90,pad=8;
          const pts=data.map((d,i)=>({x:pad+(i/(data.length-1||1))*(W-pad*2),y:H-pad-((d.v/max)*(H-pad*2)),hasData:d.v>0}));
          const path="M"+pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L");
          const goalY=goal?H-pad-((goal/max)*(H-pad*2)):null;
          const avg=nonZero.length?Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length):null;
          const streak=(()=>{let s=0;for(let i=vals.length-1;i>=0;i--){if(vals[i]>0)s++;else break;}return s;})();
          return (
            <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontWeight:700,fontSize:14}}>{label}</div>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  {streak>0&&<div style={{fontSize:11,color:t.accent,fontWeight:700}}>🔥 {streak}d streak</div>}
                  {avg!==null&&<div style={{fontSize:11,color:t.muted}}>Avg: <span style={{color,fontWeight:700}}>{avg}{unit}</span></div>}
                </div>
              </div>
              <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible"}}>
                <defs>
                  <linearGradient id={`g${label.replace(/\s/g,"")}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
                    <stop offset="100%" stopColor={color} stopOpacity="0"/>
                  </linearGradient>
                </defs>
                {goalY&&<line x1={pad} y1={goalY} x2={W-pad} y2={goalY} stroke={color} strokeWidth="1" strokeDasharray="4 3" opacity="0.5"/>}
                <path d={path+`L${pts[pts.length-1].x},${H} L${pts[0].x},${H} Z`} fill={`url(#g${label.replace(/\s/g,"")})`}/>
                <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                {pts.filter(p=>p.hasData).map((p,i)=>(
                  <circle key={i} cx={p.x} cy={p.y} r={days<=14?4:2.5} fill={color}/>
                ))}
              </svg>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:t.muted,marginTop:4}}>
                <span>{days===7?"Mon":days===14?"2w ago":`${days}d ago`}</span>
                <span>Today</span>
              </div>
              {goal&&goalY!==null&&<div style={{fontSize:10,color:t.muted,marginTop:4}}>── goal: {goal}{unit}</div>}
            </div>
          );
        };

        const calData=rangeData.map(d=>({v:d.cal}));
        const protData=rangeData.map(d=>({v:d.protein}));
        const wData=weightLog.slice(-days).map(e=>({v:e.weight}));
        const daysLogged=rangeData.filter(d=>d.hasData).length;
        const avgCal=calData.filter(d=>d.v>0).length?Math.round(calData.filter(d=>d.v>0).reduce((a,d)=>a+d.v,0)/calData.filter(d=>d.v>0).length):0;

        return (
          <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{fontWeight:800,fontSize:18}}>📈 Progress</div>
              {/* Range toggle */}
              <div style={{display:"flex",gap:4,background:t.card2,borderRadius:10,padding:3}}>
                {[7,14,30].map(r=>(
                  <button key={r} onClick={()=>setChartRange(r)} style={{
                    background:chartRange===r?t.accent:"transparent",
                    border:"none",borderRadius:7,padding:"4px 10px",cursor:"pointer",
                    fontSize:11,fontWeight:700,color:chartRange===r?t.accentText:t.muted,transition:"all 0.2s"
                  }}>{r}d</button>
                ))}
              </div>
            </div>

            {/* Summary stats row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {l:"Days logged",v:daysLogged,u:`/${days}`,c:t.accent},
                {l:"Avg calories",v:avgCal,u:"cal",c:t.text},
                {l:"Consistency",v:Math.round((daysLogged/days)*100),u:"%",c:daysLogged/days>=0.8?"#34d399":"#fb923c"},
              ].map(s=>(
                <div key={s.l} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"10px 10px",textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:800,color:s.c}}>{s.v}<span style={{fontSize:10,fontWeight:400}}>{s.u}</span></div>
                  <div style={{fontSize:10,color:t.muted}}>{s.l}</div>
                </div>
              ))}
            </div>

            {renderLineChart(calData,t.accent,"Daily Calories","kcal",settings.calGoal)}
            {renderLineChart(protData,t.protein,"Daily Protein","g",settings.proteinGoal)}
            {wData.length>=2?renderLineChart(wData,"#34d399","Weight Trend","kg",null):(
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:14,color:t.muted,fontSize:13,textAlign:"center"}}>
                Log at least 2 weight entries to see your weight trend.
              </div>
            )}
            {bodyFatLog.length>=2?(()=>{
              const bfData=bodyFatLog.slice(-days).map(e=>({v:e.bodyFat}));
              return renderLineChart(bfData,"#f472b6","Body Fat % Trend","%",null);
            })():(
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:14,color:t.muted,fontSize:13,textAlign:"center"}}>
                Log at least 2 body-fat measurements (Body tab) to see your body-fat trend.
              </div>
            )}
          </div>
        );
      })()}

      {/* ── BODY FAT TAB ── */}
      {tab==="body"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>🫂 Body Fat Estimator</div>
          <div style={{fontSize:13,color:t.muted,marginBottom:14,lineHeight:1.6}}>
            Upload a photo in underwear and AI will estimate your body fat %. The same strict rules are applied every time for consistency.
          </div>

          {/* Rules card */}
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>📋 Measurement Rules</div>
            {["Take photo in the same lighting each time","Same time of day (e.g. morning, fasted)","Wear similar underwear each time","Stand straight, front-facing, arms slightly out","Full body visible from head to toe","No filters or editing"].map((r,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:6,fontSize:12,color:t.muted}}>
                <span style={{color:t.accent,fontWeight:700,flexShrink:0}}>{i+1}.</span>{r}
              </div>
            ))}
          </div>

          {/* Upload button */}
          <button onClick={()=>bodyFatFileRef.current?.click()} disabled={bodyFatLoading}
            style={{width:"100%",background:t.accent,border:"none",borderRadius:14,padding:16,cursor:"pointer",fontSize:15,fontWeight:700,color:t.accentText,marginBottom:16,opacity:bodyFatLoading?0.6:1}}>
            {bodyFatLoading?"🔬 Analysing...":"📸 Upload Photo to Analyse"}
          </button>
          <input ref={bodyFatFileRef} type="file" accept="image/*" style={{display:"none"}}
            onChange={e=>{if(e.target.files[0])analyseBodyFat(e.target.files[0]);e.target.value="";}}/>

          {/* Current result */}
          {bodyFatResult&&bodyFatResult.bodyFat!==null&&(
            <div style={{background:t.card,border:`2px solid ${t.accent}`,borderRadius:14,padding:16,marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div>
                  <div style={{fontSize:11,color:t.muted,marginBottom:2}}>Estimated Body Fat</div>
                  <div style={{fontSize:36,fontWeight:800,color:t.accent,lineHeight:1}}>{bodyFatResult.bodyFat}%</div>
                  <div style={{fontSize:13,color:t.muted,marginTop:2}}>{bodyFatResult.category}</div>
                </div>
                <div style={{background:bodyFatResult.confidence==="high"?"#34d39922":bodyFatResult.confidence==="medium"?"#fbbf2422":"#f8717122",border:`1px solid ${bodyFatResult.confidence==="high"?"#34d399":bodyFatResult.confidence==="medium"?"#fbbf24":"#f87171"}`,borderRadius:8,padding:"4px 10px",fontSize:11,fontWeight:700,color:bodyFatResult.confidence==="high"?"#34d399":bodyFatResult.confidence==="medium"?"#fbbf24":"#f87171"}}>
                  {bodyFatResult.confidence} confidence
                </div>
              </div>
              <div style={{fontSize:13,color:t.muted,lineHeight:1.6}}>{bodyFatResult.notes}</div>
            </div>
          )}
          {bodyFatResult&&bodyFatResult.bodyFat===null&&(
            <div style={{background:t.card,border:`1px solid #f87171`,borderRadius:14,padding:14,marginBottom:16,color:"#f87171",fontSize:13}}>
              ⚠️ {bodyFatResult.notes}
            </div>
          )}

          {/* History */}
          {bodyFatLog.length>0&&(
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontWeight:700,fontSize:12,color:t.muted,textTransform:"uppercase",letterSpacing:1}}>History</div>
                <div style={{fontSize:12,color:t.muted}}>{bodyFatLog.length} measurement{bodyFatLog.length!==1?"s":""}</div>
              </div>
              {bodyFatLog.length>=2&&(()=>{
                const first=bodyFatLog[0].bodyFat;
                const last=bodyFatLog[bodyFatLog.length-1].bodyFat;
                const diff=+(last-first).toFixed(1);
                const avg=+(bodyFatLog.reduce((a,e)=>a+e.bodyFat,0)/bodyFatLog.length).toFixed(1);
                return (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                    {[{l:"Current",v:`${last}%`,c:t.accent},{l:"Average",v:`${avg}%`,c:t.text},{l:"Total change",v:`${diff>0?"+":""}${diff}%`,c:diff<0?"#34d399":diff>0?"#f87171":t.muted}].map(s=>(
                      <div key={s.l} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"10px 8px",textAlign:"center"}}>
                        <div style={{fontSize:15,fontWeight:800,color:s.c}}>{s.v}</div>
                        <div style={{fontSize:10,color:t.muted}}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {/* Side-by-side latest two */}
              {bodyFatLog.length>=2&&(()=>{
                const a=bodyFatLog[bodyFatLog.length-2];
                const b=bodyFatLog[bodyFatLog.length-1];
                return (
                  <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:12,marginBottom:12}}>
                    <div style={{fontSize:12,color:t.muted,marginBottom:8,fontWeight:600}}>📸 Latest Comparison</div>
                    <div style={{display:"flex",gap:10}}>
                      {[a,b].map((e,i)=>(
                        <div key={i} style={{flex:1,textAlign:"center"}}>
                          {e.preview
                            ? <img src={e.preview} alt="" style={{width:"100%",height:140,objectFit:"cover",borderRadius:10,marginBottom:6}}/>
                            : <div style={{width:"100%",height:140,background:t.card2,borderRadius:10,marginBottom:6,display:"flex",alignItems:"center",justifyContent:"center",color:t.muted,fontSize:11}}>No photo</div>
                          }
                          <div style={{fontSize:18,fontWeight:800,color:t.accent}}>{e.bodyFat}%</div>
                          <div style={{fontSize:10,color:t.muted}}>{keyToDisplay(e.date).split(",")[0]}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {[...bodyFatLog].reverse().map((e,i,arr)=>{
                const prev=arr[i+1];
                const diff=prev?+(e.bodyFat-prev.bodyFat).toFixed(1):null;
                return (
                  <div key={i} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:14,marginBottom:8}}>
                    <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                      {e.preview&&<img src={e.preview} alt="" style={{width:56,height:72,objectFit:"cover",borderRadius:8,flexShrink:0}}/>}
                      <div style={{flex:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                          <div>
                            <div style={{fontSize:12,color:t.muted,marginBottom:2}}>{keyToDisplay(e.date)} · {e.time}</div>
                            <div style={{fontSize:26,fontWeight:800,color:t.accent,lineHeight:1}}>{e.bodyFat}%</div>
                            <div style={{fontSize:12,color:t.muted,marginTop:2}}>{e.category} · {e.confidence} confidence</div>
                          </div>
                          {diff!==null&&(
                            <div style={{background:diff<0?"#34d39922":diff>0?"#f8717122":"#ffffff11",border:`1px solid ${diff<0?"#34d399":diff>0?"#f87171":"#ffffff22"}`,borderRadius:10,padding:"6px 12px",textAlign:"center"}}>
                              <div style={{fontSize:16,fontWeight:800,color:diff<0?"#34d399":diff>0?"#f87171":t.muted}}>{diff>0?"+":""}{diff}%</div>
                              <div style={{fontSize:10,color:t.muted}}>vs prev</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {e.notes&&<div style={{fontSize:12,color:t.muted,marginTop:8,lineHeight:1.5,borderTop:`1px solid ${t.border}`,paddingTop:8}}>{e.notes}</div>}
                    <div style={{display:"flex",justifyContent:"flex-end",marginTop:8}}>
                      <button onClick={()=>{if(window.confirm("Delete this body-fat entry and its photo?"))setBodyFatLog(prev=>prev.filter(x=>x!==e));}}
                        style={{background:"transparent",border:`1px solid ${t.border}`,color:"#f87171",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>
                        🗑️ Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {bodyFatLog.length===0&&!bodyFatResult&&(
            <div style={{textAlign:"center",color:t.muted,marginTop:20,fontSize:13}}>No measurements yet. Upload your first photo above!</div>
          )}
        </div>
      )}

      {/* ── CALENDAR TAB ── */}
      {tab==="calendar"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          {selectedDay?(
            <>
              <button onClick={()=>setSelectedDay(null)} style={{background:"transparent",border:"none",color:t.accent,cursor:"pointer",fontSize:14,marginBottom:12,padding:0}}>← Back</button>
              <div style={{fontWeight:700,fontSize:17,marginBottom:12}}>{keyToDisplay(selectedDay)}</div>

              {/* Add food to this specific day (voice or text) */}
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:12,marginBottom:16}}>
                <div style={{fontSize:12,color:t.muted,fontWeight:700,marginBottom:8}}>➕ Add to this day</div>
                {dayVoiceActive&&(
                  <div style={{background:t.accent,color:t.accentText,borderRadius:12,padding:"10px 12px",fontSize:14,marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:16,animation:"micpulse 1s infinite"}}>🎙️</span>
                    <span style={{fontStyle:dayVoiceTranscript?"normal":"italic",opacity:dayVoiceTranscript?1:0.75}}>{dayVoiceTranscript||"Listening… speak now"}</span>
                  </div>
                )}
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input value={dayAddText} placeholder="e.g. chicken salad and rice"
                    onChange={e=>setDayAddText(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter")addToDay(dayAddText);}}
                    style={{flex:1,background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 12px",color:t.text,fontSize:16,outline:"none",boxSizing:"border-box"}}/>
                  <button onClick={()=>startDayVoice(selectedDay)} title="Speak"
                    style={{flexShrink:0,width:42,height:42,borderRadius:10,border:`1px solid ${t.border}`,background:dayVoiceActive?t.accent:t.card2,cursor:"pointer",fontSize:18}}>🎙️</button>
                  <button onClick={()=>addToDay(dayAddText)} disabled={dayAddLoading||!dayAddText.trim()} title="Add"
                    style={{flexShrink:0,width:42,height:42,borderRadius:10,border:"none",background:t.accent,color:t.accentText,cursor:dayAddLoading?"wait":"pointer",fontSize:18,fontWeight:800,opacity:(dayAddLoading||!dayAddText.trim())?0.5:1}}>↑</button>
                </div>
                {dayAddLoading&&<div style={{fontSize:12,color:t.muted,marginTop:8}}>Analysing…</div>}

                {/* Confirmation — show detected food and ask before adding */}
                {dayPending&&!dayAddLoading&&(
                  <div style={{marginTop:12}}>
                    <div style={{fontSize:13,marginBottom:6}}>I picked up: <span style={{fontWeight:700}}>"{dayPending.text}"</span> — add this?</div>
                    {dayPending.foods.map((f,fi)=><FoodChip key={fi} food={f} t={t}/>)}
                    <div style={{display:"flex",gap:8,marginTop:10}}>
                      <button onClick={()=>confirmDayFoods(selectedDay)}
                        style={{flex:1,padding:"9px 12px",background:t.accent,color:t.accentText,border:"none",borderRadius:20,fontWeight:700,cursor:"pointer",fontSize:13}}>✓ Yes, add</button>
                      <button onClick={cancelDayFoods}
                        style={{flex:1,padding:"9px 12px",background:t.card2,color:t.text,border:`1px solid ${t.border}`,borderRadius:20,fontWeight:600,cursor:"pointer",fontSize:13}}>✗ No</button>
                    </div>
                  </div>
                )}
                {dayAddStatus&&!dayAddLoading&&!dayPending&&<div style={{fontSize:12,color:dayAddStatus.startsWith("⚠️")?"#f87171":t.accent,marginTop:8,lineHeight:1.5}}>{dayAddStatus}</div>}
              </div>

              {sdFoods.length>0?(
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                    {[{l:"Calories",v:Math.round(sdTotals.cal),c:t.accent},{l:"Protein",v:`${Math.round(sdTotals.p)}g`,c:t.protein},{l:"Carbs",v:`${Math.round(sdTotals.c)}g`,c:t.carbs},{l:"Fat",v:`${Math.round(sdTotals.f)}g`,c:t.fat}].map(s=>(
                      <div key={s.l} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:"12px 14px",textAlign:"center"}}>
                        <div style={{fontSize:18,fontWeight:800,color:s.c}}>{s.v}</div>
                        <div style={{fontSize:11,color:t.muted}}>{s.l}</div>
                      </div>
                    ))}
                  </div>
                  {sdFoods.map((f,i)=>(
                    <div key={i} style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:12,padding:12,marginBottom:8}}>
                      <div style={{fontWeight:700,marginBottom:2}}>{f.name} <span style={{color:t.muted,fontWeight:400,fontSize:12}}>· {f.amount}</span></div>
                      <div style={{display:"flex",gap:10,fontSize:12}}>
                        <span style={{color:t.accent}}>{f.calories} kcal</span>
                        <span style={{color:t.protein}}>P {f.protein}g</span>
                        <span style={{color:t.carbs}}>C {f.carbs}g</span>
                        <span style={{color:t.fat}}>F {f.fat}g</span>
                      </div>
                    </div>
                  ))}
                </>
              ):<div style={{color:t.muted,marginTop:40,textAlign:"center"}}>No data for this day.</div>}
            </>
          ):(
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <button onClick={()=>setCalMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}
                  style={{background:t.card2,border:`1px solid ${t.border}`,color:t.text,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:16}}>‹</button>
                <div style={{fontWeight:700,fontSize:15}}>{new Date(calMonth.y,calMonth.m).toLocaleString("default",{month:"long",year:"numeric"})}</div>
                <button onClick={()=>setCalMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}
                  style={{background:t.card2,border:`1px solid ${t.border}`,color:t.text,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:16}}>›</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:4}}>
                {["S","M","T","W","T","F","S"].map((d,i)=>(
                  <div key={i} style={{textAlign:"center",fontSize:11,color:t.muted,fontWeight:700,padding:"4px 0"}}>{d}</div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
                {Array(getFirstDay(calMonth.y,calMonth.m)).fill(null).map((_,i)=><div key={`e${i}`}/>)}
                {Array(getDaysInMonth(calMonth.y,calMonth.m)).fill(null).map((_,i)=>{
                  const d=i+1, key=mkKey(calMonth.y,calMonth.m,d);
                  const dt=getDayTotals(key);
                  const hasData=(allData[key]?.foods?.length||0)>0;
                  const isToday=key===today;
                  const pct=Math.min(dt.cal/(settings.calGoal||1),1);
                  return (
                    <button key={d} onClick={()=>setSelectedDay(key)} style={{
                      background:isToday?t.accent:hasData?t.card:t.card2,
                      border:`1px solid ${isToday?t.accent:t.border}`,
                      borderRadius:10,padding:"8px 4px",cursor:"pointer",
                      color:isToday?t.accentText:t.text,
                      display:"flex",flexDirection:"column",alignItems:"center",gap:3,
                      minHeight:52,transition:"all 0.15s"
                    }}>
                      <div style={{fontSize:13,fontWeight:700}}>{d}</div>
                      {hasData&&(
                        <>
                          <div style={{width:"80%",height:3,background:isToday?"rgba(0,0,0,0.2)":t.border,borderRadius:99}}>
                            <div style={{width:`${pct*100}%`,height:"100%",background:isToday?"rgba(0,0,0,0.5)":t.accent,borderRadius:99}}/>
                          </div>
                          <div style={{fontSize:9,color:isToday?"rgba(0,0,0,0.6)":t.muted}}>{Math.round(dt.cal)}</div>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              {Object.keys(allData).filter(k=>allData[k]?.foods?.length).length>0&&(
                <div style={{marginTop:18}}>
                  <div style={{fontWeight:700,fontSize:12,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Recent Days</div>
                  {Object.keys(allData).filter(k=>allData[k]?.foods?.length).sort().reverse().slice(0,5).map(k=>{
                    const dt=getDayTotals(k);
                    return (
                      <button key={k} onClick={()=>setSelectedDay(k)} style={{
                        background:t.card,border:`1px solid ${t.border}`,borderRadius:12,
                        padding:"10px 14px",cursor:"pointer",width:"100%",textAlign:"left",
                        display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8
                      }}>
                        <div>
                          <div style={{fontWeight:700,fontSize:13}}>{keyToDisplay(k)}</div>
                          <div style={{fontSize:11,color:t.muted}}>P{Math.round(dt.p)}g · C{Math.round(dt.c)}g · F{Math.round(dt.f)}g</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontWeight:800,color:t.accent,fontSize:15}}>{Math.round(dt.cal)}</div>
                          <div style={{fontSize:10,color:t.muted}}>kcal</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── SETTINGS TAB ── */}
      {tab==="settings"&&(
        <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:14,minHeight:0}}>
          <div style={{fontWeight:800,fontSize:18,marginBottom:16}}>Customise</div>

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Profile</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
            <label style={{fontSize:12,color:t.muted,display:"block",marginBottom:4}}>Your Name</label>
            <input value={settings.name} onChange={e=>upd("name",e.target.value)} style={iStyle} placeholder="e.g. Alex"/>
          </div>

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Daily Goals</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>

            {/* Manual entry: type calories + macro % */}
            {(()=>{
              const mc = settings.proteinGoal*4 + settings.carbsGoal*4 + settings.fatGoal*9 || 1;
              const pPct = Math.round(settings.proteinGoal*4/mc*100);
              const cPct = Math.round(settings.carbsGoal*4/mc*100);
              const fPct = Math.round(settings.fatGoal*9/mc*100);
              const sumPct = pPct+cPct+fPct;
              const setCalManual=(cal)=>setSettings(s=>{
                const m=s.proteinGoal*4+s.carbsGoal*4+s.fatGoal*9||1;
                return {...s,calGoal:cal,
                  proteinGoal:Math.round(cal*(s.proteinGoal*4/m)/4),
                  carbsGoal:Math.round(cal*(s.carbsGoal*4/m)/4),
                  fatGoal:Math.round(cal*(s.fatGoal*9/m)/9)};
              });
              const setPct=(which,pct)=>setSettings(s=>{
                const key=which==="p"?"proteinGoal":which==="c"?"carbsGoal":"fatGoal";
                const per=which==="f"?9:4;
                return {...s,[key]:Math.round(s.calGoal*(pct/100)/per)};
              });
              const pctInput=(which,val,color)=>(
                <div style={{flex:1}}>
                  <input type="number" min={0} max={100} value={val}
                    onChange={e=>setPct(which, Math.max(0,Math.min(100,+e.target.value||0)))}
                    style={{width:"100%",background:t.card2,border:`1px solid ${t.border}`,borderRadius:8,padding:"8px 6px",color,fontWeight:700,textAlign:"center",outline:"none",boxSizing:"border-box"}}/>
                </div>
              );
              return (
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:12,color:t.muted,fontWeight:700,marginBottom:8}}>✏️ Set manually</div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                    <span style={{fontSize:13,color:t.text,fontWeight:700,width:78}}>Calories</span>
                    <input type="number" min={0} value={settings.calGoal}
                      onChange={e=>setCalManual(Math.max(0,+e.target.value||0))}
                      style={{flex:1,background:t.card2,border:`1px solid ${t.border}`,borderRadius:8,padding:"8px 12px",color:t.text,fontWeight:700,outline:"none",boxSizing:"border-box"}}/>
                    <span style={{fontSize:12,color:t.muted}}>kcal</span>
                  </div>
                  <div style={{fontSize:11,color:t.muted,marginBottom:4}}>Macro split (% of calories)</div>
                  <div style={{display:"flex",gap:8,marginBottom:4}}>
                    {pctInput("p",pPct,"#60a5fa")}
                    {pctInput("c",cPct,"#fb923c")}
                    {pctInput("f",fPct,"#f472b6")}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    {[["Protein","#60a5fa"],["Carbs","#fb923c"],["Fat","#f472b6"]].map(([l,c])=>(
                      <div key={l} style={{flex:1,textAlign:"center",fontSize:10,color:c,fontWeight:600}}>{l}</div>
                    ))}
                  </div>
                  {sumPct!==100 && <div style={{fontSize:11,color:"#fb923c",marginTop:6}}>⚠️ Macro % adds to {sumPct}% (aim for 100%)</div>}
                </div>
              );
            })()}

            <div style={{height:1,background:t.border,marginBottom:14}}/>
            <div style={{fontSize:11,color:t.muted,marginBottom:12}}>Or drag the sliders:</div>

            {/* Calorie total derived from macros */}
            {(()=>{
              const derived = Math.round(settings.proteinGoal*4 + settings.carbsGoal*4 + settings.fatGoal*9);
              const diff = settings.calGoal - derived;
              return (
                <div style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:6}}>
                    <div>
                      <div style={{fontSize:13,color:t.text,fontWeight:700}}>Calories</div>
                      <div style={{fontSize:11,color:t.muted}}>From macros: {derived} kcal</div>
                    </div>
                    <span style={{fontSize:20,fontWeight:800,color:t.accent}}>{settings.calGoal} <span style={{fontSize:11,fontWeight:400}}>kcal</span></span>
                  </div>
                  <input type="range" min={1000} max={5000} step={50} value={settings.calGoal}
                    onChange={e=>{
                      const newCal = +e.target.value;
                      const oldCal = settings.proteinGoal*4 + settings.carbsGoal*4 + settings.fatGoal*9;
                      const ratio = newCal / (oldCal||1);
                      setSettings(s=>({
                        ...s,
                        calGoal: newCal,
                        proteinGoal: Math.round(Math.max(30, s.proteinGoal*ratio)),
                        carbsGoal:   Math.round(Math.max(50, s.carbsGoal*ratio)),
                        fatGoal:     Math.round(Math.max(20, s.fatGoal*ratio)),
                      }));
                    }}
                    style={{width:"100%",accentColor:t.accent}}/>
                  {Math.abs(diff)>20 && (
                    <div style={{fontSize:11,color:"#fb923c",marginTop:4}}>
                      ⚠️ Macro calories ({derived}) differ from calorie goal by {Math.abs(diff)} kcal
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{height:1,background:t.border,marginBottom:14}}/>

            {/* Macro sliders — each updates calGoal too */}
            {[
              {key:"proteinGoal", label:"Protein", unit:"g", cal:4, color:"#60a5fa", min:30,  max:400, step:5},
              {key:"carbsGoal",   label:"Carbs",   unit:"g", cal:4, color:"#fb923c", min:50,  max:600, step:5},
              {key:"fatGoal",     label:"Fat",     unit:"g", cal:9, color:"#f472b6", min:20,  max:200, step:5},
            ].map(({key,label,unit,cal,color,min,max,step})=>(
              <div key={key} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <div>
                    <span style={{fontSize:13,color:t.text,fontWeight:700}}>{label}</span>
                    <span style={{fontSize:11,color:t.muted,marginLeft:6}}>{settings[key]*cal} kcal</span>
                  </div>
                  <span style={{fontSize:13,fontWeight:700,color}}>{settings[key]} {unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={settings[key]}
                  onChange={e=>{
                    const val = +e.target.value;
                    setSettings(s=>{
                      const newCal = Math.round(
                        (key==="proteinGoal"?val:s.proteinGoal)*4 +
                        (key==="carbsGoal"  ?val:s.carbsGoal)*4 +
                        (key==="fatGoal"    ?val:s.fatGoal)*9
                      );
                      return {...s, [key]:val, calGoal:newCal};
                    });
                  }}
                  style={{width:"100%",accentColor:color}}/>
              </div>
            ))}

            {/* Macro split preview */}
            {(()=>{
              const totalCal = settings.proteinGoal*4 + settings.carbsGoal*4 + settings.fatGoal*9 || 1;
              const pPct = Math.round(settings.proteinGoal*4/totalCal*100);
              const cPct = Math.round(settings.carbsGoal*4/totalCal*100);
              const fPct = Math.round(settings.fatGoal*9/totalCal*100);
              return (
                <div style={{marginTop:4}}>
                  <div style={{fontSize:11,color:t.muted,marginBottom:6}}>Macro split</div>
                  <div style={{display:"flex",height:8,borderRadius:99,overflow:"hidden",gap:2}}>
                    <div style={{flex:pPct,background:"#60a5fa",borderRadius:"99px 0 0 99px"}}/>
                    <div style={{flex:cPct,background:"#fb923c"}}/>
                    <div style={{flex:fPct,background:"#f472b6",borderRadius:"0 99px 99px 0"}}/>
                  </div>
                  <div style={{display:"flex",gap:12,marginTop:6}}>
                    {[["Protein","#60a5fa",pPct],["Carbs","#fb923c",cPct],["Fat","#f472b6",fPct]].map(([l,c,p])=>(
                      <div key={l} style={{display:"flex",alignItems:"center",gap:4,fontSize:11}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:c,flexShrink:0}}/>
                        <span style={{color:t.muted}}>{l} <span style={{color:t.text,fontWeight:700}}>{p}%</span></span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Appearance</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {["dark","light"].map(th=>(
                <button key={th} onClick={()=>upd("theme",th)} style={{
                  flex:1,padding:"10px 0",borderRadius:10,cursor:"pointer",fontWeight:700,fontSize:13,
                  background:settings.theme===th?t.accent:t.card2,
                  color:settings.theme===th?t.accentText:t.muted,
                  border:`1px solid ${settings.theme===th?t.accent:t.border}`,transition:"all 0.2s"
                }}>{th==="dark"?"🌙 Dark":"☀️ Light"}</button>
              ))}
            </div>
            <div style={{fontSize:12,color:t.muted,marginBottom:10}}>Accent Color</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {ACCENTS.map(c=>(
                <button key={c} onClick={()=>upd("accent",c)} style={{
                  width:38,height:38,borderRadius:"50%",background:c,cursor:"pointer",
                  border:`3px solid ${settings.accent===c?t.text:"transparent"}`,
                  transition:"transform 0.15s",transform:settings.accent===c?"scale(1.2)":"scale(1)"
                }}/>
              ))}
            </div>
          </div>

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>📱 SMS Reminders</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
            <div style={{fontSize:12,color:t.muted,lineHeight:1.5,marginBottom:12}}>
              Get reminders as text messages — works even when the app is closed or deleted. Uses the same meal times below.
            </div>
            <label style={{display:"block",fontSize:12,fontWeight:700,color:t.muted,marginBottom:6}}>Your Phone Number</label>
            <input type="tel" placeholder="+14155551234" value={smsConfig.phone}
              onChange={e=>setSmsConfig(p=>({...p,phone:e.target.value}))}
              style={{width:"100%",background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 12px",color:t.text,fontSize:14,outline:"none",marginBottom:10,boxSizing:"border-box"}}/>
            <div style={{fontSize:11,color:t.muted,marginBottom:12}}>Include country code, e.g. +1 for US, +44 for UK.</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div onClick={()=>setSmsConfig(p=>({...p,enabled:!p.enabled}))} style={{
                width:44,height:24,borderRadius:99,cursor:"pointer",flexShrink:0,
                background:smsConfig.enabled?t.accent:t.border,position:"relative",transition:"background 0.2s"
              }}>
                <div style={{position:"absolute",top:3,left:smsConfig.enabled?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
              </div>
              <div style={{fontWeight:700,fontSize:13}}>SMS reminders {smsConfig.enabled?"on":"off"}</div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={saveSmsConfig} disabled={smsSaving}
                style={{flex:1,background:t.accent,border:"none",borderRadius:10,padding:"10px 14px",cursor:smsSaving?"wait":"pointer",fontSize:13,fontWeight:700,color:t.accentText,opacity:smsSaving?0.6:1}}>
                {smsSaving?"Working…":"💾 Save SMS settings"}
              </button>
              <button onClick={sendTestSms} disabled={smsSaving}
                style={{flex:1,background:t.card2,border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 14px",cursor:smsSaving?"wait":"pointer",fontSize:13,fontWeight:700,color:t.text,opacity:smsSaving?0.6:1}}>
                📨 Send test SMS
              </button>
            </div>
            {smsStatus&&<div style={{marginTop:10,fontSize:12,color:smsStatus.startsWith("⚠️")?"#f87171":t.accent,lineHeight:1.5}}>{smsStatus}</div>}
          </div>

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>🔔 Reminder Schedule</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
            <div style={{fontSize:12,color:t.muted,lineHeight:1.5,marginBottom:12}}>
              Set your meal times below. These drive both 📱 SMS reminders and browser notifications. <span style={{color:t.accent,fontWeight:600}}>After changing anything, tap "Save reminder settings" at the bottom to sync.</span>
            </div>
            {/* Meal reminders */}
            <div style={{fontWeight:700,fontSize:12,color:t.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:10}}>Meal Reminders</div>
            {[
              {key:"breakfast", emoji:"🍳", label:"Breakfast"},
              {key:"lunch",     emoji:"🥗", label:"Lunch"},
              {key:"dinner",    emoji:"🍽️", label:"Dinner"},
            ].map(({key,emoji,label})=>{
              const r=reminders[key]||{enabled:false,time:"08:00"};
              return (
                <div key={key} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,background:t.card2,borderRadius:12,padding:"12px 14px"}}>
                  <span style={{fontSize:18,flexShrink:0}}>{emoji}</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{label}</div>
                    <input type="time" value={r.time}
                      onChange={e=>updReminder(key,{time:e.target.value})}
                      style={{background:"transparent",border:`1px solid ${t.border}`,borderRadius:8,padding:"4px 8px",color:r.enabled?t.accent:t.muted,fontSize:12,outline:"none",colorScheme:t.dark?"dark":"light"}}/>
                  </div>
                  {/* Toggle */}
                  <div onClick={()=>updReminder(key,{enabled:!r.enabled})} style={{
                    width:44,height:24,borderRadius:99,cursor:"pointer",flexShrink:0,
                    background:r.enabled?t.accent:t.border,position:"relative",transition:"background 0.2s"
                  }}>
                    <div style={{position:"absolute",top:3,left:r.enabled?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
                  </div>
                </div>
              );
            })}

            {/* Protein reminder */}
            <div style={{fontWeight:700,fontSize:12,color:t.muted,textTransform:"uppercase",letterSpacing:0.8,margin:"16px 0 10px"}}>Protein Reminder</div>
            <div style={{background:t.card2,borderRadius:12,padding:"14px"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                <span style={{fontSize:20,flexShrink:0,marginTop:2}}>💪</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:4}}>Hourly Protein Check</div>
                  <div style={{fontSize:12,color:t.muted,lineHeight:1.5}}>
                    Reminds you every hour to log protein.
                    <span style={{color:t.accent,fontWeight:600}}> Silent 9pm – 5am.</span>
                  </div>
                </div>
                {/* Toggle */}
                <div onClick={()=>updReminder("protein",{enabled:!reminders.protein?.enabled})} style={{
                  width:44,height:24,borderRadius:99,cursor:"pointer",flexShrink:0,marginTop:2,
                  background:reminders.protein?.enabled?t.accent:t.border,position:"relative",transition:"background 0.2s"
                }}>
                  <div style={{position:"absolute",top:3,left:reminders.protein?.enabled?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
                </div>
              </div>
            </div>

            {/* Optional browser notifications */}
            {notifPerm==="default"&&(
              <button onClick={requestNotifPerm} style={{marginTop:12,background:"transparent",border:`1px solid ${t.border}`,borderRadius:10,padding:"10px 16px",cursor:"pointer",fontSize:12,fontWeight:600,color:t.muted,width:"100%"}}>
                🔔 Also enable browser notifications (optional)
              </button>
            )}
            {notifPerm==="granted"&&(
              <div style={{fontSize:11,color:t.accent,marginTop:12}}>✓ Browser notifications enabled (when app is open)</div>
            )}

            {/* Save button right here with the reminder settings */}
            <button onClick={saveSmsConfig} disabled={smsSaving}
              style={{marginTop:16,width:"100%",background:t.accent,color:t.accentText,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:smsSaving?"wait":"pointer",opacity:smsSaving?0.6:1}}>
              {smsSaving?"Working…":"💾 Save reminder settings"}
            </button>
            {smsStatus&&<div style={{marginTop:10,fontSize:12,color:smsStatus.startsWith("⚠️")?"#f87171":t.accent,lineHeight:1.5}}>{smsStatus}</div>}
          </div>

          {supabaseEnabled&&session&&(
            <>
              <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>🎙️ Siri Hands-Free Logging</div>
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
                <div style={{fontSize:13,color:t.muted,lineHeight:1.6,marginBottom:12}}>
                  Say <span style={{color:t.text,fontWeight:600}}>"Hey Siri, log food"</span> — Siri reads it back, you say yes, and it's added to today's diary. Works for food and weight, fully hands-free.
                </div>
                <button onClick={linkSiri} disabled={siriBusy}
                  style={{width:"100%",background:t.accent,color:t.accentText,border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:siriBusy?"wait":"pointer",opacity:siriBusy?0.6:1}}>
                  {siriBusy?"Linking…":"🔗 Link Siri to my account"}
                </button>
                {siriStatus&&<div style={{marginTop:10,fontSize:12,color:siriStatus.startsWith("⚠️")?"#f87171":t.accent,lineHeight:1.5}}>{siriStatus}</div>}
                <div style={{marginTop:14,fontSize:12,color:t.muted,marginBottom:6}}>Your Siri key (tap to copy — you'll paste it into the Shortcut once):</div>
                <div onClick={()=>{navigator.clipboard?.writeText(siriKey); setSiriStatus("✓ Key copied to clipboard.");}}
                  style={{background:t.card2,border:`1px dashed ${t.border}`,borderRadius:10,padding:"10px 12px",fontSize:12,fontFamily:"monospace",color:t.text,wordBreak:"break-all",cursor:"pointer"}}>
                  {siriKey}
                </div>
              </div>

              <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>👤 Account</div>
              <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:16}}>
                <div style={{fontSize:13,color:t.muted,marginBottom:4}}>Signed in as</div>
                <div style={{fontSize:14,fontWeight:700,marginBottom:12,wordBreak:"break-all"}}>{session.user.email||session.user.user_metadata?.email||"Google account"}</div>
                <div style={{fontSize:11,color:t.accent,marginBottom:12}}>☁️ Your data syncs to the cloud automatically</div>
                <button onClick={signOut}
                  style={{background:"transparent",border:`1px solid ${t.border}`,color:t.text,borderRadius:10,padding:"10px 16px",cursor:"pointer",fontSize:13,width:"100%",fontWeight:600}}>
                  Sign out
                </button>
              </div>
            </>
          )}

          <div style={{fontWeight:700,fontSize:11,color:t.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Data</div>
          <div style={{background:t.card,border:`1px solid ${t.border}`,borderRadius:14,padding:14,marginBottom:32}}>
            <div style={{fontSize:13,color:t.muted,marginBottom:12}}>
              {Object.keys(allData).filter(k=>allData[k]?.foods?.length).length} days · {Object.values(allData).reduce((a,d)=>a+(d?.foods?.length||0),0)} entries
            </div>
            <button onClick={()=>{
                if(window.confirm("Delete ALL data — food logs, weight, and body-fat photos? This can't be undone.")){
                  setAllData({});
                  setWeightLog([]);
                  setBodyFatLog([]);
                  setBodyFatResult(null);
                }
              }}
              style={{background:"transparent",border:"1px solid #f87171",color:"#f87171",borderRadius:10,padding:"10px 16px",cursor:"pointer",fontSize:13,width:"100%"}}>
              🗑️ Clear All Data (food, weight & body-fat photos)
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes dot{0%,100%{opacity:0.3;transform:scale(0.8)}50%{opacity:1;transform:scale(1.2)}}
        @keyframes micpulse{0%,100%{box-shadow:0 0 0 0 ${t.accent}66}50%{box-shadow:0 0 0 8px ${t.accent}00}}
        @keyframes pulse{0%,100%{opacity:0.6}50%{opacity:1}}
        @keyframes scan{0%{top:10%}50%{top:85%}100%{top:10%}}
        *{box-sizing:border-box;}
        input[type=range]{-webkit-appearance:none;height:4px;border-radius:99px;outline:none;cursor:pointer;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:#333;border-radius:4px;}
      `}</style>
    </div>
  );
}
