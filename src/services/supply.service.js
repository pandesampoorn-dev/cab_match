import * as h3 from 'h3-js';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { Driver } from '../models/index.js';
import { cellOf, isLatLng, bearing } from '../geo.js';

export class SupplyService {
  /**
   * Driver live GPS coordinates update (3-5 sec interval).
   * Fast writes to Redis + updates H3 cell index.
   */
  static async updateLocation(driverId, pos) {
    const lat = Number(pos.lat);
    const lng = Number(pos.lng);
    if (!isLatLng({ lat, lng })) throw new Error('Invalid lat/lng coordinates');

    const cell = cellOf({ lat, lng }, env.h3Res);
    const now = Date.now();

    let heading = Number.isFinite(Number(pos.heading)) ? Math.round(Number(pos.heading)) : null;

    try {
      // 1. Get previous location & cell
      const prevLoc = await redis.hgetall(`driver:loc:${driverId}`);
      const prevCell = await redis.get(`driver:cell:${driverId}`);

      if (heading === null && prevLoc && prevLoc.lat && prevLoc.lng) {
        const prevLat = parseFloat(prevLoc.lat);
        const prevLng = parseFloat(prevLoc.lng);
        if (Math.abs(prevLat - lat) > 0.00001 || Math.abs(prevLng - lng) > 0.00001) {
          heading = bearing({ lat: prevLat, lng: prevLng }, { lat, lng });
        } else if (prevLoc.heading !== undefined) {
          heading = parseInt(prevLoc.heading, 10) || 0;
        }
      }
      if (heading === null) heading = 0;

      // 2. Transaction to update GPS hash & H3 sets
      const pipeline = redis.pipeline();
      pipeline.hset(`driver:loc:${driverId}`, {
        lat: String(lat),
        lng: String(lng),
        heading: String(heading),
        cell: cell,
        updated_at: String(now),
      });
      pipeline.expire(`driver:loc:${driverId}`, Math.round(env.locationTtlMs / 1000));

      if (prevCell && prevCell !== cell) {
        pipeline.srem(`h3:res:${env.h3Res}:${prevCell}`, driverId);
      }
      pipeline.sadd(`h3:res:${env.h3Res}:${cell}`, driverId);
      pipeline.set(`driver:cell:${driverId}`, cell);

      await pipeline.exec();
    } catch (e) {
      console.warn(`[SupplyService] Redis updateLocation failed for ${driverId}:`, e.message);
      if (heading === null) heading = 0;
    }

    // 3. Update DB state asynchronously
    Driver.update(
      { lat, lng, heading },
      { where: { id: driverId } }
    ).catch((err) => console.warn(`[SupplyService] DB loc update error:`, err.message));

    return { driverId, lat, lng, heading, cell };
  }

  /**
   * Driver goes online and available.
   */
  static async setOnline(driverId, pos) {
    if (pos && isLatLng(pos)) {
      await this.updateLocation(driverId, pos);
    }

    try {
      await redis.sadd('drivers:available', driverId);
    } catch (e) {
      console.warn('[SupplyService] Redis sadd failed:', e.message);
    }

    await Driver.update(
      { online: true, status: 'available' },
      { where: { id: driverId } }
    );

    return { driverId, online: true, status: 'available' };
  }

  /**
   * Driver goes offline.
   */
  static async setOffline(driverId) {
    try {
      const cell = await redis.get(`driver:cell:${driverId}`);
      const pipeline = redis.pipeline();
      pipeline.srem('drivers:available', driverId);
      if (cell) {
        pipeline.srem(`h3:res:${env.h3Res}:${cell}`, driverId);
      }
      pipeline.del(`driver:cell:${driverId}`);
      await pipeline.exec();
    } catch (e) {
      console.warn('[SupplyService] Redis offline cleanup failed:', e.message);
    }

    await Driver.update(
      { online: false, status: 'offline' },
      { where: { id: driverId } }
    );

    return { driverId, online: false, status: 'offline' };
  }

  /**
   * Mark driver on job (when ride accepted).
   */
  static async markOnJob(driverId) {
    try {
      await redis.srem('drivers:available', driverId);
    } catch (e) {
      console.warn('[SupplyService] Redis srem available failed:', e.message);
    }

    await Driver.update(
      { status: 'on_job' },
      { where: { id: driverId } }
    );
  }

  /**
   * Free driver after ride completed / cancelled.
   */
  static async freeDriver(driverId) {
    const driver = await Driver.findByPk(driverId);
    if (!driver) return;

    if (driver.online) {
      try {
        await redis.sadd('drivers:available', driverId);
      } catch (e) {
        console.warn('[SupplyService] Redis sadd available failed:', e.message);
      }
      driver.status = 'available';
    } else {
      driver.status = 'offline';
    }
    await driver.save();
  }

  /**
   * Spatial ring search using H3 gridDisk.
   * Returns available drivers sorted by spatial rings.
   */
  static async findAvailableDriversInRings(centerPoint, maxRings = env.maxRings) {
    if (!isLatLng(centerPoint)) return [];

    const centerCell = cellOf(centerPoint, env.h3Res);
    const ringCells = h3.gridDisk(centerCell, maxRings);

    // Get all driver IDs across these cells
    const cellKeys = ringCells.map((c) => `h3:res:${env.h3Res}:${c}`);
    let candidateIds = [];

    try {
      if (cellKeys.length > 0) {
        // Find which candidate IDs are in cells AND currently available
        const inCells = await redis.sunion(...cellKeys);
        if (inCells && inCells.length > 0) {
          const availableSet = await redis.smembers('drivers:available');
          const availLookup = new Set(availableSet);
          candidateIds = inCells.filter((id) => availLookup.has(id));
        }
      }
    } catch (e) {
      console.warn('[SupplyService] Redis ring lookup fallback:', e.message);
      // Fallback to DB
      const dbDrivers = await Driver.findAll({
        where: { online: true, status: 'available' },
      });
      candidateIds = dbDrivers.map((d) => d.id);
    }

    if (candidateIds.length === 0) return [];

    // Fetch latest coordinates and driver details
    const drivers = [];
    for (const id of candidateIds) {
      let lat = null, lng = null;
      try {
        const loc = await redis.hgetall(`driver:loc:${id}`);
        if (loc && loc.lat && loc.lng) {
          lat = parseFloat(loc.lat);
          lng = parseFloat(loc.lng);
        }
      } catch (e) {}

      if (lat === null || lng === null) {
        const dbD = await Driver.findByPk(id);
        if (dbD && dbD.lat && dbD.lng) {
          lat = dbD.lat;
          lng = dbD.lng;
        }
      }

      if (lat !== null && lng !== null) {
        const dRec = await Driver.findByPk(id);
        let heading = 0;
        const locH = await redis.hget(`driver:loc:${id}`, 'heading').catch(() => null);
        if (locH !== null && locH !== undefined) {
          heading = parseInt(locH, 10) || 0;
        } else if (dRec && dRec.heading) {
          heading = dRec.heading;
        }

        drivers.push({
          id,
          name: dRec ? dRec.name : id,
          lat,
          lng,
          heading,
          vehicle: dRec ? dRec.vehicle : null,
        });
      }
    }

    return drivers;
  }
}
