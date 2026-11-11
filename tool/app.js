'use strict';
/* 真戦 編成ノート
 * data/*.md（generals.md / tactics.md / traits.md）を読み込み、手持ちを登録して編成依頼プロンプトを作る。
 * データと手持ちは IndexedDB に保存（使えない環境ではメモリのみ）。 */

// ---------------- 保存 ----------------
const store = (() => {
  let dbp = null;
  const mem = {};
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open('shinsen-tool', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  return {
    async get(k) {
      const db = await open();
      if (!db) return mem[k];
      return new Promise((res) => {
        try {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result);
          q.onerror = () => res(mem[k]);
        } catch (e) { res(mem[k]); }
      });
    },
    async set(k, v) {
      mem[k] = v;
      const db = await open();
      if (!db) return;
      return new Promise((res) => {
        try {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k);
          tx.oncomplete = () => res();
          tx.onerror = () => res();
        } catch (e) { res(); }
      });
    },
  };
})();

// ---------------- 状態 ----------------
const S = {
  tab: 'generals',
  files: {},          // ファイル名 → テキスト
  loadedAt: '',
  generals: [], tactics: [], traits: {},
  owned: { generals: {}, tactics: {} }, // generals[slug] = {totsu}, tactics[name] = true
  gq: '', gf: { star: [], faction: [], family: [], troop: [], cost: [], tier: [], ownedOnly: false },
  tq: '', tf: { rank: [], kind: [], ownedOnly: false },
  heigaku: [], hq: '', hf: { system: [], kind: [] }, tacView: 'tactics',
  season: { sel: 0, mode: 'upto' }, maxSeason: 1,
  req: { squads: 1, purpose: '対人戦（同盟戦）', season: 'S5', costMax: '', must: [], exclude: [], extra: '', mode: 'skill', withForms: true, withHeigaku: false },
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let saveTimer = null;
function saveOwned() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('owned', S.owned), 200); }
function saveReq() { store.set('req', S.req); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2000);
}

// ---------------- Markdown 解析 ----------------
// 「## 名前」+「- 項目: 値」形式。同じ項目が複数あれば配列にする。
function parseBlocks(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^## (.+)$/);
    if (h) { cur = { name: h[1].trim(), f: {} }; out.push(cur); continue; }
    if (!cur) continue;
    const m = line.match(/^- ([^:：]+)[:：]\s?(.*)$/);
    if (m) {
      const k = m[1].trim(), v = m[2].trim();
      if (k in cur.f) { if (!Array.isArray(cur.f[k])) cur.f[k] = [cur.f[k]]; cur.f[k].push(v); }
      else cur.f[k] = v;
    }
  }
  return out;
}
const arr = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);

function parseStats(s) {
  const o = {};
  const re = /(武勇|知略|統率|政務|魅力|速度)\s+([\d.]+)\/([\d.]+)\/([\d.]+)/g;
  let m;
  while ((m = re.exec(s || ''))) o[m[1]] = { lv1: +m[2], grow: +m[3], lv50: +m[4] };
  return o;
}

function buildData() {
  const files = S.files;
  // 同名を優先し、なければ末尾一致（events_heigaku.md・generals_index.md は別用途なので除く）
  const find = (n) => {
    const keys = Object.keys(files);
    return keys.find((k) => k.toLowerCase() === n) ||
      keys.find((k) => k.toLowerCase().endsWith(n) && !/(events_heigaku|generals_index)\.md$/i.test(k));
  };
  const gk = find('generals.md'), tk = find('tactics.md'), rk = find('traits.md');
  S.generals = gk ? parseBlocks(files[gk]).map((b) => {
    const f = b.f;
    const traits = String(f['特性'] || '').split(' / ').filter(Boolean).map((t) => {
      const m = t.match(/^(無凸|\d凸)\s+(.+)$/);
      return m ? { lv: m[1], n: m[1] === '無凸' ? 0 : +m[1][0], name: m[2] } : { lv: '', n: 0, name: t };
    });
    return {
      name: b.name, slug: f.slug || b.name, kana: f['読み'] || '',
      star: f['星'] || '', faction: f['勢力'] || '', family: f['家門'] || '', cost: f['コスト'] || '',
      sex: f['性別'] || '', troop: f['兵種'] || '', tier: f['Tier'] || '', trend: f['Tier推移'] || '', debut: f['初出'] || '',
      stats: parseStats(f['属性']), unique: f['固有戦法'] || '', uniqueEffect: f['固有戦法効果'] || '',
      teach: f['伝授戦法'] || '', traits, tags: f['タグ'] || '', op: f['運用評価'] || '', opNote: f['運用メモ'] || '',
      forms: arr(f['推奨編成']), raw: f,
    };
  }) : [];
  // Tierの高い順 → 星 → 読み
  S.generals.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (+b.star || 0) - (+a.star || 0) || a.kana.localeCompare(b.kana, 'ja'));
  S.tactics = tk ? parseBlocks(files[tk]).map((b) => {
    const f = b.f;
    return {
      name: b.name, slug: f.slug || b.name, rank: f['ランク'] || '', kind: f['種別'] || '', from: f['伝授元'] || '',
      source: f['入手'] || '', debut: f['初出'] || '', listTier: f['一覧Tier'] || '', evals: f['シーズン評価'] || '',
      effect: f['効果'] || '', note: f['解説'] || '',
    };
  }) : [];
  S.traits = {};
  if (rk) for (const b of parseBlocks(files[rk])) S.traits[b.name] = { name: b.name, effect: b.f['効果'] || '', cat: b.f['区分'] || '', type: b.f['分類'] || '' };
  const hk = find('heigaku.md');
  S.heigaku = hk ? parseBlocks(files[hk]).map((b) => ({
    name: b.name, system: b.f['系統'] || '', kind: b.f['区分'] || '', boost: b.f['強化'] || '',
    debut: b.f['初出'] || '', effect: b.f['効果'] || '', fit: b.f['向く武将'] || '',
  })) : [];
  // データに出てくる最新シーズン
  const nums = [...S.generals, ...S.tactics, ...S.heigaku].map((x) => seasonNum(x.debut));
  S.maxSeason = Math.max(1, ...nums);
  if (!S.season.sel || S.season.sel > S.maxSeason) S.season.sel = S.maxSeason;
  S.warnings = validate(gk, tk, rk, hk);
  S.nameIndex = Object.fromEntries(S.generals.map((g) => [g.name, g]));
  S.tacticIndex = Object.fromEntries(S.tactics.map((t) => [t.name, t]));
  S.formations = collectFormations();
}

// 書式チェック（FORMAT.md の必須項目と書き方）。警告があっても読み込みは続ける。
// ---- シーズン ----
// 初出が空なら S1 扱い。S.season = { sel: 5, mode: 'upto' | 'only' | 'all' }
function seasonNum(s) { const m = String(s || '').match(/S(\d+)/); return m ? +m[1] : 1; }
function seasonOk(debut, sel = S.season.sel, mode = S.season.mode) {
  if (mode === 'all') return true;
  const n = seasonNum(debut);
  return mode === 'only' ? n === sel : n <= sel;
}
function seasonLabel() {
  const s = S.season;
  return s.mode === 'all' ? '全シーズン' : s.mode === 'only' ? `S${s.sel}追加分` : `S${s.sel}まで`;
}
function openSeasonSheet() {
  const s = S.season;
  const list = Array.from({ length: S.maxSeason }, (_, i) => i + 1);
  openSheet(`<h2>シーズンで絞り込み</h2>
    <p class="note" style="font-size:12.5px;color:var(--text2)">武将・戦法・兵学の「初出」で絞り込みます。ここでの選択は全部のタブに反映されます。</p>
    <div class="filter-group"><div class="label">シーズン</div>
      <div class="seg" id="ssSel">${list.map((n) => `<button data-n="${n}" class="${s.sel === n ? 'on' : ''}">S${n}</button>`).join('')}</div></div>
    <div class="filter-group"><div class="label">範囲</div>
      <div class="chips" id="ssMode">
        ${[['upto', 'そのシーズンまで（使えるもの）'], ['only', 'そのシーズンの追加分だけ'], ['all', '絞り込まない']].map(([k, l]) => `<button class="chip ${s.mode === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}
      </div></div>
    <button class="btn primary" onclick="closeSheet()">決定</button>`);
  $('#ssSel').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    s.sel = +b.dataset.n; if (s.mode === 'all') s.mode = 'upto';
    openSeasonSheet(); S.onSheetClose = onSeasonChange;
  });
  $('#ssMode').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    s.mode = b.dataset.m; openSeasonSheet(); S.onSheetClose = onSeasonChange;
  });
  S.onSheetClose = onSeasonChange;
}
function onSeasonChange() {
  store.set('season', S.season);
  if (S.season.mode !== 'all') { S.req.season = `S${S.season.sel}`; saveReq(); }
  render();
}
function seasonChip() { return `<button class="chipbtn ${S.season.mode !== 'all' ? 'active' : ''}" data-season="1">${seasonLabel()}</button>`; }

function validate(gk, tk, rk, hk) {
  const W = [];
  if (!gk) W.push('generals.md がありません（必須）');
  if (!tk) W.push('tactics.md がありません（戦法タブと戦法の所持判定が使えません）');
  if (!rk) W.push('traits.md がありません（特性の効果文が表示されません）');
  const dup = (list, file) => {
    const seen = new Set();
    for (const x of list) { if (seen.has(x.name)) W.push(`${file}: 「${x.name}」が重複しています`); seen.add(x.name); }
  };
  dup(S.generals, 'generals.md'); dup(S.tactics, 'tactics.md');
  const slugs = new Set();
  for (const g of S.generals) {
    const p = `武将「${g.name}」`;
    for (const [k, v] of [['星', g.star], ['勢力', g.faction], ['コスト', g.cost], ['兵種', g.troop], ['固有戦法', g.unique]]) {
      if (!v) W.push(`${p}: 必須項目「${k}」がありません`);
    }
    if (g.star && !/^[1-5]$/.test(g.star)) W.push(`${p}: 星は 1〜5 の数字で書きます（今: ${g.star}）`);
    if (g.cost && !/^\d+$/.test(g.cost)) W.push(`${p}: コストは数字で書きます（今: ${g.cost}）`);
    if (g.troop && g.troop !== 'なし' && !troopTypes(g).length) W.push(`${p}: 兵種に足軽・騎兵・弓兵・鉄砲・兵器が見つかりません（今: ${g.troop}）`);
    if (g.tier && !/^Tier[\d.]+$/.test(g.tier)) W.push(`${p}: Tier は「Tier0」「Tier1.5」の形で書きます（今: ${g.tier}）`);
    if (g.raw['属性'] && Object.keys(g.stats).length === 0) W.push(`${p}: 属性の書き方が違います（例: 武勇 89/2.08/190.9）`);
    for (const t of g.traits) {
      if (!t.lv) W.push(`${p}: 特性「${t.name}」に凸数がありません（例: 無凸 名前 / 1凸 名前）`);
      else if (rk && !S.traits[t.name]) W.push(`${p}: 特性「${t.name}」が traits.md にありません`);
    }
    for (const f of g.forms) {
      if (f.includes('スタダ')) continue;
      if (!/^\[[^\]]*\]\s*\S.*\s\+\s/.test(f)) W.push(`${p}: 推奨編成の書き方が違います（[ラベル] 武将A(戦法 ＋ 戦法) + 武将B(...) + ...）`);
    }
    if (slugs.has(g.slug)) W.push(`${p}: slug「${g.slug}」が他の武将と重複しています`);
    slugs.add(g.slug);
  }
  for (const t of S.tactics) {
    const p = `戦法「${t.name}」`;
    if (!t.rank) W.push(`${p}: 必須項目「ランク」がありません`);
    else if (!/^[SA]$/.test(t.rank)) W.push(`${p}: ランクは S か A で書きます（今: ${t.rank}）`);
    if (!t.kind) W.push(`${p}: 必須項目「種別」がありません`);
    if (!t.effect) W.push(`${p}: 必須項目「効果」がありません`);
  }
  for (const t of Object.values(S.traits)) if (!t.effect) W.push(`特性「${t.name}」: 必須項目「効果」がありません`);
  for (const h of S.heigaku) {
    const p = `兵学「${h.name}」`;
    for (const [k, v] of [['系統', h.system], ['区分', h.kind], ['効果', h.effect]]) if (!v) W.push(`${p}: 必須項目「${k}」がありません`);
  }
  for (const x of [...S.generals.map((g) => ['武将', g]), ...S.tactics.map((t) => ['戦法', t]), ...S.heigaku.map((h) => ['兵学', h])]) {
    if (x[1].debut && !/^S\d+$/.test(x[1].debut)) W.push(`${x[0]}「${x[1].name}」: 初出は「S1」「S2」の形で書きます（今: ${x[1].debut}）`);
  }
  return W;
}

// 各武将の「推奨編成」行を集め、重複を除いた編成リストにする。
// 行の形: [S5 推奨編成 Tier0] 武将A(戦法1 ＋ 戦法2) + 武将B(...) + 武将C(...)
// スタダ編成（段階ごとの説明文）は形式が違うので除外。
function collectFormations() {
  const seen = new Map();
  for (const g of S.generals) {
    for (const line of g.forms) {
      if (line.includes('スタダ')) continue;
      const m = line.match(/^\[([^\]]*)\]\s*(.+)$/);
      if (!m) continue;
      const label = m[1];
      const members = m[2].split(' + ').map((s) => {
        const mm = s.trim().match(/^(.+?)\((.*)\)$/);
        const name = (mm ? mm[1] : s).trim();
        const tactics = mm ? mm[2].split(/\s*＋\s*/).map((x) => x.trim()).filter(Boolean) : [];
        return { name, alts: name.split('/').map((x) => x.trim()), tactics };
      });
      if (members.length < 2) continue;
      const key = members.map((x) => x.name + ':' + x.tactics.join('+')).sort().join('|');
      const season = (label.match(/^S(\d)/) || [])[1] || '0';
      const tier = (label.match(/Tier([\d.]+)/) || [])[1];
      if (!seen.has(key)) seen.set(key, { label, season: +season, tier: tier != null ? +tier : 9, members });
    }
  }
  return [...seen.values()].sort((a, b) => b.season - a.season || a.tier - b.tier);
}

// 手持ちと照らし合わせる
// 編成の武将・伝授戦法がすべてシーズン n で使えるか
// （初出が n 以前か、所持している。限定配布などで先のシーズンの武将を持っている場合があるため）
function availGeneral(g, n) { return !g || isOwnedG(g) || seasonOk(g.debut, n, 'upto'); }
function availTactic(t, n) { return !t || isOwnedT(t) || seasonOk(t.debut, n, 'upto'); }
function formationInSeason(f, n) {
  return f.members.every((m) =>
    m.alts.some((a) => availGeneral(S.nameIndex[a], n)) &&
    m.tactics.every((t) => availTactic(S.tacticIndex[t], n)));
}
function formationText(f) {
  return `[${f.label}] ` + f.members.map((m) => (m.tactics.length ? `${m.name}(${m.tactics.join(' ＋ ')})` : m.name)).join(' + ');
}
function formationsOf(g, n) {
  return (S.formations || []).filter((f) => f.members.some((m) => m.alts.includes(g.name)) && (n == null || formationInSeason(f, n)));
}

function evalFormation(f) {
  const byName = S.nameIndex;
  const res = { missingG: [], missingT: [], members: [] };
  for (const m of f.members) {
    const g = m.alts.map((n) => byName[n]).find((x) => x && isOwnedG(x));
    const owned = !!g;
    if (!owned) res.missingG.push(m.name);
    const tac = m.tactics.map((t) => {
      const known = S.tacticIndex[t];
      // 伝授戦法の一覧にない名前（その武将の固有戦法など）は判定しない
      const ok = !known || isOwnedT(known);
      if (!ok) res.missingT.push(t);
      return { name: t, ok };
    });
    res.members.push({ ...m, owned, slug: (g || m.alts.map((n) => byName[n]).find(Boolean) || {}).slug, tac });
  }
  return res;
}

function tierRank(t) { const m = String(t).match(/([\d.]+)/); return m ? parseFloat(m[1]) : 99; }
function troopTypes(g) { return [...String(g.troop).matchAll(/(足軽|騎兵|弓兵|鉄砲|兵器)/g)].map((m) => m[1]); }
const isOwnedG = (g) => !!S.owned.generals[g.slug];
const isOwnedT = (t) => !!S.owned.tactics[t.name];

// ---------------- 画面 ----------------
const TITLES = { home: '真戦 編成ノート', generals: '武将', tactics: '戦法', request: '編成依頼', settings: '設定' };
function setTab(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#title').textContent = TITLES[tab];
  render();
  window.scrollTo(0, 0);
}

function updateStatus() {
  const og = Object.keys(S.owned.generals).length, ot = Object.keys(S.owned.tactics).length;
  $('#dataStatus').textContent = S.generals.length ? `所持 武将${og}・戦法${ot}` : 'データ未読み込み';
}

function render() {
  updateStatus();
  const v = $('#view');
  if (S.tab !== 'settings' && !S.generals.length) { v.innerHTML = noDataHtml(); return; }
  if (S.tab === 'home') renderHome(v);
  else if (S.tab === 'generals') renderGenerals(v);
  else if (S.tab === 'tactics') renderTactics(v);
  else if (S.tab === 'request') renderRequest(v);
  else renderSettings(v);
}

function noDataHtml() {
  return `<div class="empty"><div class="big">📜</div>
    <p>まだデータがありません。</p>
    <p style="font-size:13px">設定タブで data フォルダの md ファイル<br>（generals.md / tactics.md / traits.md）を読み込んでください。</p>
    <button class="btn primary" style="max-width:280px;margin:16px auto 0" onclick="setTab('settings')">設定を開く</button>
    <button class="btn" style="max-width:280px;margin:8px auto 0" onclick="loadSample()">サンプルで試す</button></div>`;
}

// ----- ホーム -----
const HOME_LIMIT = 5;
function renderHome(v) {
  const ownedG = S.generals.filter(isOwnedG);
  const ownedT = S.tactics.filter(isOwnedT);
  const star5 = ownedG.filter((g) => g.star === '5').length;
  const total5 = S.generals.filter((g) => g.star === '5').length;

  // 勢力ごとの所持数
  const factions = [...new Set(S.generals.map((g) => g.faction).filter(Boolean))];
  const bars = factions.map((f) => {
    const all = S.generals.filter((g) => g.faction === f).length;
    const own = ownedG.filter((g) => g.faction === f).length;
    return `<div class="bar-row"><span>${esc(f)}</span><span class="bar"><i style="width:${all ? (own / all) * 100 : 0}%"></i></span><span class="n">${own}/${all}</span></div>`;
  }).join('');

  // 推奨編成の判定
  // 選んだシーズンまでに登場している武将だけで組める編成に限る
  const inSeason = (f) => S.season.mode === 'all' || formationInSeason(f, S.season.sel);
  const evals = (S.formations || []).filter(inSeason).map((f) => ({ f, e: evalFormation(f) }));
  const ready = evals.filter((x) => x.e.missingG.length === 0);
  const near = evals.filter((x) => x.e.missingG.length === 1);
  const readyFull = ready.filter((x) => x.e.missingT.length === 0).length;

  // 育成メモ
  const totsuFirst = ownedG.filter((g) => /凸 ◎/.test(g.op));
  const fodder = ownedG.filter((g) => /素材 ◎/.test(g.op));
  const miniChips = (list) => list.length
    ? `<div class="mini-list">${list.map((g) => `<button class="chip" data-slug="${esc(g.slug)}">${esc(g.name)}${S.owned.generals[g.slug] ? '（' + (S.owned.generals[g.slug].totsu || 0) + '凸）' : ''}</button>`).join('')}</div>`
    : '<p class="note">該当なし</p>';

  const listHtml = (items, id, kind) => {
    if (!items.length) {
      return `<p class="note">${kind === 'ready' ? '手持ちだけで組める推奨編成はまだありません。' : '該当する編成はありません。'}</p>`;
    }
    const open = S.homeOpen && S.homeOpen[id];
    const shown = open ? items : items.slice(0, HOME_LIMIT);
    return shown.map((x, i) => formationCard(x, `${id}-${i}`)).join('') +
      (items.length > HOME_LIMIT ? `<button class="btn more" data-more="${id}">${open ? '閉じる' : `すべて表示（${items.length}件）`}</button>` : '');
  };
  S.homeItems = { ready, near };

  v.innerHTML = `
    <div class="section">
      <h2>手持ち</h2>
      <div class="kpis">
        <div class="kpi"><div class="v">${ownedG.length}<small>/${S.generals.length}</small></div><div class="l">武将</div></div>
        <div class="kpi"><div class="v">${star5}<small>/${total5}</small></div><div class="l">うち★5</div></div>
        <div class="kpi"><div class="v">${ownedT.length}<small>/${S.tactics.length}</small></div><div class="l">伝授戦法</div></div>
      </div>
      <div class="bars">${bars}</div>
    </div>

    <div class="section">
      <h2>ショートカット</h2>
      <div class="quick">
        <button class="btn primary" id="hCopy">前回の条件で<br>依頼をコピー</button>
        <button class="btn" id="hReg">所持を登録する</button>
      </div>
      <p class="note">前回の条件：${esc(S.req.purpose)}・${S.req.squads}部隊・${esc(S.req.season)}・${S.req.mode === 'skill' ? 'SKILLあり' : 'SKILLなし'}</p>
    </div>

    <div class="section">
      <h2>すぐ組める推奨編成 <span style="font-size:12px;color:var(--text3);font-weight:400">${ready.length}件（戦法もそろう: ${readyFull}件）</span></h2>
      <div class="subbar" style="padding:0"><span>武将3人とも手持ちにいる編成です。足りない伝授戦法は赤で表示します。</span>${seasonChip()}</div>
      ${listHtml(ready, 'ready', 'ready')}
    </div>

    <div class="section">
      <h2>あと1人で組める編成 <span style="font-size:12px;color:var(--text3);font-weight:400">${near.length}件</span></h2>
      <p class="note">足りない武将を赤で表示します。名前をタップすると詳細が開きます。</p>
      ${listHtml(near, 'near', 'near')}
    </div>

    <div class="section">
      <h2>育成メモ（運用評価）</h2>
      <p class="note"><b>凸◎（ランクアップ優先）</b></p>
      ${miniChips(totsuFirst)}
      <p class="note" style="margin-top:12px"><b>素材◎（素材にしてよい）</b></p>
      ${miniChips(fodder)}
    </div>

    <div class="section">
      <p class="note">データ読み込み: ${esc(S.loadedAt || '不明')}（武将${S.generals.length}・戦法${S.tactics.length}・推奨編成${(S.formations || []).length}件）</p>
      <button class="btn" id="hData">データを更新する</button>
    </div>`;

  $('#hCopy').onclick = async () => {
    const text = buildPrompt();
    try { await navigator.clipboard.writeText(text); toast(`コピーしました（${text.length.toLocaleString()}文字）`); }
    catch (e) { toast('コピーできませんでした。依頼タブから作成してください'); }
  };
  $('#hReg').onclick = () => setTab('generals');
  $('#hData').onclick = () => setTab('settings');
  v.querySelectorAll('[data-more]').forEach((b) => {
    b.onclick = () => { S.homeOpen = S.homeOpen || {}; S.homeOpen[b.dataset.more] = !S.homeOpen[b.dataset.more]; renderHome(v); };
  });
  v.querySelectorAll('[data-fixf]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const [id, i] = b.dataset.fixf.split('-');
      const x = S.homeItems[id][+i];
      const names = x.e.members.map((m) => m.alts.find((n) => S.nameIndex[n] && isOwnedG(S.nameIndex[n])) || m.name);
      S.req.kind = 'fixed';
      S.req.fixed = [names];
      saveReq();
      setTab('request');
      toast('第1部隊に入れました');
    };
  });
  v.querySelectorAll('[data-usef]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const [id, i] = b.dataset.usef.split('-');
      const x = S.homeItems[id][+i];
      S.req.kind = 'build';
      S.req.must = x.e.members.filter((m) => m.owned).map((m) => (m.alts.find((n) => S.nameIndex[n] && isOwnedG(S.nameIndex[n])) || m.name));
      S.req.squads = 1;
      const tacs = x.e.members.map((m) => `${m.name}(${m.tactics.join('＋')})`).join(' + ');
      S.req.extra = `推奨編成「${tacs}」をベースに検討してください。`;
      saveReq();
      setTab('request');
      toast('条件に入れました');
    };
  });
}

function formationCard(x, id) {
  const { f, e } = x;
  const mem = e.members.map((m) => {
    const nameHtml = m.slug ? `<button class="linkbtn" data-slug="${esc(m.slug)}" style="${m.owned ? 'color:inherit;text-decoration:none' : ''}">${esc(m.name)}</button>` : esc(m.name);
    const tac = m.tac.map((t) => (t.ok ? esc(t.name) : `<span class="miss">${esc(t.name)}</span>`)).join(' ＋ ');
    return `<div class="fmem ${m.owned ? '' : 'missing'}"><b>${nameHtml}</b>${tac ? ` <span class="tac">（${tac}）</span>` : ''}</div>`;
  }).join('');
  const notes = [];
  if (e.missingG.length) notes.push(`足りない武将: <span class="miss">${esc(e.missingG.join('、'))}</span>`);
  if (e.missingT.length) notes.push(`足りない戦法: <span class="miss">${esc([...new Set(e.missingT)].join('、'))}</span>`);
  return `<div class="fcard">
    <div class="fcard-head"><span class="tag">${esc(f.label)}</span></div>
    ${mem}
    ${notes.length ? `<div class="fmem" style="font-size:12.5px;margin-top:4px">${notes.join('<br>')}</div>` : ''}
    ${e.missingG.length
      ? `<button class="btn" data-usef="${id}">この編成をもとに依頼を作る</button>`
      : `<div class="btn-row"><button class="btn" data-usef="${id}">これをもとに編成</button><button class="btn" data-fixf="${id}">この3人で戦法を考える</button></div>`}
  </div>`;
}

// ----- 武将 -----
function filteredGenerals() {
  const q = S.gq.trim(), f = S.gf;
  return S.generals.filter((g) => {
    if (f.ownedOnly && !isOwnedG(g)) return false;
    if (!isOwnedG(g) && !seasonOk(g.debut)) return false; // 所持していればシーズンに関係なく表示
    if (f.star.length && !f.star.includes(g.star)) return false;
    if (f.faction.length && !f.faction.includes(g.faction)) return false;
    if (f.family && f.family.length && !f.family.includes(g.family)) return false;
    if (f.cost.length && !f.cost.includes(g.cost)) return false;
    if (f.tier.length && !f.tier.includes(g.tier)) return false;
    if (f.troop.length && !troopTypes(g).some((t) => f.troop.includes(t))) return false;
    if (q) {
      const hay = g.name + g.kana + g.unique + g.teach + g.tags + g.family;
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}
function gFilterCount() { const f = S.gf; return f.star.length + f.faction.length + (f.family || []).length + f.troop.length + f.cost.length + f.tier.length + (f.ownedOnly ? 1 : 0); }

function renderGenerals(v) {
  const n = gFilterCount();
  v.innerHTML = `
    <div class="toolbar">
      <input class="search" id="gq" type="search" placeholder="名前・戦法・タグで検索" value="${esc(S.gq)}">
      <button class="chipbtn ${n ? 'active' : ''}" id="gfBtn">絞り込み${n ? ' ' + n : ''}</button>
    </div>
    <div class="subbar"><span id="gsum"></span>${seasonChip()}</div>
    <div class="list" id="glist"></div>`;
  $('#gq').addEventListener('input', (e) => { S.gq = e.target.value; drawGeneralList(); });
  $('#gfBtn').addEventListener('click', openGeneralFilter);
  drawGeneralList();
}

function generalCard(g) {
  const o = S.owned.generals[g.slug];
  return `<div class="card ${o ? 'owned' : ''}" data-slug="${esc(g.slug)}">
    <div class="card-main">
      <div class="card-title">${esc(g.name)} <span class="tag star">${'★'.repeat(+g.star || 0)}</span>
        ${g.tier ? `<span class="tag tier">${esc(g.tier.replace('Tier', 'T'))}</span>` : ''}
        ${o ? `<span class="tag totsu">${o.totsu ? o.totsu + '凸' : '無凸'}</span>` : ''}</div>
      <div class="card-sub">${esc(g.faction)}・COST${esc(g.cost)}・${esc(g.troop)}</div>
      <div class="card-sub2">${esc(g.unique)}${g.teach ? ' ／ 伝授: ' + esc(g.teach) : ''}</div>
    </div>
    <button class="own-btn ${o ? 'on' : ''}" data-own="${esc(g.slug)}">${o ? '所持' : '未所持'}</button>
  </div>`;
}

function drawGeneralList() {
  const list = filteredGenerals();
  $('#gsum').textContent = `${list.length} / ${S.generals.length} 名`;
  const el = $('#glist');
  el.innerHTML = list.length ? list.map(generalCard).join('') : '<div class="empty">該当する武将がいません</div>';
}

function toggleOwnGeneral(slug) {
  if (S.owned.generals[slug]) delete S.owned.generals[slug];
  else S.owned.generals[slug] = { totsu: 0 };
  saveOwned();
}

function openGeneralDetail(slug) {
  const g = S.generals.find((x) => x.slug === slug);
  if (!g) return;
  const o = S.owned.generals[slug];
  const st = g.stats;
  const statsHtml = ['武勇', '知略', '統率', '速度', '政務', '魅力'].map((k) => st[k] ? `<div>${k}<b>${st[k].lv50}</b></div>` : '').join('');
  const traitsHtml = g.traits.map((t) => {
    const info = S.traits[t.name];
    const locked = !o || (o.totsu || 0) < t.n;
    return `<div class="trait ${locked ? 'locked' : ''}"><span class="lv">${esc(t.lv)}</span><b>${esc(t.name)}</b>
      ${info ? `<div>${esc(info.effect)}</div>` : ''}</div>`;
  }).join('');
  openSheet(`
    <h2>${esc(g.name)} <span class="tag star">${'★'.repeat(+g.star || 0)}</span></h2>
    <div style="font-size:13px;color:var(--text3)">${esc(g.kana)}</div>
    <h3>所持・凸</h3>
    <div class="seg" id="totsuSeg">
      <button data-t="-1" class="${!o ? 'on' : ''}">未所持</button>
      ${[0, 1, 2, 3, 4, 5].map((n) => `<button data-t="${n}" class="${o && (o.totsu || 0) === n ? 'on' : ''}">${n ? n : '無'}</button>`).join('')}
    </div>
    <h3>基本</h3>
    <dl class="kv">
      <dt>勢力</dt><dd>${esc(g.faction)}${g.family ? '（' + esc(g.family) + '）' : ''}</dd>
      <dt>COST</dt><dd>${esc(g.cost)}</dd>
      <dt>兵種</dt><dd>${esc(g.troop)}</dd>
      <dt>Tier</dt><dd>${esc(g.tier)}${g.trend ? '<br><span style="font-size:12px;color:var(--text3)">' + esc(g.trend) + '</span>' : ''}</dd>
      <dt>初出</dt><dd>${esc(g.debut)}</dd>
      ${g.tags ? `<dt>タグ</dt><dd>${esc(g.tags)}</dd>` : ''}
    </dl>
    <h3>属性（Lv50）</h3><div class="stats">${statsHtml}</div>
    <h3>固有戦法：${esc(g.unique)}</h3><p class="effect">${esc(g.uniqueEffect)}</p>
    ${g.teach ? `<h3>伝授戦法</h3><p>${esc(g.teach)}</p>` : ''}
    <h3>特性（凸別）</h3>${traitsHtml}
    ${g.op ? `<h3>運用評価</h3><p style="font-size:13px">${esc(g.op)}</p><p style="font-size:12.5px;color:var(--text2)">${esc(g.opNote)}</p>` : ''}
    ${(() => {
      if (!g.forms.length) return '';
      if (S.season.mode === 'all') return `<h3>推奨編成</h3>${g.forms.map((f) => `<div class="form-line">${esc(f)}</div>`).join('')}`;
      const all = formationsOf(g), ok = formationsOf(g, S.season.sel);
      const hidden = all.length - ok.length;
      return `<h3>推奨編成</h3>
        ${ok.map((f) => `<div class="form-line">${esc(formationText(f))}</div>`).join('') || `<p class="note">S${S.season.sel}までの武将・戦法で組める推奨編成はありません。</p>`}
        ${hidden ? `<p class="note" style="font-size:12px;color:var(--text3)">S${S.season.sel}より後に登場した武将・戦法を含む ${hidden} 件は非表示（シーズン絞り込みを「絞り込まない」にすると全件表示）</p>` : ''}`;
    })()}
    <div style="height:8px"></div>
    <button class="btn" onclick="closeSheet()">閉じる</button>`);
  $('#totsuSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = +b.dataset.t;
    if (t < 0) delete S.owned.generals[slug]; else S.owned.generals[slug] = { totsu: t };
    saveOwned();
    openGeneralDetail(slug);
    refreshList();
  });
}

function openGeneralFilter() {
  const uniq = (fn) => [...new Set(S.generals.map(fn).filter(Boolean))];
  const stars = uniq((g) => g.star).sort().reverse();
  const factions = uniq((g) => g.faction);
  const costs = uniq((g) => g.cost).sort((a, b) => b - a);
  const tiers = uniq((g) => g.tier).sort((a, b) => tierRank(a) - tierRank(b));
  const troops = ['足軽', '騎兵', '弓兵', '鉄砲', '兵器'];
  const group = (label, key, vals, fmt = (x) => x) => `<div class="filter-group"><div class="label">${label}</div><div class="chips">
    ${vals.map((x) => `<button class="chip ${S.gf[key].includes(x) ? 'on' : ''}" data-k="${key}" data-v="${esc(x)}">${esc(fmt(x))}</button>`).join('')}</div></div>`;
  // 家門は人数の多い順
  const famCount = {}; S.generals.forEach((g) => { if (g.family) famCount[g.family] = (famCount[g.family] || 0) + 1; });
  const families = Object.keys(famCount).sort((a, b) => famCount[b] - famCount[a]);
  const seasons = Array.from({ length: S.maxSeason }, (_, i) => i + 1);
  openSheet(`<h2>絞り込み</h2>
    <label class="check"><input type="checkbox" id="fOwned" ${S.gf.ownedOnly ? 'checked' : ''}> 所持している武将だけ</label>
    <div class="filter-group"><div class="label">シーズン（そのシーズンまでに登場した武将）</div><div class="chips" id="fSeason">
      ${seasons.map((n) => `<button class="chip ${S.season.mode !== 'all' && S.season.sel === n ? 'on' : ''}" data-sn="${n}">S${n}まで</button>`).join('')}
      <button class="chip ${S.season.mode === 'all' ? 'on' : ''}" data-sn="all">すべて</button></div></div>
    ${group('星', 'star', stars, (x) => '★' + x)}
    ${group('勢力', 'faction', factions)}
    ${group('家門', 'family', families)}
    ${group('兵種ボーナス', 'troop', troops)}
    ${group('COST', 'cost', costs)}
    ${group('Tier', 'tier', tiers)}
    <div class="btn-row"><button class="btn" id="fClear">クリア</button><button class="btn primary" onclick="closeSheet()">決定</button></div>`);
  const body = $('#sheetBody');
  body.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (c.dataset.sn) {
      if (c.dataset.sn === 'all') S.season.mode = 'all'; else { S.season.sel = +c.dataset.sn; S.season.mode = 'upto'; }
      body.querySelectorAll('[data-sn]').forEach((x) => x.classList.toggle('on', x === c));
      S.seasonChanged = true;
      return;
    }
    const a = S.gf[c.dataset.k], val = c.dataset.v;
    const i = a.indexOf(val); if (i >= 0) a.splice(i, 1); else a.push(val);
    c.classList.toggle('on');
  });
  $('#fOwned').addEventListener('change', (e) => { S.gf.ownedOnly = e.target.checked; });
  $('#fClear').addEventListener('click', () => { S.gf = { star: [], faction: [], family: [], troop: [], cost: [], tier: [], ownedOnly: false }; closeSheet(); });
  S.onSheetClose = () => { if (S.seasonChanged) { S.seasonChanged = false; onSeasonChange(); } else render(); };
}

// ----- 戦法 -----
function filteredTactics() {
  const q = S.tq.trim(), f = S.tf;
  return S.tactics.filter((t) => {
    if (f.ownedOnly && !isOwnedT(t)) return false;
    if (!isOwnedT(t) && !seasonOk(t.debut)) return false;
    if (f.rank.length && !f.rank.includes(t.rank)) return false;
    if (f.kind.length && !f.kind.some((k) => (k === '事件' ? t.source.includes('事件') : t.kind.includes(k)))) return false;
    if (q) {
      const hay = t.name + t.kind + t.from + t.effect;
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}
function tacViewSeg() {
  if (!S.heigaku.length) return '';
  return `<div style="padding:10px 16px 0"><div class="seg" id="tView">
    <button data-v="tactics" class="${S.tacView !== 'heigaku' ? 'on' : ''}">伝授戦法</button>
    <button data-v="heigaku" class="${S.tacView === 'heigaku' ? 'on' : ''}">兵学</button></div></div>`;
}
function bindTacView() {
  const seg = $('#tView'); if (!seg) return;
  seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.tacView = b.dataset.v; render(); };
}
function renderTactics(v) {
  if (S.tacView === 'heigaku' && S.heigaku.length) { renderHeigaku(v); return; }
  const kinds = ['能動', '受動', '指揮', '突撃', '兵種', '陣形', '事件'];
  const f = S.tf;
  v.innerHTML = `${tacViewSeg()}
    <div class="toolbar">
      <input class="search" id="tq" type="search" placeholder="戦法名・効果・伝授元で検索" value="${esc(S.tq)}">
      <button class="chipbtn ${f.ownedOnly ? 'active' : ''}" id="tOwn">所持のみ</button>
    </div>
    <div class="chips" style="padding:0 16px 8px" id="tchips">
      ${['S', 'A'].map((r) => `<button class="chip ${f.rank.includes(r) ? 'on' : ''}" data-k="rank" data-v="${r}">${r}</button>`).join('')}
      ${kinds.map((k) => `<button class="chip ${f.kind.includes(k) ? 'on' : ''}" data-k="kind" data-v="${k}">${k}</button>`).join('')}
    </div>
    <div class="subbar"><span id="tsum"></span>${seasonChip()}</div>
    <div class="list" id="tlist"></div>`;
  bindTacView();
  $('#tq').addEventListener('input', (e) => { S.tq = e.target.value; drawTacticList(); });
  $('#tOwn').addEventListener('click', (e) => { f.ownedOnly = !f.ownedOnly; e.currentTarget.classList.toggle('active'); drawTacticList(); });
  $('#tchips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const a = f[c.dataset.k], val = c.dataset.v;
    const i = a.indexOf(val); if (i >= 0) a.splice(i, 1); else a.push(val);
    c.classList.toggle('on'); drawTacticList();
  });
  drawTacticList();
}
function tacticCard(t) {
  const o = isOwnedT(t);
  return `<div class="card ${o ? 'owned' : ''}" data-tac="${esc(t.name)}">
    <div class="card-main">
      <div class="card-title">${esc(t.name)} <span class="tag">${esc(t.rank)}</span> <span class="tag">${esc(t.kind)}</span>
        ${t.listTier ? `<span class="tag tier">${esc(t.listTier.replace('Tier', 'T'))}</span>` : ''}</div>
      <div class="card-sub2">${esc(t.effect)}</div>
      <div class="card-sub2">伝授元: ${esc(t.from)}</div>
    </div>
    <button class="own-btn ${o ? 'on' : ''}" data-owntac="${esc(t.name)}">${o ? '所持' : '未所持'}</button>
  </div>`;
}
function drawTacticList() {
  const list = filteredTactics();
  $('#tsum').textContent = `${list.length} / ${S.tactics.length} 件`;
  $('#tlist').innerHTML = list.length ? list.map(tacticCard).join('') : '<div class="empty">該当する戦法がありません</div>';
}
// ----- 兵学 -----
function filteredHeigaku() {
  const q = S.hq.trim(), f = S.hf;
  return S.heigaku.filter((h) => {
    if (!seasonOk(h.debut)) return false;
    if (f.system.length && !f.system.includes(h.system)) return false;
    if (f.kind.length && !f.kind.includes(h.kind)) return false;
    if (q) {
      const hay = h.name + h.system + h.effect + h.fit;
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}
function renderHeigaku(v) {
  const f = S.hf;
  const systems = [...new Set(S.heigaku.map((h) => h.system).filter(Boolean))];
  const kinds = [...new Set(S.heigaku.map((h) => h.kind).filter(Boolean))];
  v.innerHTML = `${tacViewSeg()}
    <div class="toolbar">
      <input class="search" id="hq" type="search" placeholder="兵学名・効果・向く武将で検索" value="${esc(S.hq)}">
    </div>
    <div class="chips" style="padding:0 16px 8px" id="hchips">
      ${systems.map((s) => `<button class="chip ${f.system.includes(s) ? 'on' : ''}" data-k="system" data-v="${esc(s)}">${esc(s)}</button>`).join('')}
      ${kinds.map((k) => `<button class="chip ${f.kind.includes(k) ? 'on' : ''}" data-k="kind" data-v="${esc(k)}">兵学・${esc(k)}</button>`).join('')}
    </div>
    <div class="subbar"><span id="hsum"></span>${seasonChip()}</div>
    <div class="list" id="hlist"></div>`;
  bindTacView();
  $('#hq').addEventListener('input', (e) => { S.hq = e.target.value; drawHeigakuList(); });
  $('#hchips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const a = f[c.dataset.k], val = c.dataset.v;
    const i = a.indexOf(val); if (i >= 0) a.splice(i, 1); else a.push(val);
    c.classList.toggle('on'); drawHeigakuList();
  });
  drawHeigakuList();
}
function drawHeigakuList() {
  const list = filteredHeigaku();
  $('#hsum').textContent = `${list.length} / ${S.heigaku.length} 件`;
  $('#hlist').innerHTML = list.length ? list.map((h) => `<div class="card" style="cursor:default">
    <div class="card-main">
      <div class="card-title">${esc(h.name)} <span class="tag">${esc(h.system)}</span> <span class="tag">兵学・${esc(h.kind)}</span></div>
      <div class="card-sub">${esc(h.effect)}</div>
      ${h.fit ? `<div class="card-sub" style="color:var(--text3)">向く武将: ${esc(h.fit)}</div>` : ''}
    </div></div>`).join('') : `<div class="empty">${S.season.mode !== 'all' && S.season.sel < 2 ? '兵学はS2で実装されました' : '該当する兵学がありません'}</div>`;
}

function openTacticDetail(name) {
  const t = S.tactics.find((x) => x.name === name); if (!t) return;
  const o = isOwnedT(t);
  openSheet(`<h2>${esc(t.name)}</h2>
    <dl class="kv">
      <dt>ランク</dt><dd>${esc(t.rank)}</dd><dt>種別</dt><dd>${esc(t.kind)}</dd>
      <dt>入手</dt><dd>${esc(t.source)}</dd><dt>伝授元</dt><dd>${esc(t.from)}</dd>
      <dt>初出</dt><dd>${esc(t.debut)}</dd><dt>一覧Tier</dt><dd>${esc(t.listTier)}</dd>
      ${t.evals ? `<dt>評価</dt><dd>${esc(t.evals)}</dd>` : ''}
    </dl>
    <h3>効果</h3><p class="effect">${esc(t.effect)}</p>
    ${t.note ? `<h3>解説</h3><p class="effect" style="font-size:13px;color:var(--text2)">${esc(t.note)}</p>` : ''}
    <div style="height:8px"></div>
    <div class="btn-row"><button class="btn ${o ? '' : 'primary'}" id="tToggle">${o ? '未所持にする' : '所持にする'}</button><button class="btn" onclick="closeSheet()">閉じる</button></div>`);
  $('#tToggle').addEventListener('click', () => { toggleOwnTactic(name); openTacticDetail(name); refreshList(); });
}
function toggleOwnTactic(name) {
  if (S.owned.tactics[name]) delete S.owned.tactics[name]; else S.owned.tactics[name] = true;
  saveOwned();
}
function refreshList() {
  updateStatus();
  if (S.tab === 'home') renderHome($('#view'));
  if (S.tab === 'generals' && $('#glist')) drawGeneralList();
  if (S.tab === 'tactics' && $('#tlist')) drawTacticList();
}

// ----- 編成依頼 -----
// 依頼に使う手持ち（所持していればシーズンに関係なく含める。限定配布などがあるため）
function reqSeasonNum() { return seasonNum(S.req.season); }
function ownedForReq(ignoreBind) {
  const n = reqSeasonNum();
  const k = bindKey(), val = S.req.bindValue;
  return {
    // 勢力/家門を指定した場合は、その武将だけを送る
    g: S.generals.filter((g) => isOwnedG(g) && (ignoreBind || !k || !val || g[k] === val)),
    t: S.tactics.filter((t) => isOwnedT(t)),
  };
}
// ---- 勢力・家門の縛り ----
function bindKey() { return S.req.bind === 'faction' ? 'faction' : S.req.bind === 'family' ? 'family' : null; }
function bindLabel() { return S.req.bind === 'faction' ? '勢力' : '家門'; }
// 依頼シーズンで使える手持ちを、勢力/家門ごとに数える
function bindGroups() {
  const k = bindKey(); if (!k) return [];
  const cnt = {};
  for (const g of ownedForReq(true).g) if (g[k]) cnt[g[k]] = (cnt[g[k]] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]);
}
function bindPickerHtml() {
  const k = bindKey(); if (!k) return '';
  const r = S.req, groups = bindGroups();
  const usable = groups.filter(([, c]) => c >= 3);
  const maxSquads = usable.reduce((s, [, c]) => s + Math.floor(c / 3), 0);
  let note;
  if (r.bindValue) {
    const c = (groups.find(([n]) => n === r.bindValue) || [, 0])[1];
    note = `手持ちの${esc(r.bindValue)}は ${c} 名。組めるのは最大 ${Math.floor(c / 3)} 部隊です。`;
  } else {
    note = `3名以上いる${bindLabel()}：${usable.map(([n, c]) => `${esc(n)}(${c})`).join('、') || 'なし'}。部隊ごとに${bindLabel()}を変えて、最大 ${maxSquads} 部隊まで組めます。`;
  }
  if (r.bindValue ? false : maxSquads < r.squads) note += `<br><span class="miss">部隊数 ${r.squads} に足りません。</span>`;
  return `<select class="select" id="rBindValue" style="margin-top:8px">
      <option value="">${bindLabel()}は部隊ごとにおまかせ</option>
      ${groups.map(([n, c]) => `<option value="${esc(n)}" ${r.bindValue === n ? 'selected' : ''}>${esc(n)}（${c}名）で全部隊</option>`).join('')}
    </select><p class="note">${note}</p>`;
}

// ---- 編成を指定して戦法・兵学だけ考える ----
const SLOT_LABELS = ['大将', '副将', '副将'];
function fixedSquads() {
  if (!Array.isArray(S.req.fixed) || !S.req.fixed.length) S.req.fixed = [['', '', '']];
  return S.req.fixed;
}
function fixedSquadsHtml(ownedG) {
  const squads = fixedSquads();
  const used = {};
  squads.flat().filter(Boolean).forEach((n) => { used[n] = (used[n] || 0) + 1; });
  const cards = squads.map((sq, i) => {
    const gs = sq.map((n) => S.nameIndex[n]).filter(Boolean);
    const cost = gs.reduce((s, g) => s + (+g.cost || 0), 0);
    // 3人に共通する兵種ボーナス
    const common = ['足軽', '騎兵', '弓兵', '鉄砲', '兵器'].filter((t) => gs.length === 3 && gs.every((g) => troopTypes(g).includes(t)));
    const slots = sq.map((n, j) => `<div class="field" style="margin:6px 0"><label>${SLOT_LABELS[j]}</label>
      <select class="select" data-fx="${i}-${j}">
        <option value="">（選ぶ）</option>
        ${ownedG.map((g) => `<option value="${esc(g.name)}" ${g.name === n ? 'selected' : ''}>${esc(g.name)}（COST${esc(g.cost)}・${esc(g.troop)}）</option>`).join('')}
      </select></div>`).join('');
    const warn = sq.filter((n) => n && used[n] > 1);
    return `<div class="fcard">
      <div class="fcard-head"><b style="color:var(--text)">第${i + 1}部隊</b>
        <span>COST ${cost}</span><span>${common.length ? '兵種そろい: ' + common.join('・') : gs.length === 3 ? '兵種ボーナスがそろわない' : ''}</span></div>
      ${slots}
      ${warn.length ? `<p class="note miss">${esc([...new Set(warn)].join('、'))} が複数の部隊に入っています</p>` : ''}
      ${gs.length && gs.length < 3 ? `<p class="note miss">3人そろっていません（${gs.length}人）</p>` : ''}
      ${squads.length > 1 ? `<button class="btn" data-fxdel="${i}" style="min-height:38px">この部隊を削除</button>` : ''}
    </div>`;
  }).join('');
  return `${cards}<button class="btn" id="fxAdd">＋ 部隊を追加</button>`;
}

function renderRequest(v) {
  const r = S.req;
  const { g: ownedG, t: ownedT } = ownedForReq();
  const fixedMode = r.kind === 'fixed';
  const chipList = (key) => r[key].map((n) => `<button class="chip on" data-rm="${key}" data-v="${esc(n)}">${esc(n)} ✕</button>`).join('');
  const options = ownedG.map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('');
  v.innerHTML = `
    <div class="section">
      <h2>依頼の種類</h2>
      <div class="seg" id="rKind">
        <button data-k="build" class="${!fixedMode ? 'on' : ''}">編成から考える</button>
        <button data-k="fixed" class="${fixedMode ? 'on' : ''}">戦法・兵学だけ</button>
      </div>
      <p class="note">${fixedMode ? '武将の組み合わせを自分で決めて、伝授戦法と兵学だけを提案してもらいます。' : '手持ちの中から、武将の組み合わせも含めて提案してもらいます。'}</p>
      <p class="note">${esc(r.season)}の依頼です。所持している武将 ${ownedG.length} 名・伝授戦法 ${ownedT.length} 件が対象です（限定武将など、初出が後のシーズンでも所持していれば含めます）。${ownedG.length ? '' : '<br>先に武将タブで所持を登録してください。'}</p>
    </div>
    ${fixedMode ? `<div class="section">
      <h2>条件</h2>
      <div class="field"><label>目的</label>
        <select class="select" id="rPurpose">
          ${['対人戦（同盟戦）', '攻城', '土地開拓・NPC', 'スタートダッシュ', '防衛'].map((p) => `<option ${r.purpose === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select></div>
      <div class="field"><label>シーズン</label>
        <div class="seg" id="rSeason">${Array.from({ length: S.maxSeason }, (_, i) => `S${i + 1}`).map((s) => `<button data-s="${s}" class="${r.season === s ? 'on' : ''}">${s}</button>`).join('')}</div></div>
      <div class="field"><label>その他の要望（自由記述）</label>
        <textarea class="textarea" id="rExtra" placeholder="例: 第1部隊は回復を厚めに。乱世の華は第2部隊で使いたい。">${esc(r.extra)}</textarea></div>
    </div>
    <div class="section">
      <h2>部隊（武将は固定）</h2>
      ${fixedSquadsHtml(ownedG)}
    </div>` : `<div class="section">
      <h2>条件</h2>
      <div class="field"><label>部隊数</label>
        <div class="stepper"><button id="sqMinus">−</button><b id="sqVal">${r.squads}</b><button id="sqPlus">＋</button></div></div>
      <div class="field"><label>目的</label>
        <select class="select" id="rPurpose">
          ${['対人戦（同盟戦）', '攻城', '土地開拓・NPC', 'スタートダッシュ', '防衛'].map((p) => `<option ${r.purpose === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select></div>
      <div class="field"><label>シーズン</label>
        <div class="seg" id="rSeason">${Array.from({ length: S.maxSeason }, (_, i) => `S${i + 1}`).map((s) => `<button data-s="${s}" class="${r.season === s ? 'on' : ''}">${s}</button>`).join('')}</div></div>
      <div class="field"><label>縛り（各部隊の3人をそろえる）</label>
        <div class="seg" id="rBind">
          ${[['none', 'なし'], ['faction', '同じ勢力'], ['family', '同じ家門']].map(([k, l]) => `<button data-b="${k}" class="${(r.bind || 'none') === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        ${bindPickerHtml()}
      </div>
      <div class="field"><label>部隊のCOST上限（空欄なら指定なし）</label>
        <input class="input" id="rCost" type="number" inputmode="numeric" min="1" max="40" value="${esc(r.costMax)}" placeholder="例: 18"></div>
      <div class="field"><label>必ず使う武将</label>
        <select class="select" id="rMust"><option value="">＋ 追加</option>${options}</select>
        <div class="picked" id="pMust">${chipList('must')}</div></div>
      <div class="field"><label>使わない武将</label>
        <select class="select" id="rEx"><option value="">＋ 追加</option>${options}</select>
        <div class="picked" id="pEx">${chipList('exclude')}</div></div>
      <div class="field"><label>その他の要望（自由記述）</label>
        <textarea class="textarea" id="rExtra" placeholder="例: 1軍は騎兵で。相手は武田の騎兵編成が多い。">${esc(r.extra)}</textarea></div>
    </div>`}
    <div class="section">
      <h2>出力の形式</h2>
      <div class="seg" id="rMode">
        <button data-m="skill" class="${r.mode === 'skill' ? 'on' : ''}">SKILLあり</button>
        <button data-m="full" class="${r.mode === 'full' ? 'on' : ''}">SKILLなし</button>
      </div>
      <p class="note" id="modeNote"></p>
      <label class="check" id="formsRow"><input type="checkbox" id="rForms" ${r.withForms ? 'checked' : ''}> データの推奨編成も含める</label>
      ${S.heigaku.length ? `<label class="check"><input type="checkbox" id="rHeigaku" ${r.withHeigaku ? 'checked' : ''}> 兵学の割り当ても提案してもらう（S2以降）</label>` : ''}
      <div style="height:6px"></div>
      <button class="btn primary" id="rGen">プロンプトを作成</button>
    </div>
    <div class="section" id="outSec" hidden>
      <h2>プロンプト <span id="outLen" style="font-size:12px;color:var(--text3);font-weight:400"></span></h2>
      <textarea class="textarea output" id="rOut" readonly></textarea>
      <div class="btn-row"><button class="btn primary" id="rCopy">コピー</button><button class="btn" id="rShare">共有</button></div>
    </div>`;
  const modeNote = () => {
    $('#modeNote').textContent = r.mode === 'skill'
      ? 'shinsen-formation SKILL を入れた Claude 向け。名前と条件だけの短いプロンプトです。'
      : 'SKILLなしでも使えるよう、手持ちの武将・戦法の効果文を埋め込みます（長くなります）。';
    $('#formsRow').hidden = r.mode === 'skill';
  };
  modeNote();
  $('#rKind').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; r.kind = b.dataset.k; saveReq(); renderRequest(v); };
  if (fixedMode) {
    v.querySelectorAll('[data-fx]').forEach((sel) => {
      sel.onchange = () => { const [i, j] = sel.dataset.fx.split('-').map(Number); fixedSquads()[i][j] = sel.value; saveReq(); renderRequest(v); };
    });
    v.querySelectorAll('[data-fxdel]').forEach((b) => { b.onclick = () => { fixedSquads().splice(+b.dataset.fxdel, 1); saveReq(); renderRequest(v); }; });
    $('#fxAdd').onclick = () => { fixedSquads().push(['', '', '']); saveReq(); renderRequest(v); };
  } else {
    $('#sqMinus').onclick = () => { r.squads = Math.max(1, r.squads - 1); $('#sqVal').textContent = r.squads; saveReq(); };
    $('#sqPlus').onclick = () => { r.squads = Math.min(10, r.squads + 1); $('#sqVal').textContent = r.squads; saveReq(); };
  }
  $('#rPurpose').onchange = (e) => { r.purpose = e.target.value; saveReq(); };
  // 依頼のシーズンと一覧のシーズン絞り込みは同じ設定として扱う
  $('#rSeason').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    r.season = b.dataset.s; saveReq();
    S.season = { sel: seasonNum(r.season), mode: 'upto' }; store.set('season', S.season);
    renderRequest(v);
  };
  if ($('#rBind')) $('#rBind').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; r.bind = b.dataset.b; r.bindValue = ''; saveReq(); renderRequest(v); };
  if ($('#rBindValue')) $('#rBindValue').onchange = (e) => { r.bindValue = e.target.value; saveReq(); renderRequest(v); };
  if ($('#rCost')) $('#rCost').oninput = (e) => { r.costMax = e.target.value; saveReq(); };
  $('#rExtra').oninput = (e) => { r.extra = e.target.value; saveReq(); };
  const addPick = (sel, key) => { if (!$(sel)) return; $(sel).onchange = (e) => { const n = e.target.value; if (n && !r[key].includes(n)) { r[key].push(n); saveReq(); renderRequest(v); } }; };
  addPick('#rMust', 'must'); addPick('#rEx', 'exclude');
  v.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { const a = r[b.dataset.rm]; a.splice(a.indexOf(b.dataset.v), 1); saveReq(); renderRequest(v); }; });
  $('#rMode').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; r.mode = b.dataset.m; for (const x of e.currentTarget.children) x.classList.toggle('on', x === b); modeNote(); saveReq(); };
  $('#rForms').onchange = (e) => { r.withForms = e.target.checked; saveReq(); };
  if ($('#rHeigaku')) $('#rHeigaku').onchange = (e) => { r.withHeigaku = e.target.checked; saveReq(); };
  $('#rGen').onclick = () => {
    const text = buildPrompt();
    $('#outSec').hidden = false;
    $('#rOut').value = text;
    $('#outLen').textContent = `${text.length.toLocaleString()} 文字`;
    $('#outSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#rCopy').onclick = async () => {
    const text = $('#rOut').value;
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    catch (e) { $('#rOut').select(); document.execCommand('copy'); toast('コピーしました'); }
  };
  $('#rShare').onclick = async () => {
    const text = $('#rOut').value;
    if (navigator.share) { try { await navigator.share({ text }); } catch (e) { /* キャンセル */ } }
    else toast('この端末は共有に対応していません。コピーを使ってください');
  };
}

// 依頼シーズンより後に登場したのに所持しているもの（限定配布など）があれば、使えると明記する
function lateOwnedLine() {
  const n = reqSeasonNum();
  const late = [...S.generals.filter((g) => isOwnedG(g) && seasonNum(g.debut) > n).map((g) => g.name),
    ...S.tactics.filter((t) => isOwnedT(t) && seasonNum(t.debut) > n).map((t) => t.name)];
  return late.length ? [`- ${late.join('、')} は${S.req.season}より後のシーズンで登場したものですが、限定配布などで所持しているので使えます`] : [];
}

function conditionLines() {
  const r = S.req;
  const L = [];
  L.push(`- 部隊数: ${r.squads}`);
  L.push(`- 目的: ${r.purpose}`);
  L.push(`- シーズン: ${r.season}`);
  L.push(`- 部隊のCOST上限: ${r.costMax ? r.costMax : '指定なし（合計COSTを明記してください）'}`);
  if (r.must.length) L.push(`- 必ず使う武将: ${r.must.join('、')}`);
  if (r.exclude.length) L.push(`- 使わない武将: ${r.exclude.join('、')}`);
  if (bindKey()) {
    const lab = bindLabel();
    L.push(r.bindValue
      ? `- 縛り: 全部隊とも、武将3名を${lab}「${r.bindValue}」でそろえる（手持ちの「${lab}」欄で判定）`
      : `- 縛り: 各部隊の武将3名を同じ${lab}でそろえる（${lab}は部隊ごとに違ってよい。手持ちの「${lab}」欄で判定）`);
  }
  if (r.extra.trim()) L.push(`- その他の要望: ${r.extra.trim()}`);
  L.push(...lateOwnedLine());
  L.push(...conditionExtra.splice(0));
  return L;
}
const conditionExtra = [];

// 武将1人分の説明（SKILLなしで埋め込む用）
function generalBlock(g, withForms, role) {
  const L = [];
  const tot = S.owned.generals[g.slug] ? S.owned.generals[g.slug].totsu || 0 : 0;
  const st = g.stats;
  const sv = ['武勇', '知略', '統率', '速度'].map((k) => (st[k] ? `${k[0]}${Math.round(st[k].lv50)}` : '')).join(' ');
  L.push(`### ${role ? role + ' ' : ''}${g.name}（${tot}凸）★${g.star} 勢力:${g.faction} 家門:${g.family || '-'} COST${g.cost} ${g.troop} ${g.tier}`);
  L.push(`- Lv50属性: ${sv}`);
  L.push(`- 固有戦法 ${g.unique}: ${g.uniqueEffect}`);
  const tr = g.traits.filter((t) => t.n <= tot).map((t) => {
    const info = S.traits[t.name];
    return `${t.name}${info ? '（' + info.effect + '）' : ''}`;
  });
  if (tr.length) L.push(`- 解放済み特性: ${tr.join(' / ')}`);
  if (withForms) {
    // 依頼シーズンまでに登場した武将・戦法だけで組める推奨編成に限る（ラベルの S5 などは評価時点）
    for (const f of formationsOf(g, reqSeasonNum())) L.push(`- 推奨編成: ${formationText(f)}`);
  }
  return L;
}
function tacticAndHeigakuLines(ownedT, useHeigaku) {
  const L = ['', `## 手持ち伝授戦法（${ownedT.length}件）`];
  for (const t of ownedT) L.push(`- ${t.name}（${t.rank}・${t.kind}）: ${t.effect}`);
  if (useHeigaku) {
    L.push('', '## 兵学の候補（武将ごとに選べる候補は異なる）');
    for (const h of S.heigaku.filter((x) => seasonOk(x.debut, reqSeasonNum(), 'upto'))) L.push(`- ${h.system}/${h.kind} ${h.name}: ${h.effect}`);
  }
  return L;
}

// 編成を指定して、伝授戦法と兵学だけを考えてもらうプロンプト
function buildFixedPrompt() {
  const r = S.req;
  const ownedT = ownedForReq().t;
  const useHeigaku = r.withHeigaku && S.heigaku.length && reqSeasonNum() >= 2;
  const squads = fixedSquads().map((sq) => sq.map((n) => S.nameIndex[n]).filter(Boolean)).filter((sq) => sq.length);
  const roleOf = (i) => SLOT_LABELS[i];
  const cond = [`- 目的: ${r.purpose}`, `- シーズン: ${r.season}`];
  if (r.extra.trim()) cond.push(`- その他の要望: ${r.extra.trim()}`);
  cond.push(...lateOwnedLine());
  const L = [];
  if (r.mode === 'skill') {
    L.push('shinsen-formation スキルを使って、下の部隊の伝授戦法を提案してください。');
    L.push(`武将の組み合わせと大将・副将の配置は変えないでください。${useHeigaku ? '各武将の兵学（data/heigaku.md）の系統・兵学・奇・兵学・正の振り方も提案してください。' : ''}`);
    L.push('伝授戦法は手持ちだけを使い、同じ戦法を複数の部隊で使わないでください（入手候補として別枠で挙げるのは可）。');
    L.push('', '## 条件', ...cond, '', '## 部隊（武将は固定、()内は凸数）');
    squads.forEach((sq, i) => {
      L.push(`- 第${i + 1}部隊: ` + sq.map((g, j) => `${roleOf(j)} ${g.name}(${(S.owned.generals[g.slug] || {}).totsu || 0})`).join(' / '));
    });
    L.push('', `## 手持ち伝授戦法（${ownedT.length}件）`, ownedT.map((t) => t.name).join('、') || '（なし）');
    return L.join('\n');
  }
  L.push('あなたは「信長の野望 真戦」の編成アドバイザーです。下の部隊は武将の組み合わせと大将・副将の配置が決まっています。');
  L.push(`各武将の伝授戦法2つ${useHeigaku ? 'と兵学' : ''}を、手持ちの中から提案してください。`);
  L.push('', '## ルール');
  L.push('- 武将の入れ替え・配置変更はしない。各武将は固有戦法1＋伝授戦法2');
  L.push('- 伝授戦法は手持ちだけを使う。同じ戦法を複数の部隊で使わない（入手候補として別枠で挙げるのは可）');
  L.push('- 役割は火力・補助・制御・回復。火力3枠以上、被ダメ減1〜2、回復1〜2（3以上は過剰になりやすい）が目安');
  L.push('- 固有戦法との相性（能動・突撃・指揮・受動の種別、依存する属性）と、特性は凸数で解放済みのものだけを考慮する');
  L.push('- 陣形戦法や家門・勢力条件のある戦法は、発動条件を満たすか確認する');
  if (useHeigaku) L.push('- 兵学: 各武将は4系統（武略・機略・陣立・臨戦）から1つを選び、兵学・奇を1つ、兵学・正に3点（1項目最大Lv2）を振る');
  L.push('', '## 条件', ...cond);
  squads.forEach((sq, i) => {
    const cost = sq.reduce((s, g) => s + (+g.cost || 0), 0);
    L.push('', `## 第${i + 1}部隊（合計COST ${cost}）`);
    sq.forEach((g, j) => L.push(...generalBlock(g, r.withForms, roleOf(j))));
  });
  L.push(...tacticAndHeigakuLines(ownedT, useHeigaku));
  L.push('', '## 出力の形');
  L.push(`部隊ごとに、大将/副将それぞれの武将・固有戦法・伝授戦法2つ${useHeigaku ? '・兵学（系統／奇／正の振り方）' : ''}を表で示し、選んだ理由と注意点を短く書いてください。最後に、入手すると強くなる戦法を挙げてください。`);
  return L.join('\n');
}

function buildPrompt() {
  if (S.req.kind === 'fixed') return buildFixedPrompt();
  const r = S.req;
  const own = ownedForReq();
  const ownedG = own.g.filter((g) => !r.exclude.includes(g.name));
  const ownedT = own.t;
  const useHeigaku = r.withHeigaku && S.heigaku.length && reqSeasonNum() >= 2;
  const L = [];
  if (r.mode === 'skill') {
    if (useHeigaku) conditionExtra.push('- 兵学: 各武将に兵学（data/heigaku.md）の系統・兵学・奇・兵学・正の振り方も提案してください');
    L.push('shinsen-formation スキルを使って、信長の野望 真戦の部隊編成を提案してください。');
    L.push('手持ちにない武将・戦法は使わないでください（入手候補として別枠で挙げるのは可）。');
    L.push('');
    L.push('## 条件');
    L.push(...conditionLines());
    L.push('');
    L.push(`## 手持ち武将（${ownedG.length}名、()内は凸数）`);
    const bk = bindKey();
    if (bk) {
      // 縛りがあるときは勢力/家門ごとにまとめて渡す
      L[L.length - 1] = `## 手持ち武将（${ownedG.length}名、${bindLabel()}ごと。()内は凸数）`;
      const groups = {};
      for (const g of ownedG) (groups[g[bk] || '不明'] = groups[g[bk] || '不明'] || []).push(`${g.name}(${S.owned.generals[g.slug].totsu || 0})`);
      for (const [k, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) L.push(`- ${k}（${list.length}名）: ${list.join('、')}`);
    } else {
      L.push(ownedG.map((g) => `${g.name}(${S.owned.generals[g.slug].totsu || 0})`).join('、') || '（なし）');
    }
    L.push('');
    L.push(`## 手持ち伝授戦法（${ownedT.length}件）`);
    L.push(ownedT.map((t) => t.name).join('、') || '（なし）');
    return L.join('\n');
  }
  // SKILLなし: データ埋め込み
  L.push('あなたは「信長の野望 真戦」の編成アドバイザーです。下の手持ちだけを使って部隊編成を提案してください。');
  L.push('手持ちにない武将・戦法は使わないでください（入手候補として別枠で挙げるのは可）。');
  L.push('');
  L.push('## 編成ルール');
  L.push('- 1部隊は武将3名（大将1＋副将2）。各武将は固有戦法1＋伝授戦法2（部隊で9枠）');
  L.push('- 同じ武将・同じ伝授戦法は複数の部隊で同時に使わない。強い戦法は1軍・2軍に集中させる');
  L.push('- 役割は火力・補助・制御・回復。火力3枠以上、被ダメ減1〜2、回復1〜2（3以上は過剰になりやすい）が目安。敵3万兵力を削り切る火力が目標');
  L.push('- 兵種相性: 足軽→騎兵→弓兵→鉄砲→足軽（矢印の先に強い）。部隊の兵種は3名の兵種ボーナスが揃うものが強い');
  L.push('- 特性は、各武将の凸数で解放済みのものだけを考慮する');
  L.push('- 陣形戦法や家門・勢力条件のある戦法・特性は、発動条件を確認する');
  if (useHeigaku) {
    L.push('- 兵学: 各武将は4系統（武略・機略・陣立・臨戦）から1つを選び、兵学・奇を1つ、兵学・正に3点（1項目最大Lv2）を振る');
    conditionExtra.push('- 兵学: 各武将の兵学（系統・兵学・奇・兵学・正の振り方）も提案してください');
  }
  L.push('');
  L.push('## 条件');
  L.push(...conditionLines());
  L.push('');
  L.push(`## 手持ち武将（${ownedG.length}名）`);
  for (const g of ownedG) L.push(...generalBlock(g, r.withForms));
  L.push(...tacticAndHeigakuLines(ownedT, useHeigaku));
  L.push('');
  L.push('## 出力の形');
  L.push('部隊ごとに「兵種・合計COST」と、大将/副将それぞれの武将・固有戦法・伝授戦法2つを表で示し、狙い・根拠・注意点を短く書いてください。最後に、使わなかった有力な手持ちと、入手すると強化できる武将・戦法を挙げてください。');
  return L.join('\n');
}

// ----- 設定 -----
function renderSettings(v) {
  const names = Object.keys(S.files);
  v.innerHTML = `
    <div class="section dropzone" id="dz">
      <h2>データ（Markdown）</h2>
      ${names.length ? `<ul class="filelist">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        <p class="note">武将 ${S.generals.length} 名・戦法 ${S.tactics.length} 件・特性 ${Object.keys(S.traits).length} 種・兵学 ${S.heigaku.length} 件（S${S.maxSeason}まで）／ 読み込み ${esc(S.loadedAt)}</p>`
      : '<p class="note">まだ読み込んでいません。</p>'}
      <p class="note">data フォルダの generals.md・tactics.md・traits.md・heigaku.md をまとめて選んでください（スマホは「ファイル」アプリから複数選択）。一度読み込めば端末に保存されます。データを更新したら読み込み直してください。</p>
      <button class="btn primary" id="sFiles">md ファイルを選択</button>
      <div style="height:8px"></div>
      <div class="btn-row" style="margin-top:0"><button class="btn" id="sDir">フォルダごと選択（PC）</button><button class="btn" id="sSample">サンプルで試す</button></div>
      <p class="note">PCではここに md ファイルをドラッグ＆ドロップしても読み込めます。データの書き方は FORMAT.md を見てください。</p>
    </div>
    ${names.length ? `<div class="section">
      <h2>書式チェック ${S.warnings && S.warnings.length ? `<span class="miss" style="font-size:13px">${S.warnings.length}件の警告</span>` : '<span style="font-size:13px;color:var(--own)">問題なし</span>'}</h2>
      ${S.warnings && S.warnings.length ? `<ul class="filelist">${S.warnings.slice(0, S.showAllWarn ? 9999 : 20).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
        ${S.warnings.length > 20 && !S.showAllWarn ? `<button class="btn" id="sWarnAll">すべて表示（${S.warnings.length}件）</button>` : ''}`
      : '<p class="note">必須項目と書き方に問題は見つかりませんでした。</p>'}
    </div>` : ''}
    <div class="section">
      <h2>手持ちのバックアップ</h2>
      <p class="note">所持・凸・戦法と依頼条件を JSON で書き出し、別の端末で読み込めます。</p>
      <div class="btn-row"><button class="btn" id="sExport">書き出し</button><button class="btn" id="sImport">読み込み</button></div>
    </div>
    <div class="section">
      <h2>表示</h2>
      <div class="seg" id="sTheme">
        ${[['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([k, l]) => `<button data-th="${k}" class="${(S.theme || 'auto') === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="section">
      <h2>リセット</h2>
      <button class="btn danger" id="sReset">手持ちの登録をすべて消す</button>
    </div>
    <div class="section">
      <p class="note">このツールはデータを含みません。データは各自で用意してください（書式は FORMAT.md）。読み込んだファイルは端末内にだけ保存されます。</p>
    </div>`;
  $('#sFiles').onclick = () => $('#fileInput').click();
  $('#sDir').onclick = () => $('#dirInput').click();
  $('#sSample').onclick = loadSample;
  if ($('#sWarnAll')) $('#sWarnAll').onclick = () => { S.showAllWarn = true; render(); };
  $('#sExport').onclick = exportJson;
  $('#sImport').onclick = () => $('#jsonInput').click();
  $('#sReset').onclick = () => {
    if (!confirm('所持・凸・戦法の登録をすべて消します。よろしいですか？')) return;
    S.owned = { generals: {}, tactics: {} }; saveOwned(); toast('消去しました'); render();
  };
  $('#sTheme').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.theme = b.dataset.th; applyTheme(); store.set('theme', S.theme); render();
  };
  const dz = $('#dz');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); loadFiles(e.dataTransfer.files); });
}

function applyTheme() {
  if (!S.theme || S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', S.theme);
}

async function loadFiles(fileList) {
  const files = [...fileList].filter((f) => /\.md$/i.test(f.name));
  if (!files.length) { toast('md ファイルが選ばれていません'); return; }
  const next = { ...S.files };
  for (const f of files) next[f.name] = await f.text();
  const prev = S.files;
  S.files = next;
  buildData();
  if (!S.generals.length) { S.files = prev; buildData(); toast('generals.md が見つかりません'); return; }
  S.loadedAt = new Date().toLocaleString('ja-JP');
  await store.set('data', { files: S.files, loadedAt: S.loadedAt });
  toast(`読み込みました（武将${S.generals.length}・戦法${S.tactics.length}）`);
  render();
}

// templates/ の架空データを読み込む（GitHub Pages やローカルサーバーで開いたときに使える）
async function loadSample() {
  if (S.generals.length && !confirm('今のデータをサンプル（架空の武将4名）に置き換えます。手持ちの登録は残ります。よろしいですか？')) return;
  try {
    const names = ['generals.md', 'tactics.md', 'traits.md', 'heigaku.md'];
    const files = (await Promise.all(names.map(async (n) => {
      const r = await fetch(`../templates/${n}`, { cache: 'no-store' });
      if (!r.ok) { if (n === 'generals.md') throw new Error(n); return null; }
      return new File([await r.text()], n);
    }))).filter(Boolean);
    S.files = {};
    await loadFiles(files);
  } catch (e) {
    toast('サンプルを読み込めませんでした（ファイルを直接開いている場合は使えません）');
  }
}

function exportJson() {
  const data = { app: 'shinsen-tool', version: 1, exportedAt: new Date().toISOString(), owned: S.owned, req: S.req };
  // slug だけだと読みにくいので名前も付ける
  data.ownedNames = S.generals.filter(isOwnedG).map((g) => `${g.name}(${S.owned.generals[g.slug].totsu || 0}凸)`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shinsen-owned-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d.owned || !d.owned.generals) throw new Error('形式が違います');
    S.owned = { generals: d.owned.generals || {}, tactics: d.owned.tactics || {} };
    if (d.req) S.req = { ...S.req, ...d.req };
    await store.set('owned', S.owned); saveReq();
    toast('手持ちを読み込みました'); render();
  } catch (e) { toast('読み込めませんでした: ' + e.message); }
}

// ---------------- シート ----------------
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false; $('#sheetBg').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheetBg').hidden = true;
  document.body.style.overflow = '';
  const fn = S.onSheetClose; S.onSheetClose = null;
  // シートのイベントを外すため中身を作り直す
  const b = $('#sheetBody'); b.replaceWith(Object.assign(document.createElement('div'), { id: 'sheetBody' }));
  if (fn) fn();
}
window.setTab = setTab; window.closeSheet = closeSheet; window.loadSample = loadSample;

// ---------------- 起動 ----------------
async function init() {
  $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#sheetBg').addEventListener('click', closeSheet);
  $('#view').addEventListener('click', (e) => {
    if (e.target.closest('[data-season]')) { openSeasonSheet(); return; }
    const ob = e.target.closest('[data-own]');
    if (ob) { e.stopPropagation(); toggleOwnGeneral(ob.dataset.own); refreshList(); return; }
    const ot = e.target.closest('[data-owntac]');
    if (ot) { e.stopPropagation(); toggleOwnTactic(ot.dataset.owntac); refreshList(); return; }
    const gc = e.target.closest('[data-slug]');
    if (gc) { openGeneralDetail(gc.dataset.slug); return; }
    const tc = e.target.closest('[data-tac]');
    if (tc) openTacticDetail(tc.dataset.tac);
  });
  $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
  $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
  $('#jsonInput').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });

  const [data, owned, req, theme, season] = await Promise.all([store.get('data'), store.get('owned'), store.get('req'), store.get('theme'), store.get('season')]);
  if (season) S.season = season;
  if (data && data.files) { S.files = data.files; S.loadedAt = data.loadedAt || ''; buildData(); }
  if (owned) S.owned = { generals: owned.generals || {}, tactics: owned.tactics || {} };
  if (req) S.req = { ...S.req, ...req };
  S.theme = theme || 'auto'; applyTheme();
  setTab(S.generals.length ? 'home' : 'settings');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
