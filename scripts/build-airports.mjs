// Builds src/data/airports.json from the OurAirports public-domain dataset
// (https://ourairports.com/data/). Usage:
//   node scripts/build-airports.mjs <airports.csv> <countries.csv> src/data/airports.json
// The airport selection, the "major" hub list and the display-city overrides are hand-curated.
import { readFileSync, writeFileSync } from 'node:fs'
const [airportsCsv, countriesCsv, outPath] = process.argv.slice(2)

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [h, ...rest] = rows
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])))
}

const MAJOR = `ATL ORD DFW DEN LAX SFO SEA LAS PHX IAH MCO MIA JFK EWR LGA BOS PHL IAD DCA CLT DTW MSP SLC SAN BNA AUS MSY STL MCI TPA FLL BWI PDX
YYZ YVR YUL YYC MEX CUN GRU BOG LIM SCL EZE PTY LHR CDG AMS FRA MUC MAD BCN FCO IST ZRH LIS DUB CPH VIE
DXB DOH AUH HND NRT ICN PEK PVG HKG SIN BKK SYD MEL DEL BOM JNB TPE KUL`.split(/\s+/)
const OTHER = `MDW DAL HOU RDU IND CMH CLE PIT CVG MKE SAT SJC OAK SMF SNA BUR ONT LGB PSP HNL OGG KOA LIH ANC RSW JAX COS SAV CHS MYR ORF RIC
BDL PVD ALB BUF SYR ROC PWM BTV MHT BOI ABQ TUS ELP OKC TUL OMA DSM MEM SDF BHM GSP GSO CHA TYS LIT ICT SRQ PNS ECP RNO SBA EGE ASE JAC BZN MSN GRR DAY
YOW YEG YHZ YWG
GDL MTY SJD PVR SJU NAS MBJ PUJ SDQ AUA SXM HAV SJO LIR BZE GCM STT
GIG MDE CTG UIO GYE MVD
LGW STN MAN EDI ORY NCE BRU BER HAM DUS GVA PMI AGP OPO MXP VCE NAP ATH ARN OSL HEL KEF PRG WAW BUD SAW OTP LYS DBV SPU MLA TFS SVQ VLC IBZ HER JTR FLR
TLV AMM RUH JED CAI CMN RAK CPT NBO ADD LOS ACC
CEB ZNZ MRU SEZ KIX GMP PKX SHA CAN SZX MNL DMK HKT CGK DPS SGN HAN BLR MAA CCU MLE CMB BNE PER AKL CHC NAN PPT`.split(/\s+/)

const CITY = {ATH:"Athens",BRU:"Brussels",CAN:"Guangzhou",CDG:"Paris",CEB:"Cebu",CVG:"Cincinnati",DPS:"Bali (Denpasar)",EDI:"Edinburgh",EZE:"Buenos Aires",FLR:"Florence",FRA:"Frankfurt",GIG:"Rio de Janeiro",GSP:"Greenville-Spartanburg",HAN:"Hanoi",HEL:"Helsinki",HNL:"Honolulu",IAD:"Washington",IBZ:"Ibiza",JTR:"Santorini",KUL:"Kuala Lumpur",LIH:"Lihue (Kauai)",LYS:"Lyon",MAN:"Manchester",MNL:"Manila",MRU:"Mauritius",MVD:"Montevideo",MXP:"Milan",NAP:"Naples",NCE:"Nice",NRT:"Tokyo",ORY:"Paris",OSL:"Oslo",OTP:"Bucharest",PTY:"Panama City",PVD:"Providence",PVG:"Shanghai",SAW:"Istanbul",SEZ:"Mahé",SHA:"Shanghai",SJO:"San José",STN:"London",SYD:"Sydney",TPE:"Taipei",TYS:"Knoxville",VCE:"Venice",SNA:"Orange County",EGE:"Vail (Eagle)",KOA:"Kona",OGG:"Maui (Kahului)",AUA:"Aruba",RDU:"Raleigh-Durham",SRQ:"Sarasota"}
const countries = Object.fromEntries(parseCsv(readFileSync(countriesCsv, 'utf8')).map((c) => [c.code, c.name]))
const rank = { large_airport: 3, medium_airport: 2, small_airport: 1 }
const byIata = new Map()
for (const a of parseCsv(readFileSync(airportsCsv, 'utf8'))) {
  if (!a.iata_code) continue
  const list = byIata.get(a.iata_code) ?? []; list.push(a); byIata.set(a.iata_code, list)
}
const wanted = [...new Set([...MAJOR, ...OTHER])]
const dupInput = [...MAJOR, ...OTHER].filter((c, i, arr) => arr.indexOf(c) !== i)
const out = [], missing = [], notes = []
for (const code of wanted) {
  const cands = (byIata.get(code) ?? []).filter((a) => a.type !== 'closed')
  if (!cands.length) { missing.push(code); continue }
  cands.sort((x, y) => (y.scheduled_service === 'yes') - (x.scheduled_service === 'yes') || (rank[y.type] ?? 0) - (rank[x.type] ?? 0))
  const a = cands[0]
  if (cands.length > 1) notes.push(`${code}: ${cands.length} rows, picked "${a.name}"`)
  if (a.scheduled_service !== 'yes') notes.push(`${code}: scheduled_service=${a.scheduled_service}`)
  if (a.type !== 'large_airport' && MAJOR.includes(code)) notes.push(`${code}: marked major but type=${a.type}`)
  out.push({
    iata: code, name: a.name, city: CITY[code] ?? a.municipality, country: countries[a.iso_country] ?? a.iso_country,
    countryCode: a.iso_country, lat: Math.round(+a.latitude_deg * 1e4) / 1e4, lon: Math.round(+a.longitude_deg * 1e4) / 1e4,
    major: MAJOR.includes(code),
  })
}
out.sort((a, b) => a.iata.localeCompare(b.iata))
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify({ count: out.length, major: out.filter((a) => a.major).length, missing, dupInput, notes, emptyCity: out.filter((a) => !a.city).map((a) => a.iata) }, null, 1))
