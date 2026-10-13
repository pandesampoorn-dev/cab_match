import { Driver, Rider, Ride } from '../models/index.js';

export async function getLiveSnapshot() {
  const [drivers, riders, rides] = await Promise.all([
    Driver.findAll(),
    Rider.findAll(),
    Ride.findAll({ order: [['updated_at', 'DESC']], limit: 30 }),
  ]);

  const activeRides = rides.filter((r) =>
    ['searching', 'offered', 'accepted', 'arrived', 'on_trip', 'no_driver'].includes(r.status)
  );

  return {
    at: Date.now(),
    drivers: drivers
      .filter((d) => d.online || d.status === 'on_job')
      .map((d) => ({
        id: d.id,
        name: d.name,
        online: d.online,
        status: d.status,
        lat: d.lat,
        lng: d.lng,
        vehicle: d.vehicle,
      })),
    offlineDrivers: drivers
      .filter((d) => !d.online && d.status !== 'on_job')
      .map((d) => ({
        id: d.id,
        name: d.name,
        online: false,
        status: 'offline',
      })),
    riders: riders.map((r) => ({
      id: r.id,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
    })),
    rides: rides.map((r) => ({
      id: r.id,
      riderId: r.rider_id,
      driverId: r.driver_id,
      status: r.status,
      origin: { lat: r.pickup_lat, lng: r.pickup_lng },
      destination: { lat: r.drop_lat, lng: r.drop_lng },
      fare: r.fare,
      distanceKm: r.distance_km,
      etaMin: r.eta_min,
      timeline: r.timeline,
      createdAt: r.created_at,
    })),
    stats: {
      free: drivers.filter((d) => d.status === 'available').length,
      busy: drivers.filter((d) => d.status === 'on_job').length,
      waiting: activeRides.filter((r) => ['searching', 'offered', 'no_driver'].includes(r.status)).length,
      completed: rides.filter((r) => r.status === 'completed').length,
    },
  };
}

export function setupOpsSocket(io) {
  const opsNs = io.of('/ops');
  opsNs.on('connection', async (socket) => {
    socket.emit('snapshot', await getLiveSnapshot());
  });
}
