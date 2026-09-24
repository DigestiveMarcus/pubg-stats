// Hämtar PUBG-statistik för spelarna i players.json.
// stats.json   = säsongs- och totalstatistik (skrivs över varje gång)
// history.json = en rad per match och spelare, byggs på över tid (form + antal gånger knockad)
// Körs av GitHub Actions. Kräver miljövariabeln PUBG_API_KEY.
const fs = require("fs");

const KEY = process.env.PUBG_API_KEY;
if (!KEY) { console.error("PUBG_API_KEY saknas"); process.exit(1); }

const BASE = "https://api.pubg.com/shards/steam";
const HEADERS = { Authorization: `Bearer ${KEY}`, Accept: "application/vnd.api+json" };
const MODES = ["solo", "solo-fpp", "duo", "duo-fpp", "squad", "squad-fpp"];
const MAX_NEW_MATCHES = 60; // per körning, så första körningen inte tar evigheter
const names = JSON.parse(fs.readFileSync("players.json", "utf8"));

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

async function updateHistory(players) {
  const hist = fs.existsSync("history.json")
    ? JSON.parse(fs.readFileSync("history.json", "utf8"))
    : { matches: {}, skip: {} };
  const ours = new Set(players.map(p => p.id));

  const todo = [...new Set(players.flatMap(p => p.matchIds))]
    // Nya matcher, plus redan sparade matcher som saknar bot-data (sparade innan den funktionen fanns)
    .filter(id => !hist.skip[id] && (!hist.matches[id] || Object.values(hist.matches[id].p).some(x => x.bk == null)));
  console.log(`${todo.length} nya matcher, hämtar max ${MAX_NEW_MATCHES}`);

  let added = 0;
  for (const id of todo.slice(0, MAX_NEW_MATCHES)) {
    try {
      const m = await free(`${BASE}/matches/${id}`, HEADERS);
      const a = m.data.attributes;
      // Bara vanliga matcher (inte ranked, custom, event, träning)
      if (a.matchType !== "official" || !MODES.includes(a.gameMode)) { hist.skip[id] = a.createdAt; continue; }

      // Telemetrin innehåller varje händelse i matchen:
      //  LogPlayerMakeGroggy -> victim = den som knockades
      //  LogPlayerKillV2     -> killer = den som fick killen; bottar har accountId som börjar med "ai."
      const asset = m.included.find(x => x.type === "asset");
      const tel = await free(asset.attributes.URL);
      const knocked = {}, kills = {}, botKills = {};
      for (const e of tel) {
        if (e._T === "LogPlayerMakeGroggy") {
          const v = e.victim?.accountId;
          if (ours.has(v)) knocked[v] = (knocked[v] || 0) + 1;
        } else if (e._T === "LogPlayerKillV2") {
          const k = e.killer?.accountId;
          if (!ours.has(k) || e.victim?.accountId === k) continue;
          kills[k] = (kills[k] || 0) + 1;
          if (String(e.victim?.accountId).startsWith("ai.")) botKills[k] = (botKills[k] || 0) + 1;
        }
      }

      const p = {};
      for (const x of m.included) {
        if (x.type !== "participant" || !ours.has(x.attributes.stats.playerId)) continue;
        const s = x.attributes.stats;
        p[s.playerId] = {
          k: s.kills, dmg: Math.round(s.damageDealt), dbno: s.DBNOs, a: s.assists,
          hs: s.headshotKills, rev: s.revives, place: s.winPlace, surv: Math.round(s.timeSurvived),
          dead: s.deathType === "alive" ? 0 : 1, knocked: knocked[s.playerId] || 0,
          tk: kills[s.playerId] || 0, bk: botKills[s.playerId] || 0,
        };
      }
      if (!hist.matches[id]) added++;
      hist.matches[id] = { t: a.createdAt, mode: a.gameMode, map: a.mapName, p };
    } catch (e) {
      console.warn(`Match ${id} hoppades över: ${e.message}`);
    }
  }

  // Rensa gamla skip-poster (API:t listar bara matcher från senaste 14 dagarna)
  const cutoff = Date.now() - 30 * 864e5;
  for (const [id, t] of Object.entries(hist.skip)) if (Date.parse(t) < cutoff) delete hist.skip[id];

  fs.writeFileSync("history.json", JSON.stringify(hist));
  console.log(`History: +${added} matcher, totalt ${Object.keys(hist.matches).length}`);
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
