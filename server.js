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

/* =========================
   基本抓號
========================= */

function parseNumbers(text) {
  return (text.match(/\b\d{1,2}\b/g) || [])
    .map(x => parseInt(x, 10))
    .filter(n => n >= 1 && n <= 38);
}

/* =========================
   Pilio 1～9期
   只取前面號碼，不取第二區
========================= */

async function fetchPilioRows() {
  const res = await fetch(PILIO_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    }
  });

  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const rows = [];
  const seqs = text.match(/(?:\b\d{1,2}\b[\s,，、]*){6,7}/g) || [];

  for (const seq of seqs) {
    const nums = parseNumbers(seq).slice(0, 6);

    if (nums.length === 6) {
      const key = nums.join(",");
      if (!rows.some(r => r.key === key)) {
        rows.push({ key, nums });
      }
    }

    if (rows.length >= 9) break;
  }

  return rows.map(r => r.nums);
}

/* =========================
   大A 黃色熱門號碼
========================= */

async function fetchLatestBigaSixRows() {
  const res = await fetch(BIGA_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    }
  });

  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const rows = [];

  const rowRegex =
    /開\s*(\d{1,2})\s*下\s*1\s*期\s*([0-9,，、\s]{3,40})\s*([0-9,，、\s]{8,120})/g;

  let m;

  while ((m = rowRegex.exec(text)) !== null) {
    const open = parseInt(m[1], 10);
    const tails = parseNumbers(m[2]).map(n => n % 10);
    const nums = uniq(parseNumbers(m[3])).slice(0, 6);

    if (open >= 1 && open <= 38 && nums.length === 6) {
      rows.push({
        open,
        tails: uniq(tails),
        nums
      });
    }

    if (rows.length >= 6) break;
  }

  return rows.slice(0, 6);
}

/* =========================
   圈位第一刪除
   會依照大A更新後的位置刪
   不是固定號碼
========================= */

function getCircleDelete(rows) {
  const del = new Set();

  const circlePositions = [
    [0, [2, 3]],       // 第1排圈起來的位置
    [1, [1, 2]],       // 第2排圈起來的位置
    [5, [0, 1, 2]]     // 第6排圈起來的位置
  ];

  circlePositions.forEach(([rowIndex, positions]) => {
    const row = rows[rowIndex];
    if (!row) return;

    positions.forEach(pos => {
      const n = row.nums[pos];
      if (n >= 1 && n <= 38) del.add(n);
    });
  });

  return del;
}

/* =========================
   黃色區
========================= */

function getYellowSet(rows) {
  const s = new Set();

  rows.forEach(r => {
    r.nums.forEach(n => s.add(n));
  });

  return s;
}

/* =========================
   灰色紅位記憶 + 黃色分數
========================= */

function getYellowScore(rows, banned) {
  const score = {};

  rows.forEach((row, rowIndex) => {
    row.nums.forEach((n, posIndex) => {
      if (banned.has(n)) return;

      if (!score[n]) score[n] = 0;

      // 黃色出現基本分
      score[n] += 10;

      // 熱門尾數加權
      if (row.tails.includes(n % 10)) {
        score[n] += 5;
      }

      // 灰色紅位記憶：第2、第4、第6位加權
      if ([1, 3, 5].includes(posIndex)) {
        score[n] += 8;
      }

      // 後排加權
      if (rowIndex >= 3) {
        score[n] += 2;
      }
    });
  });

  return score;
}

/* =========================
   黃色抓4隻
========================= */

function pickTopFromYellow(rows, banned, count = 4) {
  const score = getYellowScore(rows, banned);

  return Object.entries(score)
    .map(([num, s]) => ({
      num: Number(num),
      score: s
    }))
    .sort((a, b) => b.score - a.score || a.num - b.num)
    .slice(0, count)
    .map(x => x.num);
}

/* =========================
   黃色外補2隻
========================= */

function pickOutsideTwo(allBase, yellowSet, banned, rows) {
  const candidates = allBase.filter(
    n => !yellowSet.has(n) && !banned.has(n)
  );

  const tailScore = {};

  rows.forEach(r => {
    r.tails.forEach(t => {
      candidates.forEach(n => {
        if (n % 10 === t) {
          tailScore[n] = (tailScore[n] || 0) + 3;
        }
      });
    });
  });

  return candidates
    .map(n => ({
      num: n,
      score:
        (tailScore[n] || 0) +
        (n >= 11 && n <= 30 ? 4 : 2) +
        (n % 2 === 1 ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.num - b.num)
    .slice(0, 2)
    .map(x => x.num);
}

/* =========================
   產生10組
========================= */

function makeTenCombos(core4, outside2, remaining) {
  const base = [...core4, ...outside2].sort((a, b) => a - b);
  const extras = remaining.filter(n => !base.includes(n));

  const combos = [];

  combos.push(base);

  for (let i = 0; i < 9; i++) {
    let combo = [...base];

    if (extras.length > 0) {
      const replaceIndex = i % 6;
      const extra = extras[i % extras.length];
      combo[replaceIndex] = extra;
    }

    combo = uniq(combo).slice(0, 6).sort((a, b) => a - b);

    while (combo.length < 6 && extras.length > 0) {
      const add = extras[(i + combo.length) % extras.length];
      if (!combo.includes(add)) combo.push(add);
      combo.sort((a, b) => a - b);
    }

    combos.push(combo);
  }

  return combos.slice(0, 10);
}

/* =========================
   主分析
========================= */

function analyze(pilioRows, bigaRows) {
  const allBase = Array.from({ length: 38 }, (_, i) => i + 1);

  // Pilio 1～5期
  const latest5 = pilioRows.slice(0, 5);

  // Pilio 最新三期
  const latest3 = pilioRows.slice(0, 3);

  // 第1期刪除
  const first = pilioRows[0] || [];

  // 第9期刪除
  const ninth = pilioRows[8] || [];

  // 三期 +1 刪除
  const allSelected = latest3.flat();

  const plusDelete = new Set(
    allSelected
      .map(n => n + 1)
      .filter(n => n >= 1 && n <= 38)
  );

  const firstDelete = new Set(first);
  const ninthDelete = new Set(ninth);

  // 圈位第一刪除
  const circleDelete = getCircleDelete(bigaRows);

  const banned = new Set([
    ...circleDelete,
    ...plusDelete,
    ...firstDelete,
    ...ninthDelete
  ]);

  const yellowSet = getYellowSet(bigaRows);

  const yellow4 = pickTopFromYellow(bigaRows, banned, 4);
  const outside2 = pickOutsideTwo(allBase, yellowSet, banned, bigaRows);

  const remaining = allBase.filter(n => !banned.has(n));

  const combos = makeTenCombos(yellow4, outside2, remaining);

  const yellowScore = getYellowScore(bigaRows, banned);

  const yellowRank = Object.entries(yellowScore)
    .map(([num, score]) => ({
      num: Number(num),
      score
    }))
    .sort((a, b) => b.score - a.score || a.num - b.num);

  return {
    latest5,
    latest3,
    ninth,
    bigaRows,

    removedCircle: [...circleDelete].sort((a, b) => a - b),
    removedPlusOne: [...plusDelete].sort((a, b) => a - b),
    removedFirst: [...firstDelete].sort((a, b) => a - b),
    removedNinth: [...ninthDelete].sort((a, b) => a - b),

    yellowRank,
    yellow4,
    outside2,

    final6: [...yellow4, ...outside2].sort((a, b) => a - b),

    remaining,
    combos
  };
}

/* =========================
   UI
========================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>威力彩 4+2 自動抓牌</title>
<style>
*{
  box-sizing:border-box;
}
body{
  margin:0;
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",Arial,sans-serif;
  background:
    radial-gradient(circle at top,#ffffff 0,#ffb7df 20%,transparent 38%),
    linear-gradient(135deg,#ff0f89,#ff65bf,#ffc5e6);
  color:#fff;
  padding:16px;
}
.card{
  max-width:760px;
  margin:auto;
  padding:20px;
  border-radius:34px;
  background:rgba(255,255,255,.25);
  box-shadow:
    0 0 60px rgba(255,255,255,.55),
    0 25px 80px rgba(180,0,95,.35);
  backdrop-filter:blur(14px);
}
h1{
  text-align:center;
  font-size:32px;
  line-height:1.25;
  margin:8px 0 16px;
  text-shadow:0 0 20px white;
}
button{
  width:100%;
  padding:18px;
  border:0;
  border-radius:24px;
  font-size:21px;
  font-weight:900;
  color:#ff168d;
  background:white;
  box-shadow:0 12px 28px rgba(120,0,70,.28);
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
  background:rgba(255,255,255,.86);
  color:#8a004c;
}
.title{
  font-size:20px;
  font-weight:900;
  margin-bottom:12px;
}
.balls{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
}
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
  box-shadow:0 8px 20px rgba(255,22,141,.35);
}
.ball.gray{
  background:#737373;
}
.ball.yellow{
  background:#ffd400;
  color:#2b1a00;
}
.rowBox{
  margin-bottom:14px;
  padding:12px;
  border-radius:20px;
  background:rgba(255,255,255,.68);
}
.rowTitle{
  font-weight:900;
  margin-bottom:8px;
}
.rank{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
}
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
  background:rgba(255,255,255,.68);
}
.combo-title{
  text-align:center;
  font-weight:900;
  margin-bottom:10px;
}
.small{
  text-align:center;
  font-size:14px;
  line-height:1.7;
  margin-bottom:10px;
}
.rule{
  font-size:14px;
  line-height:1.7;
  font-weight:800;
}
</style>
</head>
<body>

<div class="card">
  <h1>威力彩<br>4+2 自動抓牌版</h1>

  <button onclick="run()">重新自動更新抓牌</button>

  <div class="small">
    Pilio 1～5期｜第1期刪｜第9期刪｜三期+1刪｜圈位第一刪｜黃色4隻｜外補2隻｜10組
  </div>

  <div id="status" class="status">自動更新中...</div>
  <div id="out"></div>
</div>

<script>
function pad(n){
  return String(n).padStart(2,"0");
}

function balls(arr, cls=""){
  if(!arr || arr.length === 0){
    return "<div>無</div>";
  }

  return '<div class="balls">' +
    arr.map(n => '<div class="ball '+cls+'">' + pad(n) + '</div>').join("") +
  '</div>';
}

async function run(){
  document.getElementById("status").innerText = "正在抓最新資料...";
  document.getElementById("out").innerHTML = "";

  try{
    const res = await fetch("/api/analyze",{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({})
    });

    const data = await res.json();

    if(data.error){
      throw new Error(data.detail || data.error);
    }

    let html = "";

    html += '<div class="section">';
    html += '<div class="title">Pilio 1～5期開獎號碼</div>';

    data.latest5.forEach((g,i)=>{
      html += '<div class="rowBox">';
      html += '<div class="rowTitle">第 ' + (i+1) + ' 期</div>';
      html += balls(g);
      html += '</div>';
    });

    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">大A 黃色最新6排</div>';

    data.bigaRows.forEach((r,i)=>{
      html += '<div class="rowBox">';
      html += '<div class="rowTitle">第 ' + (i+1) + ' 排：開 ' + pad(r.open) + '</div>';
      html += balls(r.nums,"yellow");
      html += '</div>';
    });

    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">第一優先刪除：更新圈位</div>';
    html += '<div class="rule">';
    html += '圈位不是固定號碼，是大A更新後相同位置第一刪除。<br>';
    html += '目前圈位：第1排第3、4個｜第2排第2、3個｜第6排第1、2、3個';
    html += '</div>';
    html += balls(data.removedCircle,"gray");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">三期 +1 刪除</div>';
    html += balls(data.removedPlusOne,"gray");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">第1期原號刪除</div>';
    html += balls(data.removedFirst,"gray");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">第9期原號刪除</div>';
    html += balls(data.removedNinth,"gray");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">黃色分析排行</div>';
    html += '<div class="rank">';

    data.yellowRank.slice(0,16).forEach(x=>{
      html += '<div class="rankItem">' + pad(x.num) + '：' + x.score + '</div>';
    });

    html += '</div>';
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">黃色區抓4隻</div>';
    html += balls(data.yellow4,"yellow");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">黃色外補2隻</div>';
    html += balls(data.outside2);
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">最終6隻</div>';
    html += balls(data.final6);
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">刪除後剩餘號碼</div>';
    html += balls(data.remaining);
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">最後10組</div>';

    data.combos.forEach((g,i)=>{
      html += '<div class="combo">';
      html += '<div class="combo-title">第 ' + (i+1) + ' 組</div>';
      html += balls(g);
      html += '</div>';
    });

    html += '</div>';

    document.getElementById("out").innerHTML = html;
    document.getElementById("status").innerText = "已完成自動更新";

  }catch(err){
    document.getElementById("status").innerText = "抓取或分析失敗";
    document.getElementById("out").innerHTML =
      '<div class="section">錯誤：' + err.message + '</div>';
  }
}

window.onload = run;
</script>

</body>
</html>
  `);
});

/* =========================
   API
========================= */

app.post("/api/analyze", async (req, res) => {
  try {
    const pilioRows = await fetchPilioRows();
    const bigaRows = await fetchLatestBigaSixRows();

    res.json(analyze(pilioRows, bigaRows));
  } catch (err) {
    res.status(500).json({
      error: "分析失敗",
      detail: String(err)
    });
  }
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log("Weilichai 4+2 server running on port " + PORT);
});
