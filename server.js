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

async function fetchBigaData(){
  const res = await fetch(BIGA_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari"
    }
  });

  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const dragRows = [];
  const rowRegex = /開\s*(\d{1,2})\s*下\s*1\s*期\s*([0-9,，、\s]{3,20})\s*([0-9,，、\s]{8,80})/g;
  let m;

  while((m = rowRegex.exec(text)) !== null){
    const open = parseInt(m[1],10);
    const tails = parseNumbers(m[2]).map(n => n % 10);
    const nums = parseNumbers(m[3]);

    if(open>=1 && open<=38 && nums.length>=3){
      dragRows.push({
        open,
        tails: uniq(tails),
        nums: uniq(nums)
      });
    }
  }

  const candidates = [];
  const numberSeq = text.match(/(?:\b\d{2}\b[\s,，、]*){6,7}/g) || [];

  for(const seq of numberSeq){
    const nums = parseNumbers(seq);

    if(nums.length >= 6){
      const first6 = nums.slice(0,6);
      const key = first6.join(",");

      if(!candidates.some(x=>x.key===key)){
        candidates.push({ key, nums:first6 });
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

  if(odd===3) s += 10;
  if(low===3) s += 10;

  return s;
}

function generateCombos(pool, dragRows){
  const score = scoreNumbers(pool, dragRows);
  const weighted = [...pool].sort((a,b)=>(score[b]-score[a]) || a-b);
  const top = weighted.slice(0,18);

  const all = [];

  for(let a=0;a<top.length;a++){
    for(let b=a+1;b<top.length;b++){
      for(let c=b+1;c<top.length;c++){
        for(let d=c+1;d<top.length;d++){
          for(let e=d+1;e<top.length;e++){
            for(let f=e+1;f<top.length;f++){

              const combo = [
                top[a], top[b], top[c],
                top[d], top[e], top[f]
              ].sort((x,y)=>x-y);

              all.push({
                combo,
                score: comboScore(combo, score)
              });
            }
          }
        }
      }
    }
  }

  all.sort((x,y)=>y.score-x.score);

  return all.slice(0,10).map(x=>x.combo);
}

function analyze(latest3, manualExclude=[], dragRows=[]){
  const allBase = Array.from({length:38},(_,i)=>i+1);

  const first = latest3[0] || [];
  const allSelected = latest3.flat();

  const plusDelete = new Set(
    allSelected.map(n=>n+1).filter(n=>n>=1 && n<=38)
  );

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
    remaining: pool,
    combos
  };
}

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>威力彩自動抓牌版</title>
</head>
<body style="font-family:Arial;text-align:center;padding:40px;">
<h1>威力彩自動抓牌版</h1>

<button onclick="run()" style="font-size:22px;padding:15px 30px;">
自動更新抓牌
</button>

<pre id="out" style="font-size:18px;white-space:pre-wrap;"></pre>

<script>
async function run(){
  document.getElementById("out").innerText = "分析中...";

  const res = await fetch("/api/analyze", {
    method:"POST",
    headers:{
      "Content-Type":"application/json"
    },
    body:JSON.stringify({})
  });

  const data = await res.json();

  let txt = "";

  data.combos.forEach((g,i)=>{
    txt += "第"+(i+1)+"組："
      + g.map(n=>String(n).padStart(2,"0")).join("、")
      + "\\n";
  });

  document.getElementById("out").innerText = txt;
}
</script>

</body>
</html>
  `);
});

app.get("/api/biga", async (req,res)=>{
  try{
    const data = await fetchBigaData();
    res.json(data);
  }catch(err){
    res.status(500).json({
      error:"抓取大A網失敗",
      detail:String(err)
    });
  }
});

app.post("/api/analyze", async (req,res)=>{
  try{
    const data = await fetchBigaData();

    const result = analyze(
      data.latest3,
      [],
      data.dragRows
    );

    res.json(result);

  }catch(err){
    res.status(500).json({
      error:"分析失敗",
      detail:String(err)
    });
  }
});

app.listen(PORT, ()=>{
  console.log("威力彩自動抓牌版 running on port " + PORT);
});
