import { Driver } from '../models/index.js';
import { SupplyService } from '../services/supply.service.js';
import { DispatchService, emitToRider } from '../services/dispatch.service.js';
import { isLatLng, parseLatLng } from '../geo.js';

const handle = (fn) => async (data, ack) => {
  if (typeof data === 'function') {
    ack = data;
    data = {};
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) { }
  }
  try {
    const out = await fn(data || {});
    if (typeof ack === 'function') ack({ ok: true, ...(out || {}) });
  } catch (e) {
    if (typeof ack === 'function') ack({ ok: false, error: e.message });
  }
};

export function setupDriverSocket(io) {
  const driverNs = io.of('/driver');

  driverNs.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const query = socket.handshake.query || {};
      const driverId = auth.driverId || query.driverId;
      const name = auth.name || query.name;
      if (!driverId) return next(new Error('Missing driverId in auth handshake or query params'));

      const cleanName = String(name || '').trim() || `Driver-${driverId.slice(-4)}`;
      const [driver] = await Driver.findOrCreate({
        where: { id: driverId },
        defaults: {
          id: driverId,
          name: cleanName,
          status: 'offline',
          online: false,
          vehicle: { make: 'Maruti', model: 'Dzire', color: 'White', plate: 'DL 01 AB 1234' },
        },
      });

      socket.data.driver = driver;
      next();
    } catch (e) {
      next(new Error(e.message));
    }
  });

  driverNs.on('connection', async (socket) => {
    const d = socket.data.driver;
    socket.join(`driver:${d.id}`);

    // Re-sync on connect (with active offer and full ride state)
    const activeRide = await DispatchService.getActiveRideOfDriver(d.id);
    const activeOffer = await DispatchService.getActiveOfferOfDriver(d.id);
    const ridePayload = activeRide
      ? await DispatchService.formatRideForDriver(activeRide, d)
      : null;

    socket.emit('sync', {
      driver: {
        id: d.id,
        name: d.name,
        online: d.online,
        status: d.status,
        lat: d.lat,
        lng: d.lng,
        heading: d.heading || 0,
      },
      ride: ridePayload,
      route: ridePayload ? ridePayload.route : null,
      offer: activeOffer,
    });

    socket.on(
      'online',
      handle(async (pos) => {
        const coords = pos ? parseLatLng(pos) : null;
        const res = await SupplyService.setOnline(d.id, coords);
        d.online = true;
        d.status = 'available';
        return { ok: true, driver: { id: d.id, online: true, status: 'available' }, ...res };
      })
    );

    socket.on(
      'offline',
      handle(async () => {
        const res = await SupplyService.setOffline(d.id);
        d.online = false;
        d.status = 'offline';
        return { ok: true, driver: { id: d.id, online: false, status: 'offline' }, ...res };
      })
    );

    socket.on(
      'location',
      handle(async (pos) => {
        const coords = parseLatLng(pos);
        if (!coords) throw new Error('Invalid coordinates: expected { lat, lng }');
        const heading = pos.heading !== undefined ? Number(pos.heading) : undefined;
        const speed = pos.speed !== undefined ? Number(pos.speed) : undefined;
        const locPayload = { ...coords, heading, speed };

        const res = await SupplyService.updateLocation(d.id, locPayload);
        d.lat = coords.lat;
        d.lng = coords.lng;
        if (res.heading !== undefined) d.heading = res.heading;

        // If driver has an active ride, push live driver location update to tracker & rider
        const activeRide = await DispatchService.getActiveRideOfDriver(d.id);
        if (activeRide) {
          DispatchService.updateDriverLiveLocation(activeRide.id, d.id, locPayload);
          const payload = DispatchService.formatRideForRider(activeRide, d);
          emitToRider(activeRide.rider_id, 'ride', payload);
        }

        return {
          ok: true,
          driverId: d.id,
          lat: coords.lat,
          lng: coords.lng,
          heading: res.heading !== undefined ? res.heading : (d.heading || 0),
          cell: res.cell,
        };
      })
    );

    socket.on(
      'offer:accept',
      handle(async ({ rideId }) => {
        return await DispatchService.acceptOffer(d.id, rideId);
      })
    );

    socket.on(
      'offer:decline',
      handle(async ({ rideId }) => {
        return await DispatchService.declineOffer(d.id, rideId);
      })
    );

    socket.on(
      'ride:arrived',
      handle(async () => {
        return await DispatchService.markArrived(d.id);
      })
    );

    socket.on(
      'ride:start',
      handle(async () => {
        return await DispatchService.startTrip(d.id);
      })
    );

    socket.on(
      'ride:complete',
      handle(async () => {
        return await DispatchService.completeTrip(d.id);
      })
    );

    socket.on(
      'ride:cancel',
      handle(async () => {
        return await DispatchService.cancelRideByDriver(d.id);
      })
    );
  });
}
