import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { Ride, RideOffer, Driver, Rider } from '../models/index.js';
import { SupplyService } from './supply.service.js';
import { RoutingService } from './routing.service.js';
import { dispatchQueue, registerTimeoutHandler } from '../queues/dispatch.queue.js';
import { logger } from '../utils/logger.js';

let ioInstance = null;

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
    ioInstance.of('/rider').to(`rider:${riderId}`).emit(event, payload);
  }
}

export function emitToOps(event, payload) {
  if (ioInstance) {
    ioInstance.of('/ops').emit(event, payload);
  }
}

let rideSeq = 1;

export class DispatchService {
  static async requestRide(riderId, pickup, drop) {
    const rideId = `ride_${Date.now()}_${rideSeq++}`;
    const quote = await RoutingService.getQuote(pickup, drop);

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

    // Filter out excluded drivers
    const excludeSet = new Set(excludeDriverIds);
    const eligible = candidates.filter((d) => !excludeSet.has(d.id));

    if (eligible.length === 0) {
      ride.status = 'no_driver';
      const tl = [...ride.timeline, { status: 'no_driver', at: Date.now() }];
      ride.timeline = tl;
      await ride.save();

      emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride));
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

    // Broadcast offer simultaneously to all drivers in the batch
    const offerPayload = {
      rideId: ride.id,
      pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng },
      drop: { lat: ride.drop_lat, lng: ride.drop_lng },
      distanceKm: ride.distance_km,
      fare: ride.fare,
      timeoutMs: env.offerTimeoutMs,
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
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride));

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
      console.warn('[DispatchService] Queue add error:', e.message);
    }
  }

  static async acceptOffer(driverId, rideId) {
    // 1. ATOMIC REDIS LOCK: First to acquire wins the ride
    let acquired = false;
    try {
      const res = await redis.set(`lock:ride:${rideId}`, driverId, 'NX', 'EX', 15);
      acquired = res === 'OK';
    } catch (e) {
      acquired = true; // Fallback
    }

    if (!acquired) {
      return { ok: false, error: 'Ride already accepted by another driver' };
    }

    // 2. Fetch ride and verify status
    const ride = await Ride.findByPk(rideId);
    if (!ride || ride.status !== 'offered') {
      return { ok: false, error: 'Ride is no longer available' };
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

    // 6. Notify Rider
    const driver = await Driver.findByPk(driverId);
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver));
    emitToOps('ride:update', ride.toJSON());
    logger.ok(`Driver ${driverId} accepted ride ${rideId} (won atomic lock)`);

    return { ok: true, ride: ride.toJSON() };
  }

  static async declineOffer(driverId, rideId) {
    emitToDriver(driverId, 'offer_revoked', { rideId, reason: 'declined' });
    return { ok: true };
  }

  static async markArrived(driverId) {
    const ride = await Ride.findOne({
      where: { driver_id: driverId, status: 'accepted' },
    });
    if (!ride) throw new Error('No accepted ride found');

    ride.status = 'arrived';
    ride.timeline = [...ride.timeline, { status: 'arrived', at: Date.now() }];
    await ride.save();

    const driver = await Driver.findByPk(driverId);
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver));
    emitToOps('ride:update', ride.toJSON());
    return { ok: true, ride: ride.toJSON() };
  }

  static async startTrip(driverId) {
    const ride = await Ride.findOne({
      where: { driver_id: driverId, status: 'arrived' },
    });
    if (!ride) throw new Error('Driver must mark arrived before starting trip');

    ride.status = 'on_trip';
    ride.timeline = [...ride.timeline, { status: 'on_trip', at: Date.now() }];
    await ride.save();

    const driver = await Driver.findByPk(driverId);
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver));
    emitToOps('ride:update', ride.toJSON());
    return { ok: true, ride: ride.toJSON() };
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
    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride, driver));
    emitToDriver(driverId, 'ride:completed', { rideId: ride.id, fare: ride.fare });
    emitToOps('ride:update', ride.toJSON());
    return { ok: true, ride: ride.toJSON() };
  }

  static async cancelRide(rideId, reason = 'cancelled') {
    const ride = await Ride.findByPk(rideId);
    if (!ride) throw new Error('Ride not found');

    ride.status = 'cancelled';
    ride.timeline = [...ride.timeline, { status: 'cancelled', at: Date.now(), reason }];
    await ride.save();

    if (ride.driver_id) {
      await SupplyService.freeDriver(ride.driver_id);
      emitToDriver(ride.driver_id, 'ride:cancelled', { rideId, reason });
    }

    emitToRider(ride.rider_id, 'ride', this.formatRideForRider(ride));
    emitToOps('ride:update', ride.toJSON());
    return { ok: true, ride: ride.toJSON() };
  }

  static async getActiveRideOfDriver(driverId) {
    return await Ride.findOne({
      where: {
        driver_id: driverId,
        status: ['accepted', 'arrived', 'on_trip'],
      },
    });
  }

  static async getActiveRideOfRider(riderId) {
    return await Ride.findOne({
      where: {
        rider_id: riderId,
        status: ['searching', 'offered', 'accepted', 'arrived', 'on_trip'],
      },
    });
  }

  static formatRideForRider(ride, driver = null) {
    const r = ride.toJSON ? ride.toJSON() : ride;
    return {
      id: r.id,
      status: r.status,
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng },
      drop: { lat: r.drop_lat, lng: r.drop_lng },
      distanceKm: r.distance_km,
      fare: r.fare,
      etaMin: r.eta_min,
      driver: driver
        ? {
            id: driver.id,
            name: driver.name,
            lat: driver.lat,
            lng: driver.lng,
            vehicle: driver.vehicle,
          }
        : null,
      timeline: r.timeline,
    };
  }
}

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
