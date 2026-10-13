import { Rider } from '../models/index.js';
import { SupplyService } from '../services/supply.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { RoutingService } from '../services/routing.service.js';
import { isLatLng, parseLatLng } from '../geo.js';

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

    // Re-sync on connect
    const activeRide = await DispatchService.getActiveRideOfRider(r.id);
    socket.emit('sync', {
      rider: { id: r.id, name: r.name },
      ride: activeRide ? DispatchService.formatRideForRider(activeRide) : null,
    });

    socket.on(
      'location',
      handle(async (pos) => {
        if (!isLatLng(pos)) throw new Error('Invalid coordinates');
        await Rider.update({ lat: pos.lat, lng: pos.lng }, { where: { id: r.id } });
        return { ok: true };
      })
    );

    socket.on(
      'nearby',
      handle(async (pos) => {
        if (!isLatLng(pos)) throw new Error('Invalid coordinates');
        const drivers = await SupplyService.findAvailableDriversInRings(pos);
        return { drivers };
      })
    );

    socket.on(
      'quote',
      handle(async ({ pickup, drop }) => {
        if (!isLatLng(pickup) || !isLatLng(drop)) throw new Error('Valid pickup and drop required');
        return await RoutingService.getQuote(pickup, drop);
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
