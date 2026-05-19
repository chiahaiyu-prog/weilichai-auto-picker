import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

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
  const res = await fetch(BIGA_URL,{
    headers:{ "user-agent":"Mozilla/5.0" }
  });

  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g," ");

  const dragRows = [];
  const rowRegex = /開\s*(\d{1,2})\s*下\s*1\s*期\s*([0-9,，、\s]{3,20})\s*([0-9,，、\s]{8,80})/g;

  let m;
  while((m = rowRegex.exec(text)) !== null){
    const open = parseInt(m[1],10);
    const tails = parseNumbers(m[2]).map(n=>n%10);
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
        candidates.push({key, nums:first6});
      }
    }
  }

  return {
    latest3: candidates.slice(0,3).map(x=>x.nums),
    dragRows: dragRows.slice(0,80)
  };
}

function scoreNumbers(pool, dragRows){
  const score = {};
  for(const n of pool) score[n] = 1;

  // 熱門號碼重複越多，分數越高
  for(const row of dragRows){
    for(const n of row.nums){
      if(score[n] !== undefined) score[n] += 8;
    }

    // 熱門尾數加權
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
  const top = weighted.slice(0, Math.min(18, weighted.length));
  const all = [];

  for(let a=0;a<top.length;a++){
    for(let b=a+1;b<top.length;b++){
      for(let c=b+1;c<top.length;c++){
        for(let d=c+1;d<top.length;d++){
          for(let e=d+1;e<top.length;e++){
            for(let f=e+1;f<top.length;f++){
              const combo=[top[a],top[b],top[c],top[d],top[e],top[f]].sort((x,y)=>x-y);
              all.push({combo, score:comboScore(combo,score)});
            }
          }
        }
      }
    }
  }

  all.sort((x,y)=>y.score-x.score);
  return all.slice(0,10).map(x=>x.combo);
}

function analyze(latest3, dragRows=[]){
  const allBase = Array.from({length:38},(_,i)=>i+1);

  const first = latest3[0] || [];
  const allSelected = latest3.flat();

  // 前三期全部 +1 刪除
  const plusDelete = new Set(
    allSelected.map(n=>n+1).filter(n=>n>=1 && n<=38)
  );

  // 第一期原號碼刪除
  const firstDelete = new Set(first);

  // 你圈起來的位置優先刪除
  const circleDelete = new Set();

  const circleDeletePositions = [
    [0, [2,3]],     // 第1排第3、4個
    [1, [0,1]],     // 第2排第1、2個
    [5, [0,1,2]]    // 第6排第1、2、3個
  ];

  circleDeletePositions.forEach(([rowIndex, positions])=>{
    const row = dragRows[rowIndex];
    if(row && row.nums){
      positions.forEach(pos=>{
        const num = row.nums[pos];
        if(num >= 1 && num <= 38){
          circleDelete.add(num);
        }
      });
    }
  });

  const pool = allBase.filter(n =>
    !plusDelete.has(n) &&
    !firstDelete.has(n) &&
    !circleDelete.has(n)
  );

  const combos = generateCombos(pool, dragRows);

  return {
    latest3,
    removedPlusOne:[...plusDelete].sort((a,b)=>a-b),
    removedFirst:[...firstDelete].sort((a,b)=>a-b),
    removedCircle:[...circleDelete].sort((a,b)=>a-b),
    remaining:pool,
    combos
  };
}

app.get("/", (req,res)=>{
  res.send(`
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>威力彩神級粉紅分析版</title>
<style>
body{
  margin:0;
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC",Arial,sans-serif;
  color:white;
  background:
    radial-gradient(circle at 20% 10%,#fff 0,#ffd6ec 12%,transparent 30%),
    radial-gradient(circle at 85% 20%,#ff4fb3 0,transparent 28%),
    linear-gradient(135deg,#ff0f89,#ff69c7,#ffc6e7);
  padding:18px;
}
.card{
  max-width:620px;
  margin:auto;
  padding:22px;
  border-radius:34px;
  background:rgba(255,255,255,.22);
  backdrop-filter:blur(22px);
  box-shadow:0 0 60px rgba(255,255,255,.45),0 25px 80px rgba(180,0,95,.35);
}
h1{text-align:center;font-size:30px;text-shadow:0 0 20px white}
button{
  width:100%;
  padding:18px;
  border:0;
  border-radius:24px;
  font-size:21px;
  font-weight:900;
  color:#ff168d;
  background:white;
  box-shadow:0 0 28px white;
}
.section{
  margin-top:18px;
  padding:16px;
  border-radius:24px;
  background:rgba(255,255,255,.24);
}
.title{font-size:20px;font-weight:900;margin-bottom:12px}
.balls{display:flex;flex-wrap:wrap;gap:10px}
.ball{
  width:54px;height:54px;border-radius:999px;
  background:white;color:#ff168d;
  display:flex;align-items:center;justify-content:center;
  font-size:21px;font-weight:900;
  box-shadow:0 0 22px rgba(255,255,255,.9);
}
.combo{margin-top:14px;padding:14px;border-radius:22px;background:rgba(255,255,255,.22)}
.combo-title{text-align:center;font-weight:900;margin-bottom:10px}
.small{font-size:14px;opacity:.9;text-align:center;margin-top:10px}
</style>
</head>
<body>
<div class="card">
  <h1>威力彩神級粉紅分析版</h1>
  <button onclick="run()">自動更新抓牌</button>
  <div class="small">自動抓大A網資料，三期+1刪除，第一期刪除，圈選位置刪除，再分析10組</div>
  <div id="out"></div>
</div>

<script>
function pad(n){return String(n).padStart(2,"0")}
function balls(arr){
  return '<div class="balls">'+arr.map(n=>'<div class="ball">'+pad(n)+'</div>').join('')+'</div>';
}

async function run(){
  document.getElementById("out").innerHTML = '<div class="section">分析中...</div>';

  const res = await fetch("/api/analyze",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({})
  });

  const data = await res.json();

  let html = "";

  html += '<div class="section"><div class="title">最近三期號碼</div>';
  data.latest3.forEach((g,i)=>{
    html += '<div style="margin-bottom:12px;font-weight:900">第 '+(i+1)+' 期</div>';
    html += balls(g);
  });
  html += '</div>';

  html += '<div class="section"><div class="title">前三期 +1 刪除號碼</div>';
  html += balls(data.removedPlusOne);
  html += '</div>';

  html += '<div class="section"><div class="title">第一期原號刪除</div>';
  html += balls(data.removedFirst);
  html += '</div>';

  html += '<div class="section"><div class="title">圈選位置優先刪除</div>';
  html += balls(data.removedCircle);
  html += '</div>';

  html += '<div class="section"><div class="title">刪除後剩餘號碼</div>';
  html += balls(data.remaining);
  html += '</div>';

  html += '<div class="section"><div class="title">重複熱門號碼優先分析 10 組</div>';
  data.combos.forEach((g,i)=>{
    html += '<div class="combo">';
    html += '<div class="combo-title">第 '+(i+1)+' 組</div>';
    html += balls(g);
    html += '</div>';
  });
  html += '</div>';

  document.getElementById("out").innerHTML = html;
}
</script>
</body>
</html>
  `);
});

app.post("/api/analyze", async (req,res)=>{
  try{
    const data = await fetchBigaData();
    const result = analyze(data.latest3, data.dragRows);
    res.json(result);
  }catch(err){
    res.status(500).json({
      error:"分析失敗",
      detail:String(err)
    });
  }
});

app.listen(PORT, ()=>{
  console.log("Weilichai running on port "+PORT);
});
