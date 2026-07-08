import { NextRequest, NextResponse } from 'next/server';

/**
 * ETF Jaarcheck — beslismatrix
 * Bestandslocatie in het project: app/api/jaarcheck/route.ts
 *
 * Voert Claudia's jaarlijkse kwaliteitscheck per ETF uit op basis van:
 *  - Benchmarkprestatie (trackingdifference, handmatig opgezocht door de klant op trackingdifferences.com)
 *  - Morningstar Analyst Rating (Gold/Silver/Bronze/Neutral/Negative)
 *  - Trend in Morningstar sterren (dalend, 2 jaar op rij = signaal)
 *
 * KRITIEK — zelfde discipline als analyseer.ts: deze beslislogica leeft UITSLUITEND server-side.
 * Nooit deze functie of een kopie ervan teruginzetten in de HTML.
 *
 * Kernregel (nooit wijzigen zonder Claudia's expliciete akkoord):
 * - Analyst Rating Negative => altijd direct wisselen, ongeacht trackrecord.
 * - Onderperformance alleen (1 jaar) is nooit een wisselreden zolang rating Bronze of hoger is.
 * - Wisselen alleen bij: rating Neutral + 2 jaar op rij onderperformance (afwijking >= 1.5%).
 * - Eerste jaar onderperformance + Neutral => monitoren, hercheck na 6 maanden, nog niet wisselen.
 * - Sterren-trend (dalend 2 jaar op rij) is een signaal/waarschuwing, geen zelfstandige wisselreden.
 * - UITZONDERING: MS Sterren <= 2 EN Analyst Rating Neutral => altijd direct wisselen, ongeacht trackingdifference of aantal jaren.
 *   Zelfde combinatie-logica als de hoofdtool's vlaglogica (lage sterren + Neutral = geen vertrouwen meer).
 * - De inlegverdeling/weging wordt NOOIT aangepast op basis van deze check — puur behouden/wisselen per ETF.
 */

const ONDERPERFORMANCE_DREMPEL = 1.5; // % — positieve trackingdifference boven deze drempel telt als "onder benchmark"

type OudETF = {
  id: string;
  isin?: string;
  name?: string;
  weight?: number;
  sector?: string;
  region?: string;
  ter?: number | null;
  div?: string;
  msStars?: string;
  ms?: string;
  // Alleen aanwezig als de oude JSON zelf een Jaarcheck-export was (chaining, jaar 2+):
  consecutiveUnderperformanceYears?: number;
  dalendeSterrenJaren?: number;
  trackingDiff?: number | null;
};

type NieuwETF = {
  id: string;
  isin?: string;
  trackingDiff?: number | null;
  msStars?: string;
  ms?: string;
  ter?: number | null;
  sector?: string;
  region?: string;
  div?: string;
  verwijderd?: boolean;
};

type Payload = {
  vorig: {
    versie?: string;
    datum?: string;
    horizon?: string;
    inleg?: number;
    coreWeight?: number | null;
    etfs: OudETF[];
  };
  nieuw: {
    datum?: string;
    etfs: NieuwETF[];
  };
};

function starCount(s?: string): number {
  return (s || '').length;
}

function isJaarcheckBron(vorig: Payload['vorig']): boolean {
  // Detectie: een Jaarcheck-export heeft 'jaarcheck' in de versie-string.
  // De hoofdtool-export (bootstrap, jaar 1) heeft versie '1.0' en geen trackingDiff-geschiedenis.
  return !!vorig.versie && vorig.versie.startsWith('jaarcheck');
}

function ratingRang(ms?: string): number {
  // Gold/Silver/Bronze zijn allemaal "voldoende" voor de matrix — alleen Neutral en Negative wijken af.
  const orde: Record<string, number> = { Gold: 3, Silver: 3, Bronze: 3, Neutral: 1, Negative: 0 };
  return ms ? (orde[ms] ?? 2) : 2; // onbekende/lege rating: neutraal-achtig behandelen, niet automatisch wisselen
}

function ratingRangVoorRichting(ms?: string): number {
  const orde: Record<string, number> = { Gold: 4, Silver: 3, Bronze: 2, Neutral: 1, Negative: 0 };
  return ms && orde[ms] != null ? orde[ms] : -1; // onbekend/leeg = geen vergelijking mogelijk
}
function bepaalRichting(oudWaarde: number, nieuwWaarde: number): 'beter' | 'slechter' | 'gelijk' | null {
  if (oudWaarde < 0 || nieuwWaarde < 0) return null;
  if (nieuwWaarde > oudWaarde) return 'beter';
  if (nieuwWaarde < oudWaarde) return 'slechter';
  return 'gelijk';
}

function bepaalBeslissing(opts: {
  trackingDiff: number | null;
  msNieuw?: string;
  msStarsNieuw?: string;
  priorConsecutive: number;
}): { beslissing: string; toelichting: string; consecutiveUnderperformanceYears: number; onderBenchmark: boolean } {
  const { trackingDiff, msNieuw, msStarsNieuw, priorConsecutive } = opts;
  const onderBenchmark = trackingDiff != null && trackingDiff > ONDERPERFORMANCE_DREMPEL;
  const consecutiveUnderperformanceYears = onderBenchmark ? priorConsecutive + 1 : 0;
  const sterren = starCount(msStarsNieuw);

  // Kernregel: Negative = altijd direct wisselen, ongeacht trackrecord.
  if (msNieuw === 'Negative') {
    return {
      beslissing: 'wisselen',
      toelichting: 'Analyst Rating is Negative — directe wisselgrond, ongeacht trackrecord of aantal jaren.',
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }

  // Uitzondering: lage sterren (<=2) + Neutral = geen vertrouwen meer, ongeacht trackingdifference/jaren.
  if (msNieuw === 'Neutral' && sterren > 0 && sterren <= 2) {
    return {
      beslissing: 'wisselen',
      toelichting: `Combinatie van lage Morningstar-sterren (${msStarsNieuw}) en Neutral rating — direct wisselen, ongeacht trackrecord.`,
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }

  if (!onderBenchmark) {
    return {
      beslissing: 'behouden',
      toelichting:
        trackingDiff != null
          ? `Presteert boven of rond benchmark (trackingdifference ${trackingDiff.toFixed(2)}%), rating in orde. Geen actie.`
          : 'Geen trackingdifference ingevuld — geen benchmarksignaal, rating in orde. Geen actie.',
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }

  // Vanaf hier: onder benchmark (trackingdifference > 1.5%)
  const ratingVoldoende = ratingRang(msNieuw) >= 3; // Gold/Silver/Bronze
  const ratingNeutral = msNieuw === 'Neutral';

  if (consecutiveUnderperformanceYears === 1) {
    if (ratingVoldoende) {
      return {
        beslissing: 'behouden',
        toelichting: `Eerste jaar onder benchmark (trackingdifference ${trackingDiff!.toFixed(2)}%), rating ${msNieuw} nog voldoende. Noteer en volg volgend jaar — een slecht jaar is normaal.`,
        consecutiveUnderperformanceYears,
        onderBenchmark,
      };
    }
    if (ratingNeutral) {
      return {
        beslissing: 'monitoren',
        toelichting: `Eerste jaar onder benchmark (${trackingDiff!.toFixed(2)}%) + Neutral rating: vroeg signaal. Verhoog monitoring, hercheck over 6 maanden. Nog niet wisselen.`,
        consecutiveUnderperformanceYears,
        onderBenchmark,
      };
    }
    // Geen Analyst Rating beschikbaar (komt vaker voor bij kleinere ETF's, niet elke ETF wordt door Morningstar-analisten gevolgd)
    return {
      beslissing: 'monitoren',
      toelichting: `Eerste jaar onder benchmark (${trackingDiff!.toFixed(2)}%). Geen Analyst Rating beschikbaar voor deze ETF op Morningstar, komt vaker voor bij kleinere ETF's. Beoordeel dit jaar zelf op basis van de sterren en trackrecord.`,
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }

  // consecutiveUnderperformanceYears >= 2: twee (of meer) jaar op rij onder benchmark
  if (ratingVoldoende) {
    return {
      beslissing: 'behouden',
      toelichting: `Twee jaar op rij onder benchmark, maar rating ${msNieuw} blijft solide — Morningstar-analisten beoordelen de structurele kwaliteit. Vertrouw op die check.`,
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }
  if (ratingNeutral) {
    return {
      beslissing: 'wisselen',
      toelichting: `Twee jaar op rij onder benchmark + Neutral rating: combinatie van aanhoudende underperformance en Neutral betekent geen vertrouwen meer. Wissel.`,
      consecutiveUnderperformanceYears,
      onderBenchmark,
    };
  }
  return {
    beslissing: 'monitoren',
    toelichting: `Twee jaar op rij onder benchmark (${trackingDiff!.toFixed(2)}%). Geen Analyst Rating beschikbaar voor deze ETF op Morningstar, komt vaker voor bij kleinere ETF's. Beoordeel dit jaar zelf op basis van de sterren en trackrecord.`,
    consecutiveUnderperformanceYears,
    onderBenchmark,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Payload;
    const vorig = body.vorig;
    const nieuw = body.nieuw;
    const bronIsJaarcheck = isJaarcheckBron(vorig);

    const vorigMap = new Map<string, OudETF>();
    vorig.etfs.forEach(e => {
      const key = (e.isin || e.name || e.id || '').toUpperCase();
      if (key) vorigMap.set(key, e);
    });

    const nieuwMap = new Map<string, NieuwETF>();
    nieuw.etfs.forEach(e => {
      const key = (e.isin || e.id || '').toUpperCase();
      if (key) nieuwMap.set(key, e);
    });

    const resultaten: any[] = [];
    let behouden = 0, monitoren = 0, wisselen = 0, nieuwCount = 0, verwijderd = 0;

    // 1) Alle ETF's die in de oude situatie zaten
    for (const oud of vorig.etfs) {
      const key = (oud.isin || oud.name || oud.id || '').toUpperCase();
      const n = key ? nieuwMap.get(key) : undefined;

      if (!n || n.verwijderd) {
        verwijderd++;
        resultaten.push({
          id: oud.id,
          isin: oud.isin || '',
          name: oud.name || '',
          beslissing: 'verwijderd',
          toelichting: 'Niet meer aanwezig in de nieuwe situatie — uit de portefeuille gehaald sinds de vorige check.',
          sterrenSignaal: null,
          sector: { oud: oud.sector || '', nieuw: null, gewijzigd: false },
          region: { oud: oud.region || '', nieuw: null, gewijzigd: false },
          ter: { oud: oud.ter ?? null, nieuw: null, verschil: null, gewijzigd: false },
          msStars: { oud: oud.msStars || '', nieuw: null, gewijzigd: false },
          ms: { oud: oud.ms || '', nieuw: null, gewijzigd: false },
          trackingDiff: null,
          onderBenchmark: false,
          consecutiveUnderperformanceYears: 0,
          dalendeSterrenJaren: 0,
          sterrenDalend2JaarOpRij: false,
        });
        continue;
      }

      const priorConsecutive = bronIsJaarcheck ? (oud.consecutiveUnderperformanceYears || 0) : 0;
      const priorSterrenDalend = bronIsJaarcheck ? (oud.dalendeSterrenJaren || 0) : 0;

      const trackingDiff = n.trackingDiff != null && !isNaN(n.trackingDiff) ? n.trackingDiff : null;
      const { beslissing, toelichting, consecutiveUnderperformanceYears, onderBenchmark } = bepaalBeslissing({
        trackingDiff,
        msNieuw: n.ms,
        msStarsNieuw: n.msStars,
        priorConsecutive,
      });

      const sterrenGedaald = starCount(n.msStars) > 0 && starCount(oud.msStars) > 0 && starCount(n.msStars) < starCount(oud.msStars);
      const dalendeSterrenJaren = sterrenGedaald ? priorSterrenDalend + 1 : 0;
      const sterrenDalend2JaarOpRij = dalendeSterrenJaren >= 2;

      if (beslissing === 'behouden') behouden++;
      else if (beslissing === 'monitoren') monitoren++;
      else if (beslissing === 'wisselen') wisselen++;

      const terOud = oud.ter ?? null;
      const terNieuw = n.ter ?? terOud; // als niet opnieuw ingevuld: aanname TER ongewijzigd
      const sectorNieuw = n.sector || oud.sector || '';
      const regionNieuw = n.region || oud.region || '';
      const msStarsNieuw = n.msStars || '';
      const msNieuw = n.ms || '';

      resultaten.push({
        id: oud.id,
        isin: oud.isin || '',
        name: oud.name || '',
        beslissing,
        toelichting,
        sterrenSignaal: sterrenDalend2JaarOpRij
          ? `Morningstar-sterren dalen twee jaar op rij (${oud.msStars || '—'} → ${msStarsNieuw || '—'}). Extra aandachtspunt naast de hoofdbeslissing.`
          : null,
        sector: { oud: oud.sector || '', nieuw: sectorNieuw, gewijzigd: (oud.sector || '') !== sectorNieuw },
        region: { oud: oud.region || '', nieuw: regionNieuw, gewijzigd: (oud.region || '') !== regionNieuw },
        ter: {
          oud: terOud,
          nieuw: terNieuw,
          verschil: terOud != null && terNieuw != null ? +(terNieuw - terOud).toFixed(3) : null,
          gewijzigd: terOud != null && terNieuw != null && Math.abs(terNieuw - terOud) > 0.0001,
        },
        msStars: { oud: oud.msStars || '', nieuw: msStarsNieuw, gewijzigd: (oud.msStars || '') !== msStarsNieuw, richting: bepaalRichting(starCount(oud.msStars), starCount(msStarsNieuw)) },
        ms: { oud: oud.ms || '', nieuw: msNieuw, gewijzigd: (oud.ms || '') !== msNieuw, richting: bepaalRichting(ratingRangVoorRichting(oud.ms), ratingRangVoorRichting(msNieuw)) },
        trackingDiff,
        onderBenchmark,
        consecutiveUnderperformanceYears,
        dalendeSterrenJaren,
        sterrenDalend2JaarOpRij,
      });
    }

    // 2) ETF's die nieuw zijn toegevoegd (zaten niet in de oude situatie)
    for (const n of nieuw.etfs) {
      const key = (n.isin || n.id || '').toUpperCase();
      if (n.verwijderd) continue;
      if (key && vorigMap.has(key)) continue; // al hierboven verwerkt
      nieuwCount++;

      const trackingDiff = n.trackingDiff != null && !isNaN(n.trackingDiff) ? n.trackingDiff : null;
      const { beslissing, toelichting, consecutiveUnderperformanceYears, onderBenchmark } = bepaalBeslissing({
        trackingDiff,
        msNieuw: n.ms,
        msStarsNieuw: n.msStars,
        priorConsecutive: 0,
      });

      if (beslissing === 'behouden') behouden++;
      else if (beslissing === 'monitoren') monitoren++;
      else if (beslissing === 'wisselen') wisselen++;

      resultaten.push({
        id: n.id,
        isin: n.isin || '',
        name: n.isin || n.id,
        beslissing,
        toelichting: `Nieuw toegevoegd sinds de vorige check — geen historie. ${toelichting}`,
        sterrenSignaal: null,
        sector: { oud: null, nieuw: n.sector || '', gewijzigd: false },
        region: { oud: null, nieuw: n.region || '', gewijzigd: false },
        ter: { oud: null, nieuw: n.ter ?? null, verschil: null, gewijzigd: false },
        msStars: { oud: null, nieuw: n.msStars || '', gewijzigd: false },
        ms: { oud: null, nieuw: n.ms || '', gewijzigd: false },
        trackingDiff,
        onderBenchmark,
        consecutiveUnderperformanceYears,
        dalendeSterrenJaren: 0,
        sterrenDalend2JaarOpRij: false,
      });
    }

    return NextResponse.json(
      {
        datum: nieuw.datum || new Date().toISOString().slice(0, 10),
        horizon: vorig.horizon || '',
        inleg: vorig.inleg || 0,
        coreWeight: vorig.coreWeight ?? null,
        resultaten,
        samenvatting: {
          totaal: resultaten.length,
          behouden,
          monitoren,
          wisselen,
          nieuw: nieuwCount,
          verwijderd,
        },
      },
      { headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: 'Ongeldige aanvraag' },
      { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
