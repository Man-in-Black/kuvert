/**
 * Ortssuche für Termine über die Google Places API (New): Autovervollständigung
 * (auch Unternehmen und Sehenswürdigkeiten) und Auflösen zur vollständigen Adresse.
 * Benötigt einen API-Schlüssel (Admin → Dienste → Google bzw. GOOGLE_PLACES_API_KEY).
 *
 * Kosten: Autocomplete-Anfragen mit Session-Token sind kostenlos, wenn die Sitzung mit
 * einem Place-Details-Aufruf endet. Dieser fragt nur `formattedAddress` ab (Essentials-SKU).
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

export function placesAvailable(): boolean {
  return !!config.google.placesApiKey;
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
