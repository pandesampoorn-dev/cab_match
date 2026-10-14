import { Rider, Driver } from '../models/index.js';
import { env } from '../config/env.js';
import { SupplyService } from '../services/supply.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { RoutingService } from '../services/routing.service.js';
import { isLatLng, parseLatLng, km, minutesAt } from '../geo.js';

const handle = (fn) => async (data, ack) => {
  if (typeof data === 'function') {
    ack = data;
    data = {};
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {}
  }
  try {
    const out = await fn(data || {});
    if (typeof ack === 'function') ack({ ok: true, ...(out || {}) });
  } catch (e) {
    if (typeof ack === 'function') ack({ ok: false, error: e.message });
  }
};

export function setupRiderSocket(io) {
  const riderNs = io.of('/rider');

  riderNs.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const query = socket.handshake.query || {};
      const riderId = auth.riderId || query.riderId;
      const name = auth.name || query.name;
      if (!riderId) return next(new Error('Missing riderId in auth handshake or query params'));

      const cleanName = String(name || '').trim() || `Rider-${riderId.slice(-4)}`;
      const [rider] = await Rider.findOrCreate({
        where: { id: riderId },
        defaults: { id: riderId, name: cleanName },
      });

      socket.data.rider = rider;
      next();
    } catch (e) {
      next(new Error(e.message));
    }
  });

  riderNs.on('connection', async (socket) => {
    const r = socket.data.rider;
    socket.join(`rider:${r.id}`);

    // Re-sync on connect with full ride payload (including searching, offered, and recent no_driver)
    const activeRide = await DispatchService.getActiveRideOfRider(r.id);
    const ridePayload = activeRide
      ? await DispatchService.getFullRidePayload(activeRide)
      : null;

    socket.emit('sync', {
      rider: { id: r.id, name: r.name },
      ride: ridePayload,
    });

    socket.on(
      'location',
      handle(async (pos) => {
        const coords = parseLatLng(pos);
        if (!coords) throw new Error('Invalid coordinates: expected { lat, lng }');
        r.lat = coords.lat;
        r.lng = coords.lng;
        await Rider.update({ lat: coords.lat, lng: coords.lng }, { where: { id: r.id } });
        return { ok: true, lat: coords.lat, lng: coords.lng };
      })
    );

    socket.on(
      'nearby',
      handle(async (pos) => {
        const p = parseLatLng(pos);
        if (!p) throw new Error('Invalid coordinates: expected { lat, lng }');
        let drivers = await SupplyService.findAvailableDriversInRings(p);
        if (drivers.length === 0) {
          const anyOnline = await Driver.findAll({
            where: { online: true, status: 'available' },
            limit: 10,
          });
          drivers = anyOnline.map((dr) => ({
            id: dr.id,
            name: dr.name,
            lat: dr.lat,
            lng: dr.lng,
            heading: dr.heading ?? 0,
            vehicle: dr.vehicle,
          }));
        }
        return { drivers, nearby: drivers };
      })
    );

    socket.on(
      'quote',
      handle(async ({ pickup, drop }) => {
        const p = parseLatLng(pickup);
        const d = parseLatLng(drop);
        if (!p || !d) throw new Error('Valid pickup and drop required');

        const quote = await RoutingService.getQuote(p, d);
        const coords = quote.coords && quote.coords.length > 0
          ? quote.coords
          : [[p.lat, p.lng], [d.lat, d.lng]];

        // Fetch nearby available drivers around pickup location
        let nearby = await SupplyService.findAvailableDriversInRings(p, env.maxRings);

        // Fallback to any online available drivers if ring search is empty
        if (nearby.length === 0) {
          const anyOnline = await Driver.findAll({
            where: { online: true, status: 'available' },
            limit: 10,
          });
          if (anyOnline.length > 0) {
            nearby = anyOnline.map((dr) => ({
              id: dr.id,
              name: dr.name,
              lat: dr.lat,
              lng: dr.lng,
              vehicle: dr.vehicle,
            }));
          }
        }

        // Calculate pickupEtaMin for the closest driver
        let pickupEtaMin = 3;
        if (nearby.length > 0) {
          try {
            const ranked = await RoutingService.rankDriversByEta(nearby, p);
            if (ranked.length > 0 && Number.isFinite(ranked[0].durationMin)) {
              pickupEtaMin = Math.max(1, Math.round(ranked[0].durationMin));
            }
          } catch (_) {
            const dist = km(nearby[0], p);
            pickupEtaMin = Math.max(1, Math.round(minutesAt(dist)));
          }
        } else {
          // Default estimate so app doesn't block booking with "No cars nearby"
          pickupEtaMin = 3;
        }

        return {
          ...quote,
          tripRoute: coords,
          coords,
          route: {
            phase: 'trip',
            coords,
          },
          pickupEtaMin,
          tripMin: Math.round(quote.durationMin),
          nearby,
          drivers: nearby,
        };
      })
    );

    socket.on(
      'ride:request',
      handle(async ({ pickup, drop }) => {
        const p = parseLatLng(pickup);
        const d = parseLatLng(drop);
        if (!p || !d) throw new Error('Valid pickup and drop required');
        const ride = await DispatchService.requestRide(r.id, p, d);
        return { ride: DispatchService.formatRideForRider(ride) };
      })
    );

    socket.on(
      'ride:cancel',
      handle(async () => {
        const activeRide = await DispatchService.getActiveRideOfRider(r.id);
        if (!activeRide) throw new Error('No active ride to cancel');
        if (activeRide.status === 'on_trip') throw new Error('Trip already in progress');
        return await DispatchService.cancelRide(activeRide.id, 'rider_cancelled');
      })
    );
  });
}
