import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { Ride, RideOffer, Driver, Rider } from '../models/index.js';
import { SupplyService } from './supply.service.js';
import { RoutingService } from './routing.service.js';
import { dispatchQueue, registerTimeoutHandler } from '../queues/dispatch.queue.js';
import { logger } from '../utils/logger.js';
import { cellOf, h3, bearing, makePath, pointAlong, minutesAt, km } from '../geo.js';

let ioInstance = null;
const activeTrackers = new Map();
const rideRouteCache = new Map();

export function setIo(io) {
  ioInstance = io;
}

export function emitToDriver(driverId, event, payload) {
  if (ioInstance) {
    ioInstance.of('/driver').to(`driver:${driverId}`).emit(event, payload);
  }
}

export function emitToRider(riderId, event, payload) {
  if (ioInstance) {
    const riderRoom = ioInstance.of('/rider').to(`rider:${riderId}`);
    riderRoom.emit(event, payload);

    // Backward-compatibility: support frontend apps expecting 'ride:update' & 'ride:ended'
    if (event === 'ride' && payload) {
      riderRoom.emit('ride:update', payload);

      if (['completed', 'cancelled', 'no_driver'].includes(payload.status)) {
        riderRoom.emit('ride:ended', payload);
      }
    }
  }
}

export function emitRideEnded(ride, reason = null, driver = null) {
  if (!ioInstance || !ride) return;
  const r = ride.toJSON ? ride.toJSON() : ride;
  const driverName = driver?.name || r.driver?.name || 'Driver';
  const endPayload = {
    rideId: r.id,
    id: r.id,
    status: r.status,
    reason: reason || r.status,
    fare: r.fare || 0,
    tripKm: r.distance_km || 0,
    distanceKm: r.distance_km || 0,
    driverName,
    driver: driver
      ? {
          id: driver.id,
          name: driver.name,
          vehicle: driver.vehicle,
        }
      : null,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng },
    pickup_lat: r.pickup_lat,
    pickup_lng: r.pickup_lng,
    drop: { lat: r.drop_lat, lng: r.drop_lng },
    drop_lat: r.drop_lat,
    drop_lng: r.drop_lng,
  };

  const riderRoom = ioInstance.of('/rider').to(`rider:${r.rider_id}`);
  riderRoom.emit('ride:ended', endPayload);
  riderRoom.emit('ride', { ...endPayload, status: r.status });
  riderRoom.emit('ride:update', { ...endPayload, status: r.status });
  activeTrackers.delete(r.id);
}

export function emitToOps(event, payload) {
  if (ioInstance) {
    ioInstance.of('/ops').emit(event, payload);
  }
}

let rideSeq = 1;

export class DispatchService {
  static async getLockedDriverIds() {
    try {
      const activeOffers = await RideOffer.findAll({
        where: { status: 'offered' },
      });
      const locked = new Set();
      activeOffers.forEach((o) => {
        (o.driver_ids || []).forEach((id) => locked.add(id));
      });
      return locked;
    } catch (_) {
      return new Set();
    }
  }

  static async getActiveOfferOfDriver(driverId) {
    try {
      const activeOffers = await RideOffer.findAll({
        where: { status: 'offered' },
        order: [['created_at', 'DESC']],
      });

      const matchedOffer = activeOffers.find((o) => (o.driver_ids || []).includes(driverId));
      if (!matchedOffer) return null;

      const ride = await Ride.findByPk(matchedOffer.ride_id);
      if (!ride || ride.status !== 'offered') return null;

      const rider = await Rider.findByPk(ride.rider_id);
      const elapsed = Date.now() - new Date(matchedOffer.created_at).getTime();
      const timeRemainingMs = Math.max(0, env.offerTimeoutMs - elapsed);
      if (timeRemainingMs <= 0) return null;

      return {
        rideId: ride.id,
        riderId: ride.rider_id,
        riderName: rider ? rider.name : 'Rider',
        pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng },
        pickup_lat: ride.pickup_lat,
        pickup_lng: ride.pickup_lng,
        drop: { lat: ride.drop_lat, lng: ride.drop_lng },
        drop_lat: ride.drop_lat,
        drop_lng: ride.drop_lng,
        distanceKm: ride.distance_km,
        distance_km: ride.distance_km,
        fare: ride.fare,
        tripMin: ride.eta_min || 0,
        etaMin: ride.eta_min || 0,
        timeoutMs: timeRemainingMs,
        expiresAt: Date.now() + timeRemainingMs,
        batchIndex: matchedOffer.batch_index,
      };
    } catch (_) {
      return null;
    }
  }

  static async requestRide(riderId, pickup, drop) {
    const rideId = `ride_${Date.now()}_${rideSeq++}`;
    const quote = await RoutingService.getQuote(pickup, drop);
    const coords = quote.coords && quote.coords.length > 0
      ? quote.coords
      : [[pickup.lat, pickup.lng], [drop.lat, drop.lng]];

    rideRouteCache.set(rideId, coords);

    const ride = await Ride.create({
      id: rideId,
      rider_id: riderId,
      driver_id: null,
      status: 'searching',
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      drop_lat: drop.lat,
      drop_lng: drop.lng,
      distance_km: quote.distanceKm,
      fare: quote.fare,
      eta_min: Math.round(quote.durationMin),
      route_coords: coords,
      timeline: [{ status: 'searching', at: Date.now() }],
    });

    emitToRider(riderId, 'ride', this.formatRideForRider(ride));
    emitToOps('ride:new', ride.toJSON());
    logger.ride(`New ride requested: ${ride.id} by rider ${riderId} (Fare: Rs. ${quote.fare}, ${quote.distanceKm} km)`);

    // Start Batch 1 broadcast
    await this.broadcastBatch(ride, 1, []);
    return ride;
  }

  static async broadcastBatch(ride, batchIndex, excludeDriverIds = []) {
    const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
    const candidates = await SupplyService.findAvailableDriversInRings(pickup, env.maxRings);

    // Rule: Ek driver ko ek waqt pe sirf EK offer (exclude already locked/offered drivers)
    const lockedDrivers = await this.getLockedDriverIds();
    const excludeSet = new Set([...excludeDriverIds, ...lockedDrivers]);
    const eligible = candidates.filter((d) => !excludeSet.has(d.id));

    if (eligible.length === 0) {
      ride.status = 'no_driver';
      const tl = [...ride.timeline, { status: 'no_driver', at: Date.now() }];
      ride.timeline = tl;
      await ride.save();

      emitRideEnded(ride, 'no_driver', null);
      emitToOps('ride:update', ride.toJSON());
      return;
    }

    // Rank by OSRM ETA and slice top BATCH_SIZE
    const ranked = await RoutingService.rankDriversByEta(eligible, pickup);
    const topBatch = ranked.slice(0, env.batchSize);
    const batchDriverIds = topBatch.map((x) => x.driver.id);

    ride.status = 'offered';
    const tl = [...ride.timeline, { status: 'offered', at: Date.now(), batch: batchIndex }];
    ride.timeline = tl;

    // Save RideOffer record & update Ride concurrently
    await Promise.all([
      RideOffer.create({
        ride_id: ride.id,
        batch_index: batchIndex,
        driver_ids: batchDriverIds,
        status: 'offered',
      }),
      ride.save(),
    ]);

    const rider = await Rider.findByPk(ride.rider_id);
    const riderName = rider ? rider.name : 'Rider';
    const expiresAt = Date.now() + env.offerTimeoutMs;

    // Offer payload with ALL fields (riderName, expiresAt, tripMin, camelCase & snake_case)
    const offerPayload = {
      rideId: ride.id,
      riderId: ride.rider_id,
      riderName: riderName,
      pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng },
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      drop: { lat: ride.drop_lat, lng: ride.drop_lng },
      drop_lat: ride.drop_lat,
      drop_lng: ride.drop_lng,
      distanceKm: ride.distance_km,
      distance_km: ride.distance_km,
      fare: ride.fare,
      tripMin: ride.eta_min || 0,
      etaMin: ride.eta_min || 0,
      timeoutMs: env.offerTimeoutMs,
      expiresAt: expiresAt,
      batchIndex,
    };

    topBatch.forEach((item) => {
      emitToDriver(item.driver.id, 'offer', {
        ...offerPayload,
        pickupEtaMin: item.durationMin,
        pickupDistanceKm: item.distanceKm,
      });
    });

    logger.info(`Broadcasted Batch ${batchIndex} to ${topBatch.length} drivers: [${batchDriverIds.join(', ')}]`);
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, null, { batchIndex }));

    // Schedule BullMQ timeout job for this batch
    try {
      await dispatchQueue.add(
        'batch-timeout',
        {
          rideId: ride.id,
          batchIndex,
          triedDriverIds: [...excludeDriverIds, ...batchDriverIds],
        },
        {
          delay: env.offerTimeoutMs,
          jobId: `timeout:${ride.id}:${batchIndex}`,
        }
      );
    } catch (e) {
      console.warn('[DispatchService] BullMQ schedule failed:', e.message);
    }
  }

  static async acceptOffer(driverId, rideId) {
    // 1. Atomic Redis lock to ensure only ONE driver wins the ride
    const lockKey = `lock:ride:${rideId}`;
    const acquired = await redis.set(lockKey, driverId, 'NX', 'EX', 120);

    if (!acquired) {
      const winner = await redis.get(lockKey);
      throw new Error(
        winner === driverId
          ? 'You have already accepted this ride'
          : 'Ride has already been accepted by another driver'
      );
    }

    // 2. Fetch ride and double check status
    const ride = await Ride.findByPk(rideId);
    if (!ride) throw new Error('Ride not found');
    if (ride.status !== 'offered') {
      throw new Error(`Ride is no longer available (current status: ${ride.status})`);
    }

    // 3. Cancel BullMQ timeout job
    try {
      const activeOffers = await RideOffer.findAll({
        where: { ride_id: rideId, status: 'offered' },
      });
      for (const off of activeOffers) {
        const job = await dispatchQueue.getJob(`timeout:${rideId}:${off.batch_index}`);
        if (job) await job.remove();
        off.status = 'accepted';
        off.accepted_by = driverId;
        await off.save();

        // Revoke offer from other drivers in this batch
        off.driver_ids.forEach((id) => {
          if (id !== driverId) {
            emitToDriver(id, 'offer_revoked', { rideId, reason: 'accepted_by_other' });
          }
        });
      }
    } catch (e) {
      console.warn('[DispatchService] Offer cleanup warning:', e.message);
    }

    // 4. Update Ride in DB
    ride.driver_id = driverId;
    ride.status = 'accepted';
    const tl = [...ride.timeline, { status: 'accepted', at: Date.now(), driverId }];
    ride.timeline = tl;
    await ride.save();

    // 5. Mark driver on job
    await SupplyService.markOnJob(driverId);

    // 6. Fetch Driver & Setup Active Ride Tracking
    const driver = await Driver.findByPk(driverId);
    let pickupCoords = [
      [driver.lat, driver.lng],
      [ride.pickup_lat, ride.pickup_lng],
    ];
    let pickupDistanceKm = 1.5;
    let pickupDurationMin = 3;

    try {
      const pickupRoute = await RoutingService.getRoute(
        { lat: driver.lat, lng: driver.lng },
        { lat: ride.pickup_lat, lng: ride.pickup_lng }
      );
      if (pickupRoute.coords && pickupRoute.coords.length > 0) {
        pickupCoords = pickupRoute.coords;
        pickupDistanceKm = pickupRoute.distanceKm;
        pickupDurationMin = pickupRoute.durationMin;
      }
    } catch (err) {
      console.warn('[DispatchService] getRoute to pickup failed, using direct line:', err.message);
    }

    const tripCoords = rideRouteCache.get(rideId) || ride.route_coords || [
      [ride.pickup_lat, ride.pickup_lng],
      [ride.drop_lat, ride.drop_lng],
    ];

    const initialHeading = bearing(
      { lat: driver.lat, lng: driver.lng },
      pickupCoords[1] ? { lat: pickupCoords[1][0], lng: pickupCoords[1][1] } : { lat: ride.pickup_lat, lng: ride.pickup_lng }
    );

    activeTrackers.set(rideId, {
      rideId,
      riderId: ride.rider_id,
      driverId: driver.id,
      driverName: driver.name,
      vehicle: driver.vehicle,
      phase: 'pickup',
      pickupPath: makePath(pickupCoords),
      tripPath: makePath(tripCoords),
      pickupCoords,
      tripCoords,
      pickupKm: pickupDistanceKm,
      distanceAlongPickupKm: 0,
      distanceAlongTripKm: 0,
      speedKmH: 45,
      heading: initialHeading,
      currentPos: { lat: driver.lat, lng: driver.lng },
      lastTick: Date.now(),
      lastRealGpsAt: 0,
      arrivedAt: null,
    });

    const routeForDriver = {
      phase: 'pickup',
      coords: pickupCoords,
      km: pickupDistanceKm,
      min: Math.round(pickupDurationMin),
    };

    const formattedForRider = this.formatRideForRider(ride, driver, {
      route: { phase: 'pickup', coords: pickupCoords },
      tripRoute: tripCoords,
      heading: initialHeading,
      etaMin: Math.round(pickupDurationMin),
    });

    const formattedForDriver = await this.formatRideForDriver(ride, driver, {
      route: routeForDriver,
      pickupCoords,
      tripRoute: tripCoords,
      etaMin: Math.round(pickupDurationMin),
      pickupKm: pickupDistanceKm,
    });

    emitToRider(ride.rider_id, 'ride', formattedForRider);
    emitToDriver(driverId, 'ride:update', formattedForDriver);
    emitToOps('ride:update', ride.toJSON());
    logger.ok(`Driver ${driverId} accepted ride ${rideId} (won atomic lock)`);

    return {
      ok: true,
      ride: formattedForDriver,
      route: routeForDriver,
    };
  }

  static async declineOffer(driverId, rideId) {
    try {
      const offer = await RideOffer.findOne({
        where: { ride_id: rideId, status: 'offered' },
      });
      if (offer && Array.isArray(offer.driver_ids)) {
        offer.driver_ids = offer.driver_ids.filter((id) => id !== driverId);
        await offer.save();
      }
    } catch (_) {}

    emitToDriver(driverId, 'offer_revoked', { rideId, reason: 'declined' });
    return { ok: true };
  }

  static async markArrived(driverId) {
    const ride = await Ride.findOne({
      where: { driver_id: driverId, status: 'accepted' },
    });
    if (!ride) throw new Error('No accepted ride found for driver');

    ride.status = 'arrived';
    ride.timeline = [...ride.timeline, { status: 'arrived', at: Date.now() }];
    await ride.save();

    const tracker = activeTrackers.get(ride.id);
    if (tracker) {
      tracker.arrivedAt = Date.now();
    }

    const driver = await Driver.findByPk(driverId);
    const tripCoords = rideRouteCache.get(ride.id) || ride.route_coords || [
      [ride.pickup_lat, ride.pickup_lng],
      [ride.drop_lat, ride.drop_lng],
    ];

    const routeForDriver = {
      phase: 'pickup',
      coords: tracker?.pickupCoords || [[driver.lat, driver.lng], [ride.pickup_lat, ride.pickup_lng]],
      km: 0,
      min: 0,
    };

    const formattedForDriver = await this.formatRideForDriver(ride, driver, {
      route: routeForDriver,
      etaMin: 0,
    });

    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver, { etaMin: 0 }));
    emitToDriver(driverId, 'ride:update', formattedForDriver);
    emitToDriver(driverId, 'ride:arrived', { rideId: ride.id, ride: formattedForDriver });
    emitToOps('ride:update', ride.toJSON());

    return { ok: true, ride: formattedForDriver, route: routeForDriver };
  }

  static async startTrip(driverId) {
    const ride = await Ride.findOne({
      where: { driver_id: driverId, status: 'arrived' },
    });
    if (!ride) throw new Error('No arrived ride found for driver');

    ride.status = 'on_trip';
    ride.timeline = [...ride.timeline, { status: 'on_trip', at: Date.now() }];
    await ride.save();

    const tracker = activeTrackers.get(ride.id);
    if (tracker) {
      tracker.phase = 'trip';
      tracker.lastTick = Date.now();
    }

    const driver = await Driver.findByPk(driverId);
    const tripCoords = tracker?.tripCoords || rideRouteCache.get(ride.id) || ride.route_coords || [
      [ride.pickup_lat, ride.pickup_lng],
      [ride.drop_lat, ride.drop_lng],
    ];

    const routeForDriver = {
      phase: 'trip',
      coords: tripCoords,
      km: ride.distance_km,
      min: ride.eta_min,
    };

    const formattedForDriver = await this.formatRideForDriver(ride, driver, {
      route: routeForDriver,
      tripRoute: tripCoords,
    });

    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver));
    emitToDriver(driverId, 'ride:update', formattedForDriver);
    emitToDriver(driverId, 'ride:started', { rideId: ride.id, ride: formattedForDriver });
    emitToOps('ride:update', ride.toJSON());

    return { ok: true, ride: formattedForDriver, route: routeForDriver };
  }

  static async completeTrip(driverId) {
    const ride = await Ride.findOne({
      where: { driver_id: driverId, status: 'on_trip' },
    });
    if (!ride) throw new Error('No active on_trip ride found');

    ride.status = 'completed';
    ride.timeline = [...ride.timeline, { status: 'completed', at: Date.now() }];
    await ride.save();

    await SupplyService.freeDriver(driverId);

    const driver = await Driver.findByPk(driverId);
    const formattedForDriver = await this.formatRideForDriver(ride, driver);

    emitRideEnded(ride, 'completed', driver);
    emitToDriver(driverId, 'ride:ended', {
      reason: 'completed',
      fare: ride.fare,
      tripKm: ride.distance_km,
      distanceKm: ride.distance_km,
      rideId: ride.id,
    });
    emitToDriver(driverId, 'ride:completed', {
      rideId: ride.id,
      fare: ride.fare,
      distanceKm: ride.distance_km,
      tripKm: ride.distance_km,
      ride: formattedForDriver,
    });
    emitToOps('ride:update', ride.toJSON());

    return {
      ok: true,
      fare: ride.fare,
      distanceKm: ride.distance_km,
      tripKm: ride.distance_km,
      ride: formattedForDriver,
    };
  }

  static async cancelRideByDriver(driverId) {
    const ride = await this.getActiveRideOfDriver(driverId);
    if (!ride) throw new Error('No active ride found for driver to cancel');

    // 1. Free driver
    await SupplyService.freeDriver(driverId);
    activeTrackers.delete(ride.id);

    // 2. Put ride back into searching status
    ride.driver_id = null;
    ride.status = 'searching';
    ride.timeline = [
      ...ride.timeline,
      { status: 'driver_cancelled', at: Date.now(), driverId },
      { status: 'searching', at: Date.now(), reason: 'driver_reassign' },
    ];
    await ride.save();

    // 3. Notify rider that driver cancelled and we are finding another one
    const riderPayload = this.formatRideForRider(ride, null, {
      notice: 'Your driver cancelled. Finding you another one.',
    });
    emitToRider(ride.rider_id, 'ride', riderPayload);
    emitToRider(ride.rider_id, 'ride:update', riderPayload);
    emitToOps('ride:update', ride.toJSON());

    logger.warn(`Driver ${driverId} cancelled ride ${ride.id}. Re-dispatching to another driver...`);

    // 4. Re-dispatch immediately, excluding the driver who cancelled
    await this.broadcastBatch(ride, 1, [driverId]);

    emitToDriver(driverId, 'ride:ended', {
      reason: 'driver_cancelled',
      rideId: ride.id,
    });

    return {
      ok: true,
      message: 'Ride cancelled. Rider is being re-assigned to another driver.',
      ride: { id: ride.id, status: 'searching' },
    };
  }

  static async cancelRide(rideId, reason = 'cancelled') {
    const ride = await Ride.findByPk(rideId);
    if (!ride) throw new Error('Ride not found');

    ride.status = 'cancelled';
    ride.timeline = [...ride.timeline, { status: 'cancelled', at: Date.now(), reason }];
    await ride.save();

    let driver = null;
    if (ride.driver_id) {
      driver = await Driver.findByPk(ride.driver_id);
      await SupplyService.freeDriver(ride.driver_id);
      emitToDriver(ride.driver_id, 'ride:ended', {
        reason: 'cancelled',
        rideId,
      });
      emitToDriver(ride.driver_id, 'ride:cancelled', { rideId, reason });
    }

    emitRideEnded(ride, reason, driver);
    emitToOps('ride:update', ride.toJSON());
    return { ok: true, ride: ride.toJSON() };
  }

  static updateDriverLiveLocation(rideId, driverId, coords) {
    const tracker = activeTrackers.get(rideId);
    if (tracker) {
      const prev = tracker.currentPos;
      tracker.heading = coords.heading !== undefined
        ? Number(coords.heading)
        : (bearing(prev, coords) || tracker.heading);
      tracker.currentPos = { lat: coords.lat, lng: coords.lng };
      tracker.lastRealGpsAt = Date.now();
    }
  }

  static async getActiveRideOfDriver(driverId) {
    return await Ride.findOne({
      where: {
        driver_id: driverId,
        status: ['accepted', 'arrived', 'on_trip'],
      },
      order: [['updated_at', 'DESC']],
    });
  }

  static async getActiveRideOfRider(riderId) {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const ride = await Ride.findOne({
      where: {
        rider_id: riderId,
        status: ['searching', 'offered', 'accepted', 'arrived', 'on_trip', 'no_driver'],
      },
      order: [['created_at', 'DESC']],
    });

    if (!ride) return null;

    // If it's no_driver, only treat as active if it occurred in the last 10 minutes
    if (ride.status === 'no_driver') {
      const updatedAt = new Date(ride.updated_at || ride.created_at);
      if (updatedAt < tenMinutesAgo) return null;
    }

    return ride;
  }

  static async getFullRidePayload(ride, driver = null) {
    if (!ride) return null;
    const r = ride.toJSON ? ride.toJSON() : ride;
    const pickup = { lat: r.pickup_lat, lng: r.pickup_lng };
    const drop = { lat: r.drop_lat, lng: r.drop_lng };

    // Ensure trip route coords exist
    let tripCoords = rideRouteCache.get(r.id) || r.route_coords;
    if (!tripCoords || tripCoords.length === 0) {
      try {
        const route = await RoutingService.getRoute(pickup, drop);
        tripCoords = route.coords;
        rideRouteCache.set(r.id, tripCoords);
      } catch (_) {
        tripCoords = [
          [pickup.lat, pickup.lng],
          [drop.lat, drop.lng],
        ];
      }
    }

    // Check in-memory tracker first
    const tracker = activeTrackers.get(r.id);
    if (tracker) {
      const driverObj = {
        id: tracker.driverId,
        name: tracker.driverName,
        lat: tracker.currentPos.lat,
        lng: tracker.currentPos.lng,
        heading: tracker.heading,
        vehicle: tracker.vehicle,
      };
      const phase = r.status === 'on_trip' ? 'trip' : 'pickup';
      const coords = phase === 'pickup' ? tracker.pickupCoords : tracker.tripCoords;
      const remDistKm = phase === 'pickup'
        ? Math.max(0, tracker.pickupPath.total - tracker.distanceAlongPickupKm)
        : Math.max(0, tracker.tripPath.total - tracker.distanceAlongTripKm);
      const etaMin = Math.round(minutesAt(remDistKm, tracker.speedKmH) * 10) / 10;

      return this.formatRideForRider(ride, driverObj, {
        route: { phase, coords },
        tripRoute: tracker.tripCoords,
        etaMin: Math.max(0, Math.round(etaMin)),
        tripMin: r.eta_min,
        heading: tracker.heading,
      });
    }

    // If driver is assigned but no tracker in memory (e.g. after restart or reconnect)
    let driverObj = null;
    let route = { phase: 'trip', coords: tripCoords };

    const activeDriverId = r.driver_id || driver?.id;
    if (activeDriverId) {
      const d = driver || (await Driver.findByPk(activeDriverId));
      if (d) {
        driverObj = {
          id: d.id,
          name: d.name,
          lat: d.lat,
          lng: d.lng,
          heading: d.heading || 0,
          vehicle: d.vehicle,
        };
        if (['accepted', 'arrived'].includes(r.status)) {
          let pickupCoords = [
            [d.lat, d.lng],
            [pickup.lat, pickup.lng],
          ];
          try {
            const pRoute = await RoutingService.getRoute(
              { lat: d.lat, lng: d.lng },
              pickup
            );
            if (pRoute.coords && pRoute.coords.length > 0) pickupCoords = pRoute.coords;
          } catch (_) {}
          route = { phase: 'pickup', coords: pickupCoords };
        }
      }
    }

    return this.formatRideForRider(ride, driverObj, {
      route,
      tripRoute: tripCoords,
      tripMin: r.eta_min,
    });
  }

  static async formatRideForDriver(ride, driver = null, extra = {}) {
    const r = ride.toJSON ? ride.toJSON() : ride;
    const rider = await Rider.findByPk(r.rider_id);
    const pickup = { lat: r.pickup_lat, lng: r.pickup_lng };
    const drop = { lat: r.drop_lat, lng: r.drop_lng };

    const tripCoords = extra.tripRoute || rideRouteCache.get(r.id) || r.route_coords || [
      [pickup.lat, pickup.lng],
      [drop.lat, drop.lng],
    ];

    let route = extra.route;
    if (!route) {
      if (['accepted', 'arrived'].includes(r.status)) {
        const d = extra.driver || driver;
        let pickupCoords = d ? [[d.lat, d.lng], [pickup.lat, pickup.lng]] : tripCoords;
        if (extra.pickupCoords) pickupCoords = extra.pickupCoords;
        route = {
          phase: 'pickup',
          coords: pickupCoords,
          km: extra.pickupKm !== undefined ? extra.pickupKm : 1.5,
          min: extra.etaMin !== undefined ? extra.etaMin : 3,
        };
      } else {
        route = {
          phase: 'trip',
          coords: tripCoords,
          km: r.distance_km,
          min: r.eta_min,
        };
      }
    }

    return {
      id: r.id,
      rideId: r.id,
      status: r.status,
      riderId: r.rider_id,
      riderName: rider ? rider.name : 'Rider',
      riderPhone: rider?.phone || null,
      pickup,
      pickup_lat: r.pickup_lat,
      pickup_lng: r.pickup_lng,
      drop,
      drop_lat: r.drop_lat,
      drop_lng: r.drop_lng,
      distanceKm: r.distance_km,
      distance_km: r.distance_km,
      fare: r.fare,
      etaMin: extra.etaMin !== undefined ? extra.etaMin : (r.eta_min || 0),
      tripMin: r.eta_min || 0,
      route,
      tripRoute: tripCoords,
      timeline: r.timeline,
    };
  }

  static formatRideForRider(ride, driver = null, extra = {}) {
    const r = ride.toJSON ? ride.toJSON() : ride;
    const pickup = { lat: r.pickup_lat, lng: r.pickup_lng };
    const drop = { lat: r.drop_lat, lng: r.drop_lng };

    // Trip route coordinates - guaranteed non-empty array
    const tripRoute = extra.tripRoute || rideRouteCache.get(r.id) || r.route_coords || [
      [pickup.lat, pickup.lng],
      [drop.lat, drop.lng],
    ];

    // Determine route phase and coords
    let route = extra.route;
    if (!route) {
      if (['accepted', 'arrived'].includes(r.status) && (driver || extra.driver)) {
        const d = extra.driver || driver;
        const pickupCoords = extra.pickupRoute || [
          [d.lat, d.lng],
          [pickup.lat, pickup.lng],
        ];
        route = { phase: 'pickup', coords: pickupCoords };
      } else {
        route = { phase: 'trip', coords: tripRoute };
      }
    }

    // Driver object with heading
    let driverObj = null;
    const d = extra.driver || driver;
    if (d) {
      driverObj = {
        id: d.id,
        name: d.name,
        lat: d.lat,
        lng: d.lng,
        heading: d.heading ?? extra.heading ?? 0,
        vehicle: d.vehicle || { make: 'Maruti', model: 'Dzire', color: 'White', plate: 'DL 01 AB 1234' },
      };
    }

    // Search H3 rings animation object for searching/offered status
    let search = null;
    if (['searching', 'offered'].includes(r.status)) {
      const pickupCell = cellOf(pickup, env.h3Res);
      const currentRing = extra.batchIndex ? Math.min(extra.batchIndex - 1, 2) : 0;
      search = {
        ring: currentRing,
        rings: env.maxRings || 3,
        cells: h3.gridDisk(pickupCell, currentRing),
      };
    }

    const etaMin = extra.etaMin !== undefined ? extra.etaMin : (r.eta_min || 0);
    const tripMin = extra.tripMin !== undefined ? extra.tripMin : (r.eta_min || 0);

    return {
      id: r.id,
      rideId: r.id,
      status: r.status,
      pickup,
      pickup_lat: r.pickup_lat,
      pickup_lng: r.pickup_lng,
      drop,
      drop_lat: r.drop_lat,
      drop_lng: r.drop_lng,
      distanceKm: r.distance_km,
      distance_km: r.distance_km,
      fare: r.fare,
      etaMin,
      tripMin,
      driver: driverObj,
      route,
      tripRoute,
      search,
      offerPending: r.status === 'offered',
      notice: extra.notice || null,
      timeline: r.timeline,
    };
  }
}

// 1-second Interval Ticker for Live Car Movement & ETA Updates
setInterval(async () => {
  if (!ioInstance || activeTrackers.size === 0) return;
  const now = Date.now();

  for (const [rideId, tracker] of activeTrackers.entries()) {
    try {
      const ride = await Ride.findByPk(rideId);
      if (!ride || ['completed', 'cancelled', 'no_driver'].includes(ride.status)) {
        activeTrackers.delete(rideId);
        continue;
      }

      const dt = (now - tracker.lastTick) / 1000;
      tracker.lastTick = now;

      // Only advance simulated movement if no real driver GPS was received recently (within 3 seconds)
      const isSimulated = !tracker.lastRealGpsAt || (now - tracker.lastRealGpsAt > 3000);

      if (ride.status === 'accepted') {
        if (isSimulated && dt > 0) {
          tracker.distanceAlongPickupKm += (tracker.speedKmH / 3600) * dt;
          const nextPt = pointAlong(tracker.pickupPath, tracker.distanceAlongPickupKm);
          const newHeading = bearing(tracker.currentPos, nextPt) || tracker.heading;
          tracker.currentPos = { lat: nextPt.lat, lng: nextPt.lng };
          tracker.heading = newHeading;
        }

        const remDistKm = Math.max(0, tracker.pickupPath.total - tracker.distanceAlongPickupKm);
        // ETA = seedhi doori × 1.3 ÷ 24 km/h
        const straightKm = km(tracker.currentPos, { lat: ride.pickup_lat, lng: ride.pickup_lng });
        const etaMin = Math.max(1, Math.round(((straightKm * 1.3) / 24) * 60));

        const driverObj = {
          id: tracker.driverId,
          name: tracker.driverName,
          lat: tracker.currentPos.lat,
          lng: tracker.currentPos.lng,
          heading: tracker.heading,
          vehicle: tracker.vehicle,
        };

        const payloadForRider = DispatchService.formatRideForRider(ride, driverObj, {
          route: { phase: 'pickup', coords: tracker.pickupCoords },
          tripRoute: tracker.tripCoords,
          etaMin: Math.max(1, Math.round(etaMin)),
          tripMin: ride.eta_min,
          heading: tracker.heading,
        });

        const routeForDriver = {
          phase: 'pickup',
          coords: tracker.pickupCoords,
          km: Math.round(remDistKm * 10) / 10,
          min: Math.max(1, Math.round(etaMin)),
        };

        const payloadForDriver = await DispatchService.formatRideForDriver(ride, driverObj, {
          route: routeForDriver,
          pickupCoords: tracker.pickupCoords,
          tripRoute: tracker.tripCoords,
          etaMin: Math.max(1, Math.round(etaMin)),
          pickupKm: Math.round(remDistKm * 10) / 10,
        });

        emitToRider(ride.rider_id, 'ride', payloadForRider);
        emitToDriver(tracker.driverId, 'ride:update', payloadForDriver);

        // Auto-transition to arrived when reaching pickup point in simulation
        if (isSimulated && (remDistKm <= 0.05 || tracker.distanceAlongPickupKm >= tracker.pickupPath.total)) {
          await DispatchService.markArrived(tracker.driverId);
          tracker.arrivedAt = Date.now();
        }
      } else if (ride.status === 'arrived') {
        const driverObj = {
          id: tracker.driverId,
          name: tracker.driverName,
          lat: tracker.currentPos.lat,
          lng: tracker.currentPos.lng,
          heading: tracker.heading,
          vehicle: tracker.vehicle,
        };

        const payloadForRider = DispatchService.formatRideForRider(ride, driverObj, {
          route: { phase: 'pickup', coords: tracker.pickupCoords },
          tripRoute: tracker.tripCoords,
          etaMin: 0,
          tripMin: ride.eta_min,
          heading: tracker.heading,
        });

        const routeForDriver = {
          phase: 'pickup',
          coords: tracker.pickupCoords,
          km: 0,
          min: 0,
        };

        const payloadForDriver = await DispatchService.formatRideForDriver(ride, driverObj, {
          route: routeForDriver,
          pickupCoords: tracker.pickupCoords,
          tripRoute: tracker.tripCoords,
          etaMin: 0,
        });

        emitToRider(ride.rider_id, 'ride', payloadForRider);
        emitToDriver(tracker.driverId, 'ride:update', payloadForDriver);

        // If simulated driver, auto-start trip after 3 seconds of waiting at pickup
        if (isSimulated && tracker.arrivedAt && (now - tracker.arrivedAt >= 3000)) {
          await DispatchService.startTrip(tracker.driverId);
        }
      } else if (ride.status === 'on_trip') {
        if (isSimulated && dt > 0) {
          tracker.distanceAlongTripKm += (tracker.speedKmH / 3600) * dt;
          const nextPt = pointAlong(tracker.tripPath, tracker.distanceAlongTripKm);
          const newHeading = bearing(tracker.currentPos, nextPt) || tracker.heading;
          tracker.currentPos = { lat: nextPt.lat, lng: nextPt.lng };
          tracker.heading = newHeading;
        }

        const remDistKm = Math.max(0, tracker.tripPath.total - tracker.distanceAlongTripKm);
        // ETA = seedhi doori × 1.3 ÷ 24 km/h
        const straightKm = km(tracker.currentPos, { lat: ride.drop_lat, lng: ride.drop_lng });
        const remTripMin = Math.max(0, Math.round(((straightKm * 1.3) / 24) * 60));

        const driverObj = {
          id: tracker.driverId,
          name: tracker.driverName,
          lat: tracker.currentPos.lat,
          lng: tracker.currentPos.lng,
          heading: tracker.heading,
          vehicle: tracker.vehicle,
        };

        const payloadForRider = DispatchService.formatRideForRider(ride, driverObj, {
          route: { phase: 'trip', coords: tracker.tripCoords },
          tripRoute: tracker.tripCoords,
          etaMin: Math.max(0, Math.round(remTripMin)),
          tripMin: Math.max(0, Math.round(remTripMin)),
          heading: tracker.heading,
        });

        const routeForDriver = {
          phase: 'trip',
          coords: tracker.tripCoords,
          km: Math.round(remDistKm * 10) / 10,
          min: Math.max(0, Math.round(remTripMin)),
        };

        const payloadForDriver = await DispatchService.formatRideForDriver(ride, driverObj, {
          route: routeForDriver,
          tripRoute: tracker.tripCoords,
          etaMin: Math.max(0, Math.round(remTripMin)),
          tripMin: Math.max(0, Math.round(remTripMin)),
        });

        emitToRider(ride.rider_id, 'ride', payloadForRider);
        emitToDriver(tracker.driverId, 'ride:update', payloadForDriver);

        // Auto-complete trip when reaching destination in simulation
        if (isSimulated && (remDistKm <= 0.05 || tracker.distanceAlongTripKm >= tracker.tripPath.total)) {
          await DispatchService.completeTrip(tracker.driverId);
        }
      }
    } catch (err) {
      console.warn(`[DispatchService] Ticker error for ride ${rideId}:`, err.message);
    }
  }
}, 1000);

// Wire up BullMQ timeout worker handler
registerTimeoutHandler(async ({ rideId, batchIndex, triedDriverIds }) => {
  const ride = await Ride.findByPk(rideId);
  if (!ride || ride.status !== 'offered') return;

  // Mark current offer as expired
  await RideOffer.update(
    { status: 'expired' },
    { where: { ride_id: rideId, batch_index: batchIndex, status: 'offered' } }
  );

  // Revoke offers from the current batch drivers
  const prevOffer = await RideOffer.findOne({
    where: { ride_id: rideId, batch_index: batchIndex },
  });
  if (prevOffer) {
    prevOffer.driver_ids.forEach((id) => {
      emitToDriver(id, 'offer_revoked', { rideId, reason: 'timeout' });
    });
  }

  // Trigger next batch (Batch 2, Batch 3, etc.)
  await DispatchService.broadcastBatch(ride, batchIndex + 1, triedDriverIds);
});
