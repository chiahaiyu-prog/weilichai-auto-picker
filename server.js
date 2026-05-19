import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PILIO_URL = "https://www.pilio.idv.tw/lto/list.asp";
const BIGA_URL = "https://biga.com.tw/TOWMSG/showtowmsg_weili";

const pad = n => String(n).padStart(2, "0");
const uniq = arr => [...new Set(arr)];

function parseNumbers(text){
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(x => parseInt(x,10))
    .filter(n => n >= 1 && n <= 38);
}

async function fetchLatest3FromPilio(){
  const res = await fetch(PILIO_URL,{headers:{"user-agent":"Mozilla/5.0"}});
  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g," ");

  const rows = [];
  const seqs = text.match(/(?:\b\d{2}\b[\s,，、]*){6,7}/g) || [];

  for(const seq of seqs){
    const nums = parseNumbers(seq).slice(0,6);
    if(nums.length === 6){
      const key = nums.join(",");
      if(!rows.some(r=>r.key===key)) rows.push({key, nums});
    }
    if(rows.length >= 3) break;
  }

  return rows.slice(0,3).map(r=>r.nums);
}

async function fetchLatestBigaSixRows(){
  const res = await fetch(BIGA_URL,{headers:{"user-agent":"Mozilla/5.0"}});
  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g," ");

  const rows = [];
  const rowRegex = /開\s*(\d{1,2})\s*下\s*1\s*期\s*([0-9,，、\s]{3,30})\s*([0-9,，、\s]{8,90})/g;

  let m;
  while((m = rowRegex.exec(text)) !== null){
    const open = parseInt(m[1],10);
    const tails = parseNumbers(m[2]).map(n=>n%10);
    const nums = uniq(parseNumbers(m[3])).slice(0,6);

    if(open >= 1 && open <= 38 && nums.length >= 6){
      rows.push({open, tails:uniq(tails), nums});
    }

    if(rows.length >= 6) break;
  }

  return rows.slice(0,6);
}

function getCircleDelete(rows){
  const del = new Set();

  const positions = [
    [0,[2,3]],      // 第1排第3、4個
    [1,[1,2]],      // 第2排第2、3個
    [5,[0,1,2]]     // 第6排第1、2、3個
  ];

  positions.forEach(([rowIndex, posArr])=>{
    const row = rows[rowIndex];
    if(!row) return;

    posArr.forEach(pos=>{
      const n = row.nums[pos];
      if(n >= 1 && n <= 38) del.add(n);
    });
  });

  return del;
}

function getHotCount(rows,banned){
  const count = {};
  rows.forEach(row=>{
    row.nums.forEach(n=>{
      if(n >= 1 && n <= 38 && !banned.has(n)){
        count[n] = (count[n] || 0) + 1;
      }
    });
  });
  return count;
}

function scoreNumbers(pool,rows,banned,hotCount){
  const score = {};
  pool.forEach(n=>score[n]=1);

  Object.entries(hotCount).forEach(([num,count])=>{
    const n = Number(num);
    if(score[n] !== undefined && !banned.has(n)){
      score[n] += Number(count) * 20;
    }
  });

  rows.forEach(row=>{
    row.tails.forEach(t=>{
      pool.forEach(n=>{
        if(!banned.has(n) && n % 10 === t){
          score[n] += 2;
        }
      });
    });
  });

  return score;
}

function comboScore(combo,score){
  let s = combo.reduce((sum,n)=>sum+(score[n]||0),0);

  const odd = combo.filter(n=>n%2===1).length;
  const low = combo.filter(n=>n<=19).length;

  const zones = [
    combo.some(n=>n>=1 && n<=10),
    combo.some(n=>n>=11 && n<=20),
    combo.some(n=>n>=21 && n<=30),
    combo.some(n=>n>=31 && n<=38)
  ].filter(Boolean).length;

  if(odd === 3) s += 10;
  if(low === 3) s += 10;
  if(zones >= 3) s += 8;

  return s;
}

function generateCombos(pool,rows,banned,hotCount){
  const score = scoreNumbers(pool,rows,banned,hotCount);
  const weighted = [...pool].sort((a,b)=>(score[b]-score[a]) || a-b);
  const top = weighted.slice(0,Math.min(22,weighted.length));
  const all = [];

  for(let a=0;a<top.length;a++){
    for(let b=a+1;b<top.length;b++){
      for(let c=b+1;c<top.length;c++){
        for(let d=c+1;d<top.length;d++){
          for(let e=d+1;e<top.length;e++){
            for(let f=e+1;f<top.length;f++){
              const combo = [top[a],top[b],top[c],top[d],top[e],top[f]].sort((x,y)=>x-y);
              if(combo.some(n=>banned.has(n))) continue;
              all.push({combo,score:comboScore(combo,score)});
            }
          }
        }
      }
    }
  }

  all.sort((x,y)=>y.score-x.score);

  const picked = [];
  for(const item of all){
    let ok = true;
    for(const p of picked){
      const same = item.combo.filter(n=>p.includes(n)).length;
      if(same >= 5){
        ok = false;
        break;
      }
    }
    if(ok) picked.push(item.combo);
    if(picked.length >= 10) break;
  }

  return picked;
}

function analyze(latest3,bigaRows){
  const allBase = Array.from({length:38},(_,i)=>i+1);
  const first = latest3[0] || [];
  const allSelected = latest3.flat();

  const circleDelete = getCircleDelete(bigaRows);

  const plusDelete = new Set(
    allSelected.map(n=>n+1).filter(n=>n>=1 && n<=38)
  );

  const firstDelete = new Set(first);

  const banned = new Set([
    ...circleDelete,
    ...plusDelete,
    ...firstDelete
  ]);

  const hotCount = getHotCount(bigaRows,banned);

  const hotRank = Object.entries(hotCount)
    .map(([num,count])=>({num:Number(num),count:Number(count)}))
    .sort((a,b)=>b.count-a.count || a.num-b.num);

  const remaining = allBase.filter(n=>!banned.has(n));
  const combos = generateCombos(remaining,bigaRows,banned,hotCount);

  return {
    latest3,
    bigaRows,
    removedCircle:[...circleDelete].sort((a,b)=>a-b),
    removedPlusOne:[...plusDelete].sort((a,b)=>a-b),
    removedFirst:[...firstDelete].sort((a,b)=>a-b),
    hotRank,
    remaining,
    combos
  };
}

app.get("/",(req,res)=>{
  res.send(`
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>威力彩神級粉紅自動抓牌版</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",Arial,sans-serif;
  background:linear-gradient(135deg,#ff0f89,#ff65bf,#ffc5e6);
  color:#fff;
  padding:16px;
}
.card{
  max-width:720px;
  margin:auto;
  padding:20px;
  border-radius:34px;
  background:rgba(255,255,255,.25);
  box-shadow:0 0 60px rgba(255,255,255,.5),0 25px 80px rgba(180,0,95,.35);
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
}
.status{
  text-align:center;
  font-weight:900;
  margin:12px 0;
  color:#8a004c;
  background:white;
  padding:10px;
  border-radius:18px;
}
.section{
  margin-top:18px;
  padding:16px;
  border-radius:24px;
  background:rgba(255,255,255,.82);
  color:#8a004c;
}
.title{font-size:20px;font-weight:900;margin-bottom:12px}
.balls{display:flex;flex-wrap:wrap;gap:10px}
.ball{
  width:54px;
  height:54px;
  border-radius:999px;
  background:#ff168d;
  color:white;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:21px;
  font-weight:900;
}
.rowBox{
  margin-bottom:14px;
  padding:12px;
  border-radius:20px;
  background:rgba(255,255,255,.65);
}
.rowTitle{font-weight:900;margin-bottom:8px}
.rank{display:flex;flex-wrap:wrap;gap:10px}
.rankItem{
  background:#ff168d;
  color:white;
  padding:10px 13px;
  border-radius:999px;
  font-weight:900;
}
.combo{
  margin-top:14px;
  padding:14px;
  border-radius:22px;
  background:rgba(255,255,255,.65);
}
.combo-title{text-align:center;font-weight:900;margin-bottom:10px}
.small{text-align:center;font-size:14px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>威力彩<br>神級粉紅自動抓牌版</h1>
<button onclick="run()">重新自動更新抓牌</button>
<div class="small">只抓最新6排重複｜圈位第一刪｜三期+1全刪｜第一期全刪</div>
<div id="status" class="status">自動更新中...</div>
<div id="out"></div>
</div>

<script>
function pad(n){return String(n).padStart(2,"0")}
function balls(arr){
  if(!arr || arr.length===0) return "<div>無</div>";
  return '<div class="balls">'+arr.map(n=>'<div class="ball">'+pad(n)+'</div>').join("")+'</div>';
}
async function run(){
  document.getElementById("status").innerText="正在抓最新資料...";
  document.getElementById("out").innerHTML="";
  try{
    const res = await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
    const data = await res.json();
    if(data.error) throw new Error(data.detail || data.error);

    let html="";

    html += '<div class="section"><div class="title">Pilio 最新三期開獎號碼</div>';
    data.latest3.forEach((g,i)=>{
      html += '<div class="rowBox"><div class="rowTitle">第 '+(i+1)+' 期</div>'+balls(g)+'</div>';
    });
    html += '</div>';

    html += '<div class="section"><div class="title">大A網最新6排熱門號碼</div>';
    data.bigaRows.forEach((r,i)=>{
      html += '<div class="rowBox"><div class="rowTitle">第 '+(i+1)+' 排：開 '+pad(r.open)+'</div>'+balls(r.nums)+'</div>';
    });
    html += '</div>';

    html += '<div class="section"><div class="title">第一優先刪除：你圈的位置</div>';
    html += '<div class="small">第1排第3、4個｜第2排第2、3個｜第6排第1、2、3個</div>';
    html += balls(data.removedCircle)+'</div>';

    html += '<div class="section"><div class="title">三期全部 +1 刪除號碼</div>'+balls(data.removedPlusOne)+'</div>';
    html += '<div class="section"><div class="title">第一期原號刪除</div>'+balls(data.removedFirst)+'</div>';

    html += '<div class="section"><div class="title">最新6排重複號碼統計</div><div class="rank">';
    data.hotRank.forEach(x=>{
      html += '<div class="rankItem">'+pad(x.num)+'：'+x.count+'次</div>';
    });
    html += '</div></div>';

    html += '<div class="section"><div class="title">刪除後剩餘號碼</div>'+balls(data.remaining)+'</div>';

    html += '<div class="section"><div class="title">重複熱門優先分析10組</div>';
    data.combos.forEach((g,i)=>{
      html += '<div class="combo"><div class="combo-title">第 '+(i+1)+' 組</div>'+balls(g)+'</div>';
    });
    html += '</div>';

    document.getElementById("out").innerHTML=html;
    document.getElementById("status").innerText="已完成自動更新";
  }catch(err){
    document.getElementById("status").innerText="抓取或分析失敗";
    document.getElementById("out").innerHTML='<div class="section">錯誤：'+err.message+'</div>';
  }
}
window.onload=run;
</script>
</body>
</html>
  `);
});

app.post("/api/analyze",async(req,res)=>{
  try{
    const latest3 = await fetchLatest3FromPilio();
    const bigaRows = await fetchLatestBigaSixRows();
    res.json(analyze(latest3,bigaRows));
  }catch(err){
    res.status(500).json({error:"分析失敗",detail:String(err)});
  }
});

app.listen(PORT,()=>{
  console.log("Weilichai final server running on port "+PORT);
});
