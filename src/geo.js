import * as h3 from 'h3-js';
import { env } from './config/env.js';

export const cellOf = (p, res = env.h3Res) => h3.latLngToCell(p.lat, p.lng, res);
export const km = (a, b) => h3.greatCircleDistance([a.lat, a.lng], [b.lat, b.lng], 'km');
export const minutesAt = (distKm, kmh = env.avgSpeedKmh) => (distKm / kmh) * 60;

export function fareFor(tripKm, tripMin) {
  const { base, perKm, perMin } = env.fare;
  return Math.round(base + perKm * tripKm + perMin * tripMin);
}

// A point roughly `distKm` away in a random direction.
export function randomPointNear(p, minKm, maxKm) {
  const d = minKm + Math.random() * (maxKm - minKm);
  const ang = Math.random() * Math.PI * 2;
  return {
    lat: p.lat + (d / 111) * Math.cos(ang),
    lng: p.lng + (d / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(ang),
  };
}

export function parseLatLng(p) {
  if (!p) return null;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch (_) {
      return null;
    }
  }
  if (typeof p !== 'object') return null;
  const raw = p.pos || p;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return null;
}

export function isLatLng(p) {
  return parseLatLng(p) !== null;
}

// Cumulative-distance path so a position can be interpolated by "km along route".
export function makePath(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + h3.greatCircleDistance(coords[i - 1], coords[i], 'km'));
  }
  return { coords, cum, total: cum[cum.length - 1] || 0 };
}

export function pointAlong(path, alongKm) {
  const { coords, cum, total } = path;
  if (coords.length === 1 || alongKm <= 0) return { lat: coords[0][0], lng: coords[0][1], done: total === 0 };
  if (alongKm >= total) {
    const last = coords[coords.length - 1];
    return { lat: last[0], lng: last[1], done: true };
  }
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < alongKm) i++;
  const seg = cum[i + 1] - cum[i];
  const f = seg > 0 ? (alongKm - cum[i]) / seg : 1;
  const [a0, a1] = coords[i];
  const [b0, b1] = coords[i + 1];
  return { lat: a0 + (b0 - a0) * f, lng: a1 + (b1 - a1) * f, done: false };
}

export { h3 };
