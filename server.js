import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BIGA_URL = "https://biga.com.tw/TOWMSG/showtowmsg_weili";

function pad(n){ return String(n).padStart(2,"0"); }
function uniq(arr){ return [...new Set(arr)]; }

function parseNumbers(text){
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(x => parseInt(x,10))
    .filter(n => n >= 1 && n <= 38);
}

// 盡量從大A網文字抓最新開獎/拖牌資料。
// 若網站版面改變，可能要微調 selector，但整體會先用全頁文字抓。
async function fetchBigaData(){
  const res = await fetch(BIGA_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari"
    }
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  // 抓「開 xx」附近的拖牌資料
  const dragRows = [];
  const rowRegex = /開\s*(\d{1,2})\s*下\s*1\s*期\s*([0-9,，、\s]{3,20})\s*([0-9,，、\s]{8,80})/g;
  let m;
  while((m = rowRegex.exec(text)) !== null){
    const open = parseInt(m[1],10);
    const tails = parseNumbers(m[2]).map(n => n % 10);
    const nums = parseNumbers(m[3]);
    if(open>=1 && open<=38 && nums.length>=3){
      dragRows.push({open, tails: uniq(tails), nums: uniq(nums)});
    }
  }

  // 抓可能的開獎號碼列：保守抓 6 個 01-38 連續數字
  const candidates = [];
  const numberSeq = text.match(/(?:\b\d{2}\b[\s,，、]*){6,7}/g) || [];
  for(const seq of numberSeq){
    const nums = parseNumbers(seq);
    if(nums.length >= 6){
      const first6 = nums.slice(0,6);
      if(first6.every(n=>n>=1 && n<=38)){
        const key = first6.join(",");
        if(!candidates.some(x=>x.key===key)){
          candidates.push({key, nums:first6});
        }
      }
    }
  }

  return {
    source: BIGA_URL,
    updatedAt: new Date().toISOString(),
    latest3: candidates.slice(0,3).map(x=>x.nums),
    dragRows: dragRows.slice(0,80)
  };
}

function scoreNumbers(pool, dragRows){
  const score = {};
  for(const n of pool) score[n] = 1;

  for(const row of dragRows){
    for(const n of row.nums){
      if(score[n] !== undefined) score[n] += 5;
    }
    for(const t of row.tails){
      for(const n of pool){
        if(n % 10 === t) score[n] += 2;
      }
    }
  }

  return score;
}

function comboScore(combo, score){
  let s = combo.reduce((a,n)=>a+(score[n]||0),0);
  const odd = combo.filter(n=>n%2===1).length;
  const low = combo.filter(n=>n<=19).length;
  const zones = [
    combo.some(n=>n>=1 && n<=10),
    combo.some(n=>n>=11 && n<=20),
    combo.some(n=>n>=21 && n<=30),
    combo.some(n=>n>=31 && n<=38)
  ].filter(Boolean).length;

  if(odd===3) s += 10;
  if(low===3) s += 10;
  if(zones>=3) s += 8;

  const sorted=[...combo].sort((a,b)=>a-b);
  let consecutive=0;
  for(let i=1;i<sorted.length;i++){
    if(sorted[i]-sorted[i-1]===1) consecutive++;
  }
  if(consecutive<=1) s += 6;
  if(consecutive>=3) s -= 12;

  return s;
}

function generateCombos(pool, dragRows){
  const score = scoreNumbers(pool, dragRows);
  const weighted = [...pool].sort((a,b)=>(score[b]-score[a]) || a-b);
  const top = weighted.slice(0, Math.min(18, weighted.length));
  const all = [];

  // 產生很多組候選，再依頭獎感覺分數排序
  for(let a=0;a<top.length;a++){
    for(let b=a+1;b<top.length;b++){
      for(let c=b+1;c<top.length;c++){
        for(let d=c+1;d<top.length;d++){
          for(let e=d+1;e<top.length;e++){
            for(let f=e+1;f<top.length;f++){
              const combo=[top[a],top[b],top[c],top[d],top[e],top[f]].sort((x,y)=>x-y);
              all.push({combo, score: comboScore(combo, score)});
            }
          }
        }
      }
    }
  }

  all.sort((x,y)=>y.score-x.score);
  const picked=[];
  const usedKeys=new Set();

  for(const item of all){
    const key=item.combo.join("-");
    if(usedKeys.has(key)) continue;

    // 不要每組太像：跟前面最多重複 4 個
    let ok=true;
    for(const p of picked){
      const same=item.combo.filter(n=>p.includes(n)).length;
      if(same>=5){ ok=false; break; }
    }
    if(!ok) continue;

    picked.push(item.combo);
    usedKeys.add(key);
    if(picked.length>=10) break;
  }

  return picked;
}

function analyze(latest3, manualExclude=[], dragRows=[]){
  const allBase = Array.from({length:38},(_,i)=>i+1);
  const first = latest3[0] || [];
  const allSelected = latest3.flat();

  const plusDelete = new Set(allSelected.map(n=>n+1).filter(n=>n>=1 && n<=38));
  const firstDelete = new Set(first);
  const manualDelete = new Set(manualExclude);

  const pool = allBase.filter(n =>
    !plusDelete.has(n) &&
    !firstDelete.has(n) &&
    !manualDelete.has(n)
  );

  const combos = generateCombos(pool, dragRows);

  return {
    latest3,
    removedPlusOne: [...plusDelete].sort((a,b)=>a-b),
    removedFirst: [...firstDelete].sort((a,b)=>a-b),
    removedManual: [...manualDelete].sort((a,b)=>a-b),
    remaining: pool,
    combos
  };
}

app.get("/api/biga", async (req,res)=>{
  try{
    const data = await fetchBigaData();
    res.json(data);
  }catch(err){
    res.status(500).json({error:"抓取大A網失敗", detail:String(err)});
  }
});

app.post("/api/analyze", async (req,res)=>{
  try{
    let {latest3, manualExclude} = req.body || {};
    let dragRows = [];

    if(!latest3 || latest3.length < 3){
      const data = await fetchBigaData();
      latest3 = data.latest3;
      dragRows = data.dragRows;
    }else{
      const data = await fetchBigaData().catch(()=>({dragRows:[]}));
      dragRows = data.dragRows || [];
    }

    const result = analyze(latest3, manualExclude || [], dragRows);
    res.json(result);
  }catch(err){
    res.status(500).json({error:"分析失敗", detail:String(err)});
  }
});

app.listen(PORT, ()=>{
  console.log("Weilichai auto picker running on port " + PORT);
});