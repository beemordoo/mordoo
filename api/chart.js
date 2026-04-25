// /api/chart.js — standalone natal chart endpoint
// Called independently from the frontend so it never blocks the reading

// ── Planet engine (shared logic from chat.js) ──────────────────────────────

const JPL_PLANETS = {
  Sun:'10', Moon:'301', Mercury:'199', Venus:'299',
  Mars:'499', Jupiter:'599', Saturn:'699'
};

const ZODIAC_SIGNS = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'
];

const PLANET_DIGNITY = {
  Sun:     { own:['Leo'],                  exalted:['Aries'],      debilitated:['Libra'] },
  Moon:    { own:['Cancer'],               exalted:['Taurus'],     debilitated:['Scorpio'] },
  Mercury: { own:['Gemini','Virgo'],       exalted:['Virgo'],      debilitated:['Pisces'] },
  Venus:   { own:['Taurus','Libra'],       exalted:['Pisces'],     debilitated:['Virgo'] },
  Mars:    { own:['Aries','Scorpio'],      exalted:['Capricorn'],  debilitated:['Cancer'] },
  Jupiter: { own:['Sagittarius','Pisces'], exalted:['Cancer'],     debilitated:['Capricorn'] },
  Saturn:  { own:['Capricorn','Aquarius'], exalted:['Libra'],      debilitated:['Aries'] },
};

const SIGN_MEANINGS = {
  Sun:     { Aries:'pioneering vitality',Taurus:'determined and material',Gemini:'communicative and dual',Cancer:'protective and intuitive',Leo:'at full brightness — natural authority',Virgo:'analytical and precise',Libra:'softened — balance over dominance',Scorpio:'intense and private',Sagittarius:'expansive and visionary',Capricorn:'disciplined and ambitious',Aquarius:'independent and collective',Pisces:'compassionate and spiritually rich' },
  Moon:    { Aries:'reactive and direct emotions',Taurus:'stable and grounded — exalted',Gemini:'curious and changeable',Cancer:'deeply nurturing — at home',Leo:'warm and generous',Virgo:'orderly emotional security',Libra:'needs harmony to feel settled',Scorpio:'intense and transformative',Sagittarius:'needs freedom to feel safe',Capricorn:'restrained and achievement-driven',Aquarius:'detached but humanitarian',Pisces:'deeply empathic — boundaries dissolve easily' },
  Mercury: { Aries:'quick and direct',Taurus:'deliberate and reliable',Gemini:'fast and versatile — at home',Cancer:'emotional intelligence',Leo:'speaks with authority',Virgo:'analytical precision — exalted',Libra:'balanced diplomat',Scorpio:'investigative depth',Sagittarius:'big picture thinking',Capricorn:'structured and practical',Aquarius:'innovative and ahead of the conversation',Pisces:'intuitive not logical' },
  Venus:   { Aries:'direct in love',Taurus:'loyal and abundant — at home',Gemini:'charm through wit',Cancer:'nurturing in love',Leo:'generous and dramatic',Virgo:'expressed through service',Libra:'refined partnership — at home',Scorpio:'intense and loyal',Sagittarius:'freedom in love',Capricorn:'commitment and reliability',Aquarius:'unconventional',Pisces:'most compassionate — exalted' },
  Mars:    { Aries:'direct and bold — at home',Taurus:'slow but formidable',Gemini:'quick and verbal',Cancer:'indirect and protective',Leo:'bold and proud',Virgo:'precise and methodical',Libra:'acts through negotiation',Scorpio:'strategic and hidden — at home',Sagittarius:'philosophical warrior',Capricorn:'disciplined ambition — exalted',Aquarius:'fights for collective causes',Pisces:'intuitive action' },
  Jupiter: { Aries:'expansion through initiative',Taurus:'wealth through patience',Gemini:'expansion through knowledge',Cancer:'deep abundance — exalted',Leo:'generous and visible',Virgo:'expansion through service',Libra:'abundance through fairness',Scorpio:'expansion through depth',Sagittarius:'full wisdom — at home',Capricorn:'slow and structured',Aquarius:'collective wisdom',Pisces:'spiritual abundance — at home' },
  Saturn:  { Aries:'patience is the karmic lesson',Taurus:'slow material building',Gemini:'structured communication',Cancer:'emotional discipline',Leo:'earned not assumed leadership',Virgo:'disciplined service',Libra:'fairness fully expressed — exalted',Scorpio:'deep karmic transformation',Sagittarius:'wisdom earned through long journeys',Capricorn:'full discipline — at home',Aquarius:'structured innovation — at home',Pisces:'karmic lessons in boundaries' },
};

function lonToSign(lon) {
  const normalized = ((lon % 360) + 360) % 360;
  return {
    sign: ZODIAC_SIGNS[Math.floor(normalized / 30)],
    degree: Math.floor(normalized % 30),
    longitude: normalized
  };
}

function getDignity(planet, sign) {
  const d = PLANET_DIGNITY[planet];
  if (!d) return '';
  if (d.own && d.own.includes(sign)) return 'own sign';
  if (d.exalted && d.exalted.includes(sign)) return 'exalted';
  if (d.debilitated && d.debilitated.includes(sign)) return 'debilitated';
  return '';
}

function parseJPLLongitude(resultText) {
  try {
    const soeIdx = resultText.indexOf('$$SOE');
    const eoeIdx = resultText.indexOf('$$EOE');
    if (soeIdx === -1 || eoeIdx === -1) return null;
    const beforeSOE = resultText.slice(0, soeIdx);
    const headerLines = beforeSOE.trim().split('\n');
    const headerLine = headerLines[headerLines.length - 1];
    const headers = headerLine.split(',').map(s => s.trim().toLowerCase());
    let lonColIdx = headers.findIndex(h => h.includes('obseclon') || h.includes('eclon'));
    // Fallback: scan data row for first valid longitude (float between 0-360)
    // JPL format has empty cols: "Date, , , ObsEcLon, ObsEcLat"
    const dataSection = resultText.slice(soeIdx + 5, eoeIdx).trim();
    const lines = dataSection.split('\n').filter(l => l.trim());
    if (!lines.length) return null;
    const cols = lines[0].split(',').map(s => s.trim());
    // Try header-detected column first
    if (lonColIdx !== -1) {
      const lon = parseFloat(cols[lonColIdx]);
      if (!isNaN(lon)) return lon;
    }
    // Scan all columns for first value that looks like an ecliptic longitude (0-360)
    for (let i = 1; i < cols.length; i++) {
      const val = parseFloat(cols[i]);
      if (!isNaN(val) && val >= 0 && val <= 360) return val;
    }
    return null;
  } catch(e) { return null; }
}

async function fetchPlanetPosition(jplId, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const stop = new Date(parseInt(y), parseInt(m)-1, parseInt(d)+1);
  const stopStr = stop.getFullYear() + '-' + String(stop.getMonth()+1).padStart(2,'0') + '-' + String(stop.getDate()).padStart(2,'0');

  // Build URL manually — do NOT use URLSearchParams as it encodes single quotes to %27
  // JPL requires literal single quotes around parameter values
  const url = 'https://ssd.jpl.nasa.gov/api/horizons.api' +
    '?format=text' +
    `&COMMAND='${jplId}'` +
    `&EPHEM_TYPE='OBSERVER'` +
    `&CENTER='500@399'` +
    `&START_TIME='${dateStr}'` +
    `&STOP_TIME='${stopStr}'` +
    `&STEP_SIZE='1d'` +
    `&QUANTITIES='31'` +
    `&CSV_FORMAT='YES'`;

  const fetchP = fetch(url).then(r => r.text());
  // 7s timeout per planet — leaves headroom within Vercel's 10s function limit
  const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('JPL timeout')), 9000));
  const text = await Promise.race([fetchP, timeoutP]);
  return parseJPLLongitude(text);
}

async function getBirthChart(dateStr) {
  const planets = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn'];
  const results = {};

  // Fetch in two batches to stay within Vercel's execution window
  // Batch 1: Sun, Moon, Mercury, Venus (most important for Thai reading)
  // Batch 2: Mars, Jupiter, Saturn
  const batch1 = planets.slice(0, 4);
  const batch2 = planets.slice(4);

  const fetchPlanet = async (p, attempt = 1) => {
    try {
      const lon = await fetchPlanetPosition(JPL_PLANETS[p], dateStr);
      if (lon !== null) {
        const { sign, degree } = lonToSign(lon);
        const dignity = getDignity(p, sign);
        const meaning = (SIGN_MEANINGS[p] && SIGN_MEANINGS[p][sign]) || '';
        results[p] = { sign, degree, dignity, meaning };
      } else if (attempt < 2) {
        // Retry once if null returned
        await new Promise(r => setTimeout(r, 500));
        await fetchPlanet(p, attempt + 1);
      }
    } catch(e) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500));
        await fetchPlanet(p, attempt + 1);
      } else {
        console.error(`JPL failed for ${p} after 2 attempts:`, e.message);
      }
    }
  };

  const runBatch = async (batch) => {
    await Promise.allSettled(batch.map(p => fetchPlanet(p)));
  };

  await runBatch(batch1);
  await runBatch(batch2);
  console.log('Planets fetched:', Object.keys(results).join(', ') || 'none');
  return results;
}

function getRahuKetu(dateStr) {
  try {
    const date = new Date(dateStr);
    const j2000 = new Date('2000-01-01');
    const years = (date - j2000) / (1000 * 60 * 60 * 24 * 365.25);
    const rahuLon = ((125.04 - (19.3568 * years)) % 360 + 360) % 360;
    const ketuLon = (rahuLon + 180) % 360;
    return {
      Rahu: { ...lonToSign(rahuLon), meaning: 'Karmic direction — where growth and challenge intersect' },
      Ketu: { ...lonToSign(ketuLon), meaning: 'Karmic release — what the soul is moving away from' }
    };
  } catch(e) { return {}; }
}

// Geocoding
const CITY_COORDS = {
  'philadelphia':{lat:39.9526,lng:-75.1652},'bangkok':{lat:13.7563,lng:100.5018},
  'new york':{lat:40.7128,lng:-74.0060},'los angeles':{lat:34.0522,lng:-118.2437},
  'chicago':{lat:41.8781,lng:-87.6298},'houston':{lat:29.7604,lng:-95.3698},
  'munster':{lat:41.5642,lng:-87.5125},'cairo':{lat:30.0444,lng:31.2357},
  'london':{lat:51.5074,lng:-0.1278},'paris':{lat:48.8566,lng:2.3522},
  'tokyo':{lat:35.6762,lng:139.6503},'singapore':{lat:1.3521,lng:103.8198},
  'dubai':{lat:25.2048,lng:55.2708},'sydney':{lat:-33.8688,lng:151.2093},
  'toronto':{lat:43.6532,lng:-79.3832},'mumbai':{lat:19.0760,lng:72.8777},
  'delhi':{lat:28.7041,lng:77.1025},'beijing':{lat:39.9042,lng:116.4074},
  'seoul':{lat:37.5665,lng:126.9780},'vientiane':{lat:17.9757,lng:102.6331},
  'chiang mai':{lat:18.7883,lng:98.9853},'ho chi minh':{lat:10.8231,lng:106.6297},
  'hanoi':{lat:21.0285,lng:105.8542},'phnom penh':{lat:11.5564,lng:104.9282},
  'kuala lumpur':{lat:3.1390,lng:101.6869},'jakarta':{lat:-6.2088,lng:106.8456},
  'manila':{lat:14.5995,lng:120.9842},'boston':{lat:42.3601,lng:-71.0589},
  'miami':{lat:25.7617,lng:-80.1918},'atlanta':{lat:33.7490,lng:-84.3880},
  'seattle':{lat:47.6062,lng:-122.3321},'denver':{lat:39.7392,lng:-104.9903},
};

async function geocode(birthplace) {
  if (!birthplace) return null;
  const key = birthplace.toLowerCase().trim();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (key.includes(city)) return coords;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(birthplace)}&format=json&limit=1`;
    const r = await Promise.race([
      fetch(url, { headers: { 'User-Agent': 'MorDoo/1.0 (mordoo-sepia.vercel.app)' } }).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    if (r && r.length > 0) return { lat: parseFloat(r[0].lat), lng: parseFloat(r[0].lon) };
  } catch(e) {}
  return null;
}

export const config = { maxDuration: 30 }; // Request extended timeout from Vercel

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { birthday, birthplace } = req.body;
    if (!birthday) return res.status(400).json({ error: 'birthday required' });

    const parts = birthday.replace(/-/g,'/').split('/');
    const mo = parseInt(parts[0]), dy = parseInt(parts[1]), yr = parseInt(parts[2]);
    if (isNaN(mo) || isNaN(dy) || isNaN(yr)) return res.status(400).json({ error: 'invalid date' });

    const jplDate = yr + '-' + String(mo).padStart(2,'0') + '-' + String(dy).padStart(2,'0');

    // Fetch everything in parallel
    const [chart, coords] = await Promise.all([
      getBirthChart(jplDate),
      geocode(birthplace || '')
    ]);
    const rahuKetu = getRahuKetu(jplDate);

    // Calculate Ascendant if birth time and coordinates are available
    let ascendant = null;
    const { birthtime } = req.body;
    if (birthtime && coords) {
      try {
        const tMatch = birthtime.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (tMatch) {
          let hr = parseInt(tMatch[1]);
          const mn = parseInt(tMatch[2]);
          const ap = (tMatch[3]||'').toLowerCase();
          if (ap === 'pm' && hr !== 12) hr += 12;
          if (ap === 'am' && hr === 12) hr = 0;
          // Estimate UTC offset from longitude (rough: 15° per hour)
          // lng is negative for west — utcOffset is negative for west
          // utcHour = localHour - utcOffset → adds hours for west (behind UTC)
          const utcOffset = coords.lng / 15;
          const utcHour = hr - utcOffset + mn/60;
          const [y, m, d] = jplDate.split('-').map(Number);
          const JD = 367*y - Math.floor(7*(y+Math.floor((m+9)/12))/4) +
            Math.floor(275*m/9) + d + 1721013.5 + utcHour/24;
          const T = (JD - 2451545.0) / 36525;
          let GST = 280.46061837 + 360.98564736629*(JD-2451545) + 0.000387933*T*T;
          GST = ((GST % 360) + 360) % 360;
          const lng = coords.lng;
          const LST = ((GST + lng) % 360 + 360) % 360;
          const latRad = coords.lat * Math.PI / 180;
          const lstRad = LST * Math.PI / 180;
          const e = 23.4397 * Math.PI / 180;
          let asc = Math.atan2(Math.cos(lstRad), -(Math.sin(lstRad)*Math.cos(e) + Math.tan(latRad)*Math.sin(e)));
          asc = ((asc * 180 / Math.PI) % 360 + 360) % 360;
          const signs = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
          ascendant = { sign: signs[Math.floor(asc/30)], degree: Math.floor(asc%30) };
        }
      } catch(e) { console.error('Ascendant error:', e.message); }
    }

    return res.status(200).json({
      chart,
      rahuKetu,
      ascendant,
      coords,
      jplDate,
      planetsFound: Object.keys(chart).length
    });

  } catch(err) {
    console.error('Chart API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
