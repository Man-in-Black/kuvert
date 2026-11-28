/**
 * Ortssuche für Termine: Autovervollständigung für das Feld „Ort“ (auch Unternehmen und
 * Sehenswürdigkeiten). Zwei Anbieter:
 *
 * - **Google Places API (New)**, sobald ein API-Schlüssel hinterlegt ist (Admin → Dienste →
 *   Google bzw. GOOGLE_PLACES_API_KEY). Vorschläge werden beim Auswählen zur vollständigen
 *   Adresse aufgelöst (Place Details).
 * - **OpenStreetMap über Photon** als kostenloser Ersatz ohne Schlüssel (Admin → Dienste →
 *   Ortssuche bzw. PLACES_OSM_ENABLED/PHOTON_URL). Photon liefert die Adresse gleich mit.
 *
 * Google-Kosten (Session-Abrechnung): Endet die Sitzung mit einem Place-Details-Aufruf mit demselben
 * Token, werden nur die ersten 12 Autocomplete-Anfragen berechnet, der Details-Aufruf fragt nur
 * `formattedAddress` ab (Essentials-SKU; `displayName` wäre Pro und würde die Sitzung auf die
 * Enterprise-+-Atmosphere-SKU heben). Abgebrochene Sitzungen werden je Anfrage abgerechnet.
 * Ein Token darf nach dem Details-Aufruf nicht wiederverwendet werden (Frontend erzeugt neu).
 *
 * Attribution: Google-Vorschläge ohne Karte brauchen „Google Maps“ (unübersetzt),
 * OSM-Daten „© OpenStreetMap“ (ODbL). Das Frontend zeigt sie je nach `source`.
 */
import type { PlaceDetails, PlaceSuggestion } from '@kuvert/shared';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { apiJson } from './http.js';

const BASE = 'https://places.googleapis.com/v1';

interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId: string;
      text?: { text: string };
      structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
      types?: string[];
    };
  }[];
}

type Provider = 'google' | 'osm';

/** Google hat Vorrang, OSM springt ein, wenn kein Schlüssel hinterlegt ist */
function provider(): Provider | null {
  if (config.google.placesApiKey) return 'google';
  if (config.places.osmEnabled && config.places.photonUrl) return 'osm';
  return null;
}

export function placesAvailable(): boolean {
  return provider() !== null;
}

function key(): string {
  const k = config.google.placesApiKey;
  if (!k) throw new AppError(404, 'places_unavailable', 'Die Ortssuche ist nicht eingerichtet (Google-Places-API-Schlüssel fehlt)');
  return k;
}

/** Google-Fehler (auch 401/403 bei ungültigem Schlüssel) nicht als Sitzungsfehler weiterreichen */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.code === 'places_unavailable') throw err;
    throw new AppError(502, 'places_error', `Google-Ortssuche: ${(err as Error).message}`);
  }
}

const ADDRESS_TYPES = new Set(['street_address', 'premise', 'subpremise', 'route', 'postal_code', 'locality', 'political', 'geocode']);

export async function autocompletePlaces(input: string, sessionToken: string | undefined, language = 'de'): Promise<PlaceSuggestion[]> {
  const p = provider();
  if (p === 'osm') return photonSearch(input, language);
  if (!p) throw new AppError(404, 'places_unavailable', 'Die Ortssuche ist nicht eingerichtet');
  return googleAutocomplete(input, sessionToken, language);
}

async function googleAutocomplete(input: string, sessionToken: string | undefined, language: string): Promise<PlaceSuggestion[]> {
  const res = await call(() =>
    apiJson<AutocompleteResponse>(`${BASE}/places:autocomplete`, {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': key() },
      body: { input, languageCode: language, sessionToken, includeQueryPredictions: false },
      retries: 1,
      timeoutMs: 8000,
      noAuthError: true,
    }),
  );
  const out: PlaceSuggestion[] = [];
  for (const s of res.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    const main = p.structuredFormat?.mainText?.text ?? p.text?.text ?? '';
    if (!main) continue;
    const types = p.types ?? [];
    out.push({
      placeId: p.placeId,
      main,
      secondary: p.structuredFormat?.secondaryText?.text,
      poi: types.includes('establishment') || types.includes('point_of_interest') || !types.some((t) => ADDRESS_TYPES.has(t)),
      source: 'google',
    });
  }
  return out;
}

/** Vollständige Adresse holen und den Text für das Feld „Ort“ bilden (Name + Adresse bei POIs) */
export async function placeDetails(placeId: string, name: string | undefined, sessionToken: string | undefined, language = 'de'): Promise<PlaceDetails> {
  const res = await call(() =>
    apiJson<{ formattedAddress?: string }>(`${BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'formattedAddress' },
      query: { languageCode: language, sessionToken },
      retries: 1,
      timeoutMs: 8000,
      noAuthError: true,
    }),
  );
  const address = res.formattedAddress?.trim();
  const n = name?.trim();
  let location = address || n || '';
  if (n && address && !address.toLowerCase().startsWith(n.toLowerCase())) location = `${n}, ${address}`;
  return { placeId, location, address };
}

/* ───────────────────────────── OpenStreetMap (Photon) ───────────────────────────── */

interface PhotonFeature {
  properties?: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
  };
}

/** Kurzzeit-Cache, damit wiederholte Eingaben den öffentlichen Photon-Server nicht erneut belasten */
const photonCache = new Map<string, { at: number; data: PlaceSuggestion[] }>();
const PHOTON_TTL = 10 * 60_000;
/** Photon kennt nur wenige Sprachen, alles andere führt zu einem Fehler */
const PHOTON_LANGS = new Set(['de', 'en', 'fr']);
/** OSM-Schlüssel, die für Orte/Straßen/Gebiete statt für Unternehmen o. Ä. stehen */
const NON_POI_KEYS = new Set(['place', 'highway', 'boundary', 'landuse', 'natural', 'waterway']);

/** Vorschlag aus einem Photon-Treffer: Name/erste Zeile, Rest der Adresse und fertiger Ortstext */
export function photonSuggestion(f: PhotonFeature): PlaceSuggestion | null {
  const p = f.properties;
  if (!p) return null;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const poi = !!p.name && !NON_POI_KEYS.has(p.osm_key ?? '') && p.type !== 'street';
  // Bei Orten (z. B. Stadt „Neu-Ulm“) nicht doppelt nennen, bei gleichnamigen POIs (Rathaus) schon
  const city = p.city && (poi || p.city !== p.name) ? p.city : undefined;
  const cityLine = [p.postcode, city].filter(Boolean).join(' ');
  let main: string;
  let rest: (string | undefined)[];
  if (poi) {
    main = p.name!;
    rest = [street, cityLine, p.country];
  } else if (street && p.type === 'house') {
    main = street;
    rest = [cityLine, p.country];
  } else {
    main = p.name || street || cityLine;
    rest = [cityLine, p.type === 'street' ? undefined : p.state, p.country];
  }
  if (!main) return null;
  const parts = [...new Set(rest.map((r) => r?.trim()).filter((r): r is string => !!r && r !== main))];
  return {
    placeId: `osm:${p.osm_type ?? ''}${p.osm_id ?? ''}`,
    main,
    secondary: parts.join(', ') || undefined,
    poi,
    source: 'osm',
    location: [main, ...parts].join(', '),
  };
}

async function photonSearch(input: string, language: string): Promise<PlaceSuggestion[]> {
  const lang = PHOTON_LANGS.has(language.slice(0, 2)) ? language.slice(0, 2) : 'default';
  const cacheKey = `${lang}|${input.toLowerCase()}`;
  const hit = photonCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTON_TTL) return hit.data;

  let res: { features?: PhotonFeature[] };
  try {
    res = await apiJson<{ features?: PhotonFeature[] }>(`${config.places.photonUrl}/api/`, {
      query: { q: input, lang, limit: 8 },
      headers: { 'User-Agent': `Kuvert/${config.version} (Ortssuche im Kalender)` },
      retries: 1,
      timeoutMs: 8000,
      noAuthError: true,
    });
  } catch (err) {
    throw new AppError(502, 'places_error', `OpenStreetMap-Ortssuche: ${(err as Error).message}`);
  }

  const seen = new Set<string>();
  const data: PlaceSuggestion[] = [];
  for (const f of res.features ?? []) {
    const s = photonSuggestion(f);
    if (!s || seen.has(s.location!)) continue;
    seen.add(s.location!);
    data.push(s);
  }
  if (photonCache.size >= 500) photonCache.delete(photonCache.keys().next().value!);
  photonCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
