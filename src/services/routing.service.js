import { env } from '../config/env.js';
import { km, minutesAt, fareFor } from '../geo.js';

let osrmDown = false;

async function fetchOsrm(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), env.osrmTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'ride-dispatch/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.code || 'OSRM error');
    if (osrmDown) {
      osrmDown = false;
      console.log('[Routing] OSRM reachable again');
    }
    return json;
  } catch (e) {
    if (!osrmDown) {
      osrmDown = true;
      console.warn(`[Routing] OSRM unreachable (${e.message}), using Haversine straight-line estimates.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const lngLat = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export class RoutingService {
  /**
   * Get driving route between point a and b.
   * Returns { coords: [[lat, lng], ...], distanceKm, durationMin, road: boolean }
   */
  static async getRoute(a, b) {
    try {
      const json = await fetchOsrm(
        `${env.osrmUrl}/route/v1/driving/${lngLat(a)};${lngLat(b)}?overview=full&geometries=geojson`
      );
      const r = json.routes[0];
      return {
        coords: r.geometry.coordinates.map(([x, y]) => [y, x]),
        distanceKm: Math.round((r.distance / 1000) * 100) / 100,
        durationMin: Math.round((r.duration / 60) * 10) / 10,
        road: true,
      };
    } catch (e) {
      const dist = Math.round(km(a, b) * 100) / 100;
      return {
        coords: [[a.lat, a.lng], [b.lat, b.lng]],
        distanceKm: dist,
        durationMin: Math.round(minutesAt(dist) * 10) / 10,
        road: false,
      };
    }
  }

  /**
   * Calculate fare and trip stats for quote.
   */
  static async getQuote(pickup, drop) {
    const route = await this.getRoute(pickup, drop);
    const fare = fareFor(route.distanceKm, route.durationMin);
    return {
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      fare,
      pickup,
      drop,
      road: route.road,
    };
  }

  /**
   * Rank candidate drivers by ETA to destination (pickup).
   * Fastest driver first.
   */
  static async rankDriversByEta(candidateDrivers, pickup) {
    if (!candidateDrivers || candidateDrivers.length === 0) return [];
    try {
      const coords = [...candidateDrivers, pickup].map(lngLat).join(';');
      const json = await fetchOsrm(
        `${env.osrmUrl}/table/v1/driving/${coords}?destinations=${candidateDrivers.length}&annotations=duration,distance`
      );
      return candidateDrivers
        .map((d, i) => ({
          driver: d,
          durationMin: Math.round((json.durations[i][0] / 60) * 10) / 10,
          distanceKm: Math.round((json.distances[i][0] / 1000) * 100) / 100,
          road: true,
        }))
        .filter((x) => Number.isFinite(x.durationMin))
        .sort((a, b) => a.durationMin - b.durationMin);
    } catch (e) {
      return candidateDrivers
        .map((d) => {
          const dist = km(d, pickup);
          return {
            driver: d,
            durationMin: Math.round(minutesAt(dist) * 10) / 10,
            distanceKm: Math.round(dist * 100) / 100,
            road: false,
          };
        })
        .sort((a, b) => a.durationMin - b.durationMin);
    }
  }
}
