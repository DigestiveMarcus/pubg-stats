// Hämtar PUBG-statistik för spelarna i players.json.
// stats.json   = säsongs- och totalstatistik (skrivs över varje gång)
// history.json = en rad per match och spelare, byggs på över tid
// Körs av GitHub Actions. Kräver PUBG_API_KEY, och valfritt DISCORD_WEBHOOK för vinstaviseringar.
const fs = require("fs");

const KEY = process.env.PUBG_API_KEY;
const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!KEY) { console.error("PUBG_API_KEY saknas"); process.exit(1); }

const BASE = "https://api.pubg.com/shards/steam";
const HEADERS = { Authorization: `Bearer ${KEY}`, Accept: "application/vnd.api+json" };
const MODES = ["solo", "solo-fpp", "duo", "duo-fpp", "squad", "squad-fpp"];
const MAX_NEW_MATCHES = 120;  // per körning, så första körningen inte tar evigheter
const SCHEMA = 3;             // höj när nya fält läggs till, så sparade matcher hämtas om
const NOTIFY_WITHIN_H = 3;    // avisera bara vinster som är färskare än så här
const names = JSON.parse(fs.readFileSync("players.json", "utf8"));

const MAPS = {
  Baltic_Main: "Erangel", Erangel_Main: "Erangel", Desert_Main: "Miramar", Savage_Main: "Sanhok",
  DihorOtok_Main: "Vikendi", Tiger_Main: "Taego", Kiki_Main: "Deston", Neon_Main: "Rondo",
  Summerland_Main: "Karakin", Chimera_Main: "Paramo", Heaven_Main: "Haven", Range_Main: "Camp Jackal",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rate-limitade anrop (10/min): vänta ~6,5 s mellan varje, och en minut vid 429.
async function api(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path, { headers: HEADERS });
    await sleep(6500);
    if (res.status === 429) { console.log("Rate limit, väntar 60 s..."); await sleep(60000); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }
  throw new Error(`Gav upp efter rate limit: ${path}`);
}

// Matcher och telemetri räknas inte mot rate limit.
async function free(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    await sleep(2000);
  }
  throw new Error(`Kunde inte hämta ${url}`);
}

const toPlayer = p => ({
  id: p.id,
  name: p.attributes.name,
  matchIds: (p.relationships?.matches?.data ?? []).map(m => m.id),
});

async function lookupPlayers() {
  const all = await api(`/players?filter[playerNames]=${names.map(encodeURIComponent).join(",")}`);
  if (all) return all.data.map(toPlayer);
  const found = [];
  for (const n of names) {
    const one = await api(`/players?filter[playerNames]=${encodeURIComponent(n)}`);
    if (one) found.push(toPlayer(one.data[0]));
    else console.warn(`Hittade inte spelaren "${n}" (kolla stavning och versaler)`);
  }
  return found;
}

async function statsFor(seasonId, ids) {
  const out = {};
  for (const mode of MODES) {
    const res = await api(`/seasons/${seasonId}/gameMode/${mode}/players?filter[playerIds]=${ids.join(",")}`);
    out[mode] = {};
    for (const row of res?.data ?? []) {
      out[mode][row.relationships.player.data.id] = row.attributes.gameModeStats[mode];
    }
  }
  return out;
}

// Läser matchloggen: knockar, kills, bot-kills, kills och skada per vapen, vem som dödade våra spelare,
// och hur många lagkompisar de själva har knockat eller dödat.
function parseTelemetry(tel, ours) {
  const r = {};
  const get = id => (r[id] ??= { knocked: 0, tk: 0, bk: 0, w: {}, wd: {}, kb: null, tkn: 0, tkl: 0, tkv: {} });
  const sameTeam = (a, b) => a && b && a.teamId != null && a.teamId === b.teamId;
  for (const e of tel) {
    if (e._T === "LogPlayerTakeDamage") {
      const a = e.attacker, v = e.victim;
      if (!a || !ours.has(a.accountId) || !v || v.accountId === a.accountId || v.teamId === a.teamId || !(e.damage > 0)) continue;
      const weapon = e.damageCauserName || "Okänt";
      const wd = get(a.accountId).wd;
      wd[weapon] = (wd[weapon] || 0) + e.damage;
    } else if (e._T === "LogPlayerMakeGroggy") {
      const v = e.victim?.accountId, a = e.attacker?.accountId;
      if (ours.has(v)) get(v).knocked++;
      if (ours.has(a) && a !== v && sameTeam(e.attacker, e.victim)) {
        const me = get(a); me.tkn++; me.tkv[e.victim.name] = (me.tkv[e.victim.name] || 0) + 1;
      }
    } else if (e._T === "LogPlayerKillV2") {
      const k = e.killer?.accountId, v = e.victim?.accountId;
      if (ours.has(v) && k && k !== v) get(v).kb = { n: e.killer.name, bot: k.startsWith("ai.") };
      if (!ours.has(k) || v === k) continue;
      const me = get(k);
      if (sameTeam(e.killer, e.victim)) { me.tkl++; me.tkv[e.victim.name] = (me.tkv[e.victim.name] || 0) + 1; continue; }
      me.tk++;
      if (String(v).startsWith("ai.")) me.bk++;
      const weapon = e.killerDamageInfo?.damageCauserName;
      if (weapon) me.w[weapon] = (me.w[weapon] || 0) + 1;
    }
  }
  for (const x of Object.values(r)) for (const k in x.wd) x.wd[k] = Math.round(x.wd[k]);
  return r;
}

async function notifyWin(match, players) {
  if (!WEBHOOK) return;
  const winners = Object.entries(match.p).filter(([, s]) => s.place === 1);
  if (!winners.length) return;
  const nameOf = id => players.find(p => p.id === id)?.name ?? id;
  const who = winners.map(([id]) => nameOf(id));
  const kills = winners.reduce((a, [, s]) => a + s.k, 0);
  const list = who.length > 1 ? who.slice(0, -1).join(", ") + " och " + who.at(-1) : who[0];
  const content = `🍗 **Winner winner chicken dinner!** ${list} vann på ${MAPS[match.map] ?? match.map} (${match.mode}) med ${kills} kills.`;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    console.log("Discord:", content);
  } catch (e) { console.warn("Discord-avisering misslyckades:", e.message); }
}

async function updateHistory(players) {
  const hist = fs.existsSync("history.json")
    ? JSON.parse(fs.readFileSync("history.json", "utf8"))
    : { matches: {}, skip: {} };
  hist.skip ??= {};
  const ours = new Set(players.map(p => p.id));

  const todo = [...new Set(players.flatMap(p => p.matchIds))]
    .filter(id => !hist.skip[id] && hist.matches[id]?.v !== SCHEMA)
    .sort((a, b) => (hist.matches[a] ? 1 : 0) - (hist.matches[b] ? 1 : 0)); // nya matcher först
  console.log(`${todo.length} matcher att hämta, max ${MAX_NEW_MATCHES} per körning`);

  let added = 0;
  for (const id of todo.slice(0, MAX_NEW_MATCHES)) {
    try {
      const m = await free(`${BASE}/matches/${id}`, HEADERS);
      const a = m.data.attributes;
      // Bara vanliga matcher (inte ranked, custom, event, träning)
      if (a.matchType !== "official" || !MODES.includes(a.gameMode)) { hist.skip[id] = a.createdAt; continue; }

      const asset = m.included.find(x => x.type === "asset");
      const tel = parseTelemetry(await free(asset.attributes.URL), ours);

      const p = {};
      for (const x of m.included) {
        if (x.type !== "participant" || !ours.has(x.attributes.stats.playerId)) continue;
        const s = x.attributes.stats, t = tel[s.playerId] ?? { knocked: 0, tk: 0, bk: 0, w: {}, wd: {}, kb: null, tkn: 0, tkl: 0, tkv: {} };
        p[s.playerId] = {
          k: s.kills, dmg: Math.round(s.damageDealt), dbno: s.DBNOs, a: s.assists,
          hs: s.headshotKills, rev: s.revives, place: s.winPlace, surv: Math.round(s.timeSurvived),
          lk: Math.round(s.longestKill), dead: s.deathType === "alive" ? 0 : 1,
          knocked: t.knocked, tk: t.tk, bk: t.bk, w: t.w, wd: t.wd, kb: t.kb, tkn: t.tkn, tkl: t.tkl, tkv: t.tkv,
        };
      }
      const isNew = !hist.matches[id];
      hist.matches[id] = { v: SCHEMA, t: a.createdAt, mode: a.gameMode, map: a.mapName, p };
      if (isNew) {
        added++;
        if (Date.now() - Date.parse(a.createdAt) < NOTIFY_WITHIN_H * 36e5) await notifyWin(hist.matches[id], players);
      }
    } catch (e) {
      console.warn(`Match ${id} hoppades över: ${e.message}`);
    }
  }

  // Rensa gamla skip-poster (API:t listar bara matcher från senaste 14 dagarna)
  const cutoff = Date.now() - 30 * 864e5;
  for (const [id, t] of Object.entries(hist.skip)) if (Date.parse(t) < cutoff) delete hist.skip[id];

  fs.writeFileSync("history.json", JSON.stringify(hist));
  console.log(`History: +${added} nya matcher, totalt ${Object.keys(hist.matches).length}`);
}

(async () => {
  const players = await lookupPlayers();
  if (!players.length) throw new Error("Inga spelare hittades");
  const ids = players.map(p => p.id);

  const seasons = await api("/seasons");
  const current = seasons.data.find(s => s.attributes.isCurrentSeason).id;

  const data = {
    updated: new Date().toISOString(),
    season: current,
    players: players.map(({ id, name }) => ({ id, name })),
    stats: {
      season: await statsFor(current, ids),
      lifetime: await statsFor("lifetime", ids),
    },
  };
  fs.writeFileSync("stats.json", JSON.stringify(data, null, 1));

  await updateHistory(players);
  console.log(`Klart: ${players.length} spelare, säsong ${current}`);
})().catch(e => { console.error(e); process.exit(1); });
