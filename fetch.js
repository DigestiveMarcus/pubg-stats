// Hämtar PUBG-statistik för spelarna i players.json och sparar till stats.json.
// Körs av GitHub Actions. Kräver miljövariabeln PUBG_API_KEY.
const fs = require("fs");

const KEY = process.env.PUBG_API_KEY;
if (!KEY) { console.error("PUBG_API_KEY saknas"); process.exit(1); }

const BASE = "https://api.pubg.com/shards/steam";
const HEADERS = { Authorization: `Bearer ${KEY}`, Accept: "application/vnd.api+json" };
const MODES = ["solo", "solo-fpp", "duo", "duo-fpp", "squad", "squad-fpp"];
const names = JSON.parse(fs.readFileSync("players.json", "utf8"));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 10 anrop/minut -> vänta ~6,5 s mellan anrop, och vänta en minut om vi ändå får 429.
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

async function lookupPlayers() {
  // Ett anrop för alla. Om något namn är fel ger API:t 404 -> slå upp ett i taget.
  const all = await api(`/players?filter[playerNames]=${names.map(encodeURIComponent).join(",")}`);
  if (all) return all.data.map(p => ({ id: p.id, name: p.attributes.name }));
  const found = [];
  for (const n of names) {
    const one = await api(`/players?filter[playerNames]=${encodeURIComponent(n)}`);
    if (one) found.push({ id: one.data[0].id, name: one.data[0].attributes.name });
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

(async () => {
  const players = await lookupPlayers();
  if (!players.length) throw new Error("Inga spelare hittades");
  const ids = players.map(p => p.id);

  const seasons = await api("/seasons");
  const current = seasons.data.find(s => s.attributes.isCurrentSeason).id;

  const data = {
    updated: new Date().toISOString(),
    season: current,
    players,
    stats: {
      season: await statsFor(current, ids),
      lifetime: await statsFor("lifetime", ids),
    },
  };

  fs.writeFileSync("stats.json", JSON.stringify(data, null, 1));
  console.log(`Klart: ${players.length} spelare, säsong ${current}`);
})().catch(e => { console.error(e); process.exit(1); });
