/* Airport codes, for templates that quote one.
 *
 * A purchase order names a delivery point in words — "AEROPUERTO INTERNACIONAL
 * CIUDAD DE MEXICO" — while a trucker's template wants "MEX". Reading the code
 * off the address is a lookup, not a guess, and this file is the lookup table.
 *
 * Two rules keep it honest:
 *
 *   1. A code already printed on the PO always wins. Nothing is derived when
 *      the document already says it.
 *   2. Where a city has more than one airport, nothing is chosen. The caller is
 *      told the alternatives and a person picks. Silently sending wine to
 *      Gatwick because the address said "London" is exactly the failure this
 *      table exists to prevent.
 *
 * Every result reports where it came from, so a derived code can be shown as
 * derived and never passed off as printed.
 *
 * Extends the global `AMI` namespace.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});

  /**
   * `names` are fragments of the airport's own name as it appears on paperwork;
   * `city` is the settlement it serves. A city listed against more than one
   * airport is ambiguous by construction — no tie-break is attempted.
   */
  const AIRPORTS = [
    // — Europe —
    { code: 'CDG', city: 'Paris', country: 'FR', names: ['charles de gaulle', 'roissy'] },
    { code: 'ORY', city: 'Paris', country: 'FR', names: ['orly'] },
    { code: 'LHR', city: 'London', country: 'GB', names: ['heathrow'] },
    { code: 'LGW', city: 'London', country: 'GB', names: ['gatwick'] },
    { code: 'STN', city: 'London', country: 'GB', names: ['stansted'] },
    { code: 'LTN', city: 'London', country: 'GB', names: ['luton'] },
    { code: 'LCY', city: 'London', country: 'GB', names: ['london city airport'] },
    { code: 'AMS', city: 'Amsterdam', country: 'NL', names: ['schiphol'] },
    { code: 'FRA', city: 'Frankfurt', country: 'DE', names: ['frankfurt am main', 'rhein-main'] },
    { code: 'MUC', city: 'Munich', country: 'DE', names: ['munich', 'münchen', 'franz josef strauss'] },
    { code: 'BER', city: 'Berlin', country: 'DE', names: ['brandenburg', 'berlin brandenburg'] },
    { code: 'DUS', city: 'Dusseldorf', country: 'DE', names: ['düsseldorf', 'dusseldorf'] },
    { code: 'MAD', city: 'Madrid', country: 'ES', names: ['barajas', 'adolfo suárez', 'adolfo suarez'] },
    { code: 'BCN', city: 'Barcelona', country: 'ES', names: ['el prat', 'josep tarradellas'] },
    { code: 'LIS', city: 'Lisbon', country: 'PT', names: ['humberto delgado', 'portela', 'lisboa'] },
    { code: 'OPO', city: 'Porto', country: 'PT', names: ['francisco sá carneiro', 'francisco sa carneiro'] },
    { code: 'FCO', city: 'Rome', country: 'IT', names: ['fiumicino', 'leonardo da vinci'] },
    { code: 'CIA', city: 'Rome', country: 'IT', names: ['ciampino'] },
    { code: 'MXP', city: 'Milan', country: 'IT', names: ['malpensa'] },
    { code: 'LIN', city: 'Milan', country: 'IT', names: ['linate'] },
    { code: 'VCE', city: 'Venice', country: 'IT', names: ['marco polo'] },
    { code: 'ZRH', city: 'Zurich', country: 'CH', names: ['zurich', 'zürich', 'kloten'] },
    { code: 'GVA', city: 'Geneva', country: 'CH', names: ['geneva', 'genève', 'cointrin'] },
    { code: 'VIE', city: 'Vienna', country: 'AT', names: ['schwechat', 'wien'] },
    { code: 'BRU', city: 'Brussels', country: 'BE', names: ['zaventem', 'brussels airport'] },
    { code: 'CPH', city: 'Copenhagen', country: 'DK', names: ['kastrup', 'københavn'] },
    { code: 'ARN', city: 'Stockholm', country: 'SE', names: ['arlanda'] },
    { code: 'OSL', city: 'Oslo', country: 'NO', names: ['gardermoen'] },
    { code: 'HEL', city: 'Helsinki', country: 'FI', names: ['vantaa'] },
    { code: 'DUB', city: 'Dublin', country: 'IE', names: ['dublin airport'] },
    { code: 'IST', city: 'Istanbul', country: 'TR', names: ['istanbul airport'] },
    { code: 'SAW', city: 'Istanbul', country: 'TR', names: ['sabiha gökçen', 'sabiha gokcen'] },
    { code: 'ATH', city: 'Athens', country: 'GR', names: ['eleftherios venizelos'] },
    { code: 'WAW', city: 'Warsaw', country: 'PL', names: ['chopin'] },
    { code: 'PRG', city: 'Prague', country: 'CZ', names: ['václav havel', 'vaclav havel', 'ruzyně'] },

    // — North America —
    { code: 'JFK', city: 'New York', country: 'US', names: ['john f kennedy', 'john f. kennedy', 'kennedy international'] },
    { code: 'EWR', city: 'New York', country: 'US', names: ['newark'] },
    { code: 'LGA', city: 'New York', country: 'US', names: ['laguardia', 'la guardia'] },
    { code: 'ATL', city: 'Atlanta', country: 'US', names: ['hartsfield'] },
    { code: 'ORD', city: 'Chicago', country: 'US', names: ["o'hare", 'ohare'] },
    { code: 'MDW', city: 'Chicago', country: 'US', names: ['midway'] },
    { code: 'LAX', city: 'Los Angeles', country: 'US', names: ['los angeles international'] },
    { code: 'SFO', city: 'San Francisco', country: 'US', names: ['san francisco international'] },
    { code: 'MIA', city: 'Miami', country: 'US', names: ['miami international'] },
    { code: 'DFW', city: 'Dallas', country: 'US', names: ['dallas/fort worth', 'dallas fort worth'] },
    { code: 'IAH', city: 'Houston', country: 'US', names: ['george bush intercontinental'] },
    { code: 'HOU', city: 'Houston', country: 'US', names: ['william p hobby', 'hobby airport'] },
    { code: 'IAD', city: 'Washington', country: 'US', names: ['dulles'] },
    { code: 'DCA', city: 'Washington', country: 'US', names: ['reagan national', 'ronald reagan'] },
    { code: 'BOS', city: 'Boston', country: 'US', names: ['logan'] },
    { code: 'SEA', city: 'Seattle', country: 'US', names: ['seattle-tacoma', 'seattle tacoma', 'sea-tac'] },
    { code: 'DEN', city: 'Denver', country: 'US', names: ['denver international'] },
    { code: 'PHX', city: 'Phoenix', country: 'US', names: ['sky harbor'] },
    { code: 'MSP', city: 'Minneapolis', country: 'US', names: ['minneapolis-saint paul', 'minneapolis st paul'] },
    { code: 'DTW', city: 'Detroit', country: 'US', names: ['detroit metropolitan', 'wayne county'] },
    { code: 'CLT', city: 'Charlotte', country: 'US', names: ['charlotte douglas'] },
    { code: 'PHL', city: 'Philadelphia', country: 'US', names: ['philadelphia international'] },
    { code: 'SLC', city: 'Salt Lake City', country: 'US', names: ['salt lake city international'] },
    { code: 'MEX', city: 'Mexico City', country: 'MX', names: ['benito juárez', 'benito juarez', 'aeropuerto internacional ciudad de mexico', 'aeropuerto internacional de la ciudad de méxico', 'aicm'] },
    { code: 'NLU', city: 'Mexico City', country: 'MX', names: ['felipe ángeles', 'felipe angeles', 'aifa'] },
    { code: 'GDL', city: 'Guadalajara', country: 'MX', names: ['miguel hidalgo'] },
    { code: 'MTY', city: 'Monterrey', country: 'MX', names: ['mariano escobedo'] },
    { code: 'CUN', city: 'Cancun', country: 'MX', names: ['cancún', 'cancun'] },
    { code: 'YYZ', city: 'Toronto', country: 'CA', names: ['pearson'] },
    { code: 'YUL', city: 'Montreal', country: 'CA', names: ['trudeau', 'dorval'] },
    { code: 'YVR', city: 'Vancouver', country: 'CA', names: ['vancouver international'] },

    // — Rest of world —
    { code: 'DXB', city: 'Dubai', country: 'AE', names: ['dubai international'] },
    { code: 'DWC', city: 'Dubai', country: 'AE', names: ['al maktoum'] },
    { code: 'AUH', city: 'Abu Dhabi', country: 'AE', names: ['zayed international', 'abu dhabi international'] },
    { code: 'DOH', city: 'Doha', country: 'QA', names: ['hamad international'] },
    { code: 'SIN', city: 'Singapore', country: 'SG', names: ['changi'] },
    { code: 'HKG', city: 'Hong Kong', country: 'HK', names: ['chek lap kok', 'hong kong international'] },
    { code: 'NRT', city: 'Tokyo', country: 'JP', names: ['narita'] },
    { code: 'HND', city: 'Tokyo', country: 'JP', names: ['haneda'] },
    { code: 'KIX', city: 'Osaka', country: 'JP', names: ['kansai'] },
    { code: 'ITM', city: 'Osaka', country: 'JP', names: ['itami'] },
    { code: 'ICN', city: 'Seoul', country: 'KR', names: ['incheon'] },
    { code: 'GMP', city: 'Seoul', country: 'KR', names: ['gimpo', 'kimpo'] },
    { code: 'PVG', city: 'Shanghai', country: 'CN', names: ['pudong'] },
    { code: 'SHA', city: 'Shanghai', country: 'CN', names: ['hongqiao'] },
    { code: 'PEK', city: 'Beijing', country: 'CN', names: ['beijing capital'] },
    { code: 'PKX', city: 'Beijing', country: 'CN', names: ['daxing'] },
    { code: 'BKK', city: 'Bangkok', country: 'TH', names: ['suvarnabhumi'] },
    { code: 'DMK', city: 'Bangkok', country: 'TH', names: ['don mueang', 'don muang'] },
    { code: 'DEL', city: 'Delhi', country: 'IN', names: ['indira gandhi'] },
    { code: 'BOM', city: 'Mumbai', country: 'IN', names: ['chhatrapati shivaji'] },
    { code: 'SYD', city: 'Sydney', country: 'AU', names: ['kingsford smith'] },
    { code: 'MEL', city: 'Melbourne', country: 'AU', names: ['tullamarine'] },
    { code: 'AKL', city: 'Auckland', country: 'NZ', names: ['auckland airport'] },
    { code: 'GRU', city: 'Sao Paulo', country: 'BR', names: ['guarulhos', 'são paulo/guarulhos'] },
    { code: 'CGH', city: 'Sao Paulo', country: 'BR', names: ['congonhas'] },
    { code: 'GIG', city: 'Rio de Janeiro', country: 'BR', names: ['galeão', 'galeao', 'tom jobim'] },
    { code: 'EZE', city: 'Buenos Aires', country: 'AR', names: ['ezeiza', 'ministro pistarini'] },
    { code: 'AEP', city: 'Buenos Aires', country: 'AR', names: ['aeroparque', 'jorge newbery'] },
    { code: 'SCL', city: 'Santiago', country: 'CL', names: ['arturo merino benítez', 'arturo merino benitez'] },
    { code: 'BOG', city: 'Bogota', country: 'CO', names: ['el dorado'] },
    { code: 'LIM', city: 'Lima', country: 'PE', names: ['jorge chávez', 'jorge chavez'] },
    { code: 'PTY', city: 'Panama City', country: 'PA', names: ['tocumen'] },
    { code: 'JNB', city: 'Johannesburg', country: 'ZA', names: ['o r tambo', 'oliver tambo', 'o.r. tambo'] },
    { code: 'CPT', city: 'Cape Town', country: 'ZA', names: ['cape town international'] },
    { code: 'CAI', city: 'Cairo', country: 'EG', names: ['cairo international'] },
    { code: 'TLV', city: 'Tel Aviv', country: 'IL', names: ['ben gurion'] },
  ];

  const byCode = new Map(AIRPORTS.map((a) => [a.code, a]));

  /* Cities served by more than one airport in the table above. */
  const cityIndex = (() => {
    const m = new Map();
    for (const a of AIRPORTS) {
      const key = a.city.toLowerCase();
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(a);
    }
    return m;
  })();

  const flatten = (address) => (Array.isArray(address) ? address.join(' ') : String(address || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  /**
   * Words that look like an IATA code but are ordinary English or shipping
   * shorthand. Without this "THE", "AIR" and "EUR" all read as airports.
   */
  const NOT_CODES = new Set([
    'THE', 'AND', 'FOR', 'AIR', 'EUR', 'USD', 'GBP', 'VAT', 'CIF', 'FOB', 'EXW',
    'DDP', 'DAP', 'ETA', 'ETD', 'PDF', 'INC', 'LLC', 'LTD', 'SAS', 'GMB', 'BOX',
    'STE', 'AVE', 'RUE', 'VIA', 'KGS', 'PCS', 'NET', 'TEL', 'FAX', 'ATT', 'REF',
    'COL', 'CON', 'DEL', 'LOS', 'LAS', 'SAN', 'NEW', 'ONE', 'TWO', 'SIX', 'TEN',
  ]);

  /**
   * Find the airport for a delivery address.
   *
   * Returns `{ code, source, reason, choices }`. `source` is one of:
   *   'printed'   — a code already in the address; nothing was derived
   *   'name'      — the address names the airport
   *   'city'      — the address names a city with exactly one airport
   *   ''          — nothing found, or the city has several and none was chosen
   *
   * When several airports are possible, `code` is empty and `choices` lists
   * them. The caller must ask; this function will not pick.
   */
  function airportForAddress(address) {
    const text = flatten(address);
    if (!text) return { code: '', source: '', reason: 'no delivery address to read', choices: [] };
    const folded = fold(text);

    // 1. A code already on the document beats anything derived from it.
    for (const raw of text.toUpperCase().match(/\b[A-Z]{3}\b/g) || []) {
      if (NOT_CODES.has(raw) || !byCode.has(raw)) continue;
      const a = byCode.get(raw);
      return {
        code: a.code, source: 'printed', airport: a, choices: [],
        reason: 'the address already carries the code ' + a.code,
      };
    }

    // 2. The airport named in words.
    const named = [];
    for (const a of AIRPORTS) {
      if (a.names.some((n) => folded.includes(fold(n)))) named.push(a);
    }
    if (named.length === 1) {
      return {
        code: named[0].code, source: 'name', airport: named[0], choices: [],
        reason: 'the address names ' + named[0].city + ' ' + named[0].code,
      };
    }
    if (named.length > 1) {
      return {
        code: '', source: '', airport: null, choices: named,
        reason: 'the address matches more than one airport (' + named.map((a) => a.code).join(', ') + ')',
      };
    }

    // 3. The city, but only where the city means one airport.
    const hits = [];
    for (const [city, list] of cityIndex) {
      // Word-boundary match, so "Cork" never matches inside another word.
      const re = new RegExp('(^|[^a-z])' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)');
      if (re.test(folded)) hits.push(...list);
    }
    if (hits.length === 1) {
      return {
        code: hits[0].code, source: 'city', airport: hits[0], choices: [],
        reason: 'the address is in ' + hits[0].city + ', served by ' + hits[0].code,
      };
    }
    if (hits.length > 1) {
      const city = hits[0].city;
      return {
        code: '', source: '', airport: null, choices: hits,
        reason: city + ' has ' + hits.length + ' airports (' + hits.map((a) => a.code).join(', ')
          + ') — the address does not say which',
      };
    }

    return {
      code: '', source: '', airport: null, choices: [],
      reason: 'no airport in the table matches this address',
    };
  }

  const airportByCode = (code) => byCode.get(String(code || '').trim().toUpperCase()) || null;

  const airportLabel = (a) => (a ? a.code + ' — ' + (a.names[0] || a.city) + ', ' + a.city : '');

  Object.assign(AMI, {
    AIRPORTS, airportForAddress, airportByCode, airportLabel,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
