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

function uniq(arr) {
  return [...new Set(arr.map(Number))]
    .filter(n => n >= 1 && n <= 38)
    .sort((a, b) => a - b);
}

function parseNumbers(text) {
  return (String(text).match(/\b\d{1,2}\b/g) || [])
    .map(x => parseInt(x, 10))
    .filter(n => n >= 1 && n <= 38);
}

/* =========================
   抓 Pilio 1～9期
========================= */

async function fetchPilioRows() {
  const res = await fetch(PILIO_URL, {
    headers: { "user-agent": "Mozilla/5.0" }
  });

  if (!res.ok) throw new Error("Pilio 抓取失敗：" + res.status);

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
   抓 Biga HTML
========================= */

async function fetchBigaHtml() {
  const res = await fetch(BIGA_URL, {
    headers: { "user-agent": "Mozilla/5.0" }
  });

  if (!res.ok) throw new Error("Biga 抓取失敗：" + res.status);

  return await res.text();
}

/* =========================
   最新黃色6排
========================= */

function fetchLatestBigaYellowRowsFromHtml(html) {
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
        tails: [...new Set(tails)],
        nums
      });
    }

    if (rows.length >= 6) break;
  }

  return rows;
}

/* =========================
   灰色回顧紅位位置統計
   重點：不是記紅色號碼
   是記紅色出現在第幾位
========================= */

function getRedPositionStatsFromBigaHtml(html) {
  const $ = cheerio.load(html);

  const stats = [0, 0, 0, 0, 0, 0];

  $("tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 4) return;

    const hotCell = tds.last();
    const fullText = hotCell.text().replace(/\s+/g, "");
    const nums = parseNumbers(fullText).slice(0, 6);

    if (nums.length !== 6) return;

    hotCell.find("*").each((_, el) => {
      const elText = $(el).text();
      const redNums = parseNumbers(elText);

      const style = String($(el).attr("style") || "").toLowerCase();
      const cls = String($(el).attr("class") || "").toLowerCase();

      const looksRed =
        style.includes("red") ||
        style.includes("#f00") ||
        style.includes("#ff0000") ||
        style.includes("background-color:red") ||
        style.includes("background:red") ||
        cls.includes("red");

      if (!looksRed) return;

      redNums.forEach(red => {
        nums.forEach((n, index) => {
          if (n === red && index >= 0 && index <= 5) {
            stats[index] += 1;
          }
        });
      });
    });
  });

  return stats;
}

/* =========================
   圈位第一刪除
   依照最新黃色6排位置刪
========================= */

function getCircleDelete(rows) {
  const del = new Set();

  const circlePositions = [
    [0, [2, 3]],
    [1, [1, 2]],
    [5, [0, 1, 2]]
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
   黃色4隻分析
   用灰色紅位統計加權
========================= */

function pickYellow4ByRedPositionStats(yellowRows, banned, redStats) {
  const score = {};

  yellowRows.forEach((row, rowIndex) => {
    row.nums.forEach((n, posIndex) => {
      if (banned.has(n)) return;

      if (!score[n]) score[n] = 0;

      score[n] += 10;

      const positionHit = redStats[posIndex] || 0;
      score[n] += positionHit * 6;

      if (row.tails.includes(n % 10)) {
        score[n] += 5;
      }

      if (rowIndex >= 3) {
        score[n] += 2;
      }
    });
  });

  return Object.entries(score)
    .map(([num, s]) => ({
      num: Number(num),
      score: s
    }))
    .sort((a, b) => b.score - a.score || a.num - b.num)
    .slice(0, 4)
    .map(x => x.num)
    .sort((a, b) => a - b);
}

/* =========================
   主分析
========================= */

function analyze(pilioRows, yellowRows, redStats) {
  const allBase = Array.from({ length: 38 }, (_, i) => i + 1);

  const first = pilioRows[0] || [];
  const ninth = pilioRows[8] || [];
  const latest3 = pilioRows.slice(0, 3);

  const firstDelete = new Set(first);
  const ninthDelete = new Set(ninth);

  const plusDelete = new Set(
    latest3
      .flat()
      .map(n => n + 1)
      .filter(n => n >= 1 && n <= 38)
  );

  const circleDelete = getCircleDelete(yellowRows);

  const banned = new Set([
    ...firstDelete,
    ...ninthDelete,
    ...plusDelete,
    ...circleDelete
  ]);

  const yellow4 = pickYellow4ByRedPositionStats(yellowRows, banned, redStats);
  const allRemoved = [...banned].sort((a, b) => a - b);
  const remaining = allBase.filter(n => !banned.has(n));

  return {
    yellow4,
    allRemoved,
    remaining
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
<title>威力彩 黃色4隻分析</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",Arial,sans-serif;
  background:linear-gradient(135deg,#111,#2b0b18,#ff168d);
  color:#fff;
  padding:16px;
}
.card{
  max-width:760px;
  margin:auto;
  padding:20px;
  border-radius:30px;
  background:rgba(255,255,255,.18);
  box-shadow:0 25px 80px rgba(0,0,0,.35);
  backdrop-filter:blur(14px);
}
h1{
  text-align:center;
  font-size:30px;
  line-height:1.25;
  margin:8px 0 16px;
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
  background:rgba(255,255,255,.9);
  color:#8a004c;
}
.title{
  font-size:22px;
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
}
.ball.gray{background:#666}
.ball.yellow{
  background:#ffd400;
  color:#2b1a00;
}
.small{
  text-align:center;
  font-size:14px;
  line-height:1.7;
  margin-bottom:10px;
}
</style>
</head>
<body>

<div class="card">
  <h1>威力彩<br>黃色4隻分析</h1>

  <button onclick="run()">重新自動更新抓牌</button>

  <div class="small">
    Pilio 第1期刪｜第9期刪｜三期+1刪｜圈位第一刪｜灰色紅位統計｜黃色4隻
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
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({})
    });

    const data = await res.json();

    if(data.error){
      throw new Error(data.detail || data.error);
    }

    let html = "";

    html += '<div class="section">';
    html += '<div class="title">黃色4隻</div>';
    html += balls(data.yellow4,"yellow");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">全部刪除</div>';
    html += balls(data.allRemoved,"gray");
    html += '</div>';

    html += '<div class="section">';
    html += '<div class="title">剩下號碼</div>';
    html += balls(data.remaining);
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
    const bigaHtml = await fetchBigaHtml();

    const yellowRows = fetchLatestBigaYellowRowsFromHtml(bigaHtml);
    const redStats = getRedPositionStatsFromBigaHtml(bigaHtml);

    res.json(analyze(pilioRows, yellowRows, redStats));
  } catch (err) {
    res.status(500).json({
      error: "分析失敗",
      detail: String(err)
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const pilioRows = await fetchPilioRows();
    const bigaHtml = await fetchBigaHtml();

    const yellowRows = fetchLatestBigaYellowRowsFromHtml(bigaHtml);
    const redStats = getRedPositionStatsFromBigaHtml(bigaHtml);

    res.json(analyze(pilioRows, yellowRows, redStats));
  } catch (err) {
    res.status(500).json({
      error: "分析失敗",
      detail: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log("Weilichai yellow4 red-position server running on port " + PORT);
});
