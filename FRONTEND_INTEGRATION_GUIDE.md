# Frontend Integration Guide (Rider & Driver App)

Complete WebSocket integration reference for the Ride-Hailing platform. This document covers all socket connections, events, request payloads, ack callbacks, and incoming server streams for both the **Rider App** and **Driver App**.

---

## 1. Architecture Overview

* **Server Base URL:** `http://localhost:4000` (or production host)
* **WebSocket Library:** Socket.IO Client (`socket.io-client` v4.x)
* **Namespaces:**
  * **Rider App:** `/rider`
  * **Driver App:** `/driver`
* **Transports:** `['websocket']` (recommended for low latency)
* **Key Conventions:**
  * All coordinates are in `{ lat: number, lng: number }`.
  * For maximum frontend compatibility, payloads provide **both** camelCase (`pickup: { lat, lng }`, `distanceKm`) and snake_case (`pickup_lat`, `pickup_lng`, `distance_km`).
  * `tripRoute` is **guaranteed** to be a non-empty array of `[lat, lng]` coordinates (map components will never crash on `coords.length`).

---

## 2. Rider App Integration (`/rider`)

### 2.1 Connection & Handshake
Connect to the `/rider` namespace passing `riderId` and optional `name`:

```typescript
import { io, Socket } from 'socket.io-client';

const riderSocket: Socket = io('http://localhost:4000/rider', {
  auth: {
    riderId: 'rider_01',
    name: 'Priya Sharma',
  },
  transports: ['websocket'],
});
```

---

### 2.2 Rider App $\rightarrow$ Server (Client Actions & Acks)

#### 1. `quote` — Fare & Route Estimate
Calculate distance, fare, ETA, nearby drivers, and planned polyline before booking:
* **Event:** `quote`
* **Request Payload:**
```json
{
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```
* **Ack Callback Response:**
```json
{
  "ok": true,
  "fare": 90,
  "distanceKm": 2.72,
  "durationMin": 4.9,
  "tripMin": 5,
  "pickupEtaMin": 3,
  "road": true,
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "tripRoute": [
    [28.6139, 77.2090],
    [28.6200, 77.2120],
    [28.6250, 77.2150]
  ],
  "coords": [
    [28.6139, 77.2090],
    [28.6200, 77.2120],
    [28.6250, 77.2150]
  ],
  "route": {
    "phase": "trip",
    "coords": [
      [28.6139, 77.2090],
      [28.6200, 77.2120],
      [28.6250, 77.2150]
    ]
  },
  "nearby": [
    {
      "id": "driver_01",
      "name": "Rajesh Sharma",
      "lat": 28.6150,
      "lng": 77.2100,
      "heading": 135,
      "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
    }
  ]
}
```

---

#### 2. `nearby` — Fetch Available Drivers Nearby
Fetch real-time available drivers with heading angle around any coordinate:
* **Event:** `nearby`
* **Request Payload:**
```json
{
  "lat": 28.6139,
  "lng": 77.2090
}
```
* **Ack Callback Response:**
```json
{
  "ok": true,
  "drivers": [
    {
      "id": "driver_01",
      "name": "Rajesh Sharma",
      "lat": 28.6150,
      "lng": 77.2100,
      "heading": 135,
      "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
    }
  ]
}
```

---

#### 3. `ride:request` — Book Ride & Start Dispatch
Creates ride in `searching` status and initiates batch broadcast to nearest drivers:
* **Event:** `ride:request`
* **Request Payload:**
```json
{
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```
* **Ack Callback Response:**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "rideId": "ride_1791919949941_1",
    "status": "searching",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "pickup_lat": 28.6139,
    "pickup_lng": 77.2090,
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "drop_lat": 28.6250,
    "drop_lng": 77.2150,
    "distanceKm": 2.72,
    "distance_km": 2.72,
    "fare": 90,
    "etaMin": 5,
    "tripMin": 5,
    "driver": null,
    "route": { "phase": "trip", "coords": [...] },
    "tripRoute": [...],
    "search": {
      "ring": 0,
      "rings": 3,
      "cells": ["8860145b59fffff"]
    },
    "offerPending": false
  }
}
```

---

#### 4. `ride:cancel` — Cancel Ride (Rider Initiated)
Cancels active searching, offered, or accepted ride:
* **Event:** `ride:cancel`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "cancelled"
  }
}
```

---

#### 5. `location` — Rider GPS Heartbeat
Send periodically (every 10 seconds) to maintain rider's live coordinates:
* **Event:** `location`
* **Request Payload:**
```json
{
  "lat": 28.6139,
  "lng": 77.2090
}
```
* **Ack Callback Response:**
```json
{
  "ok": true,
  "lat": 28.6139,
  "lng": 77.2090
}
```

---

### 2.3 Server $\rightarrow$ Rider App (Incoming Events)

#### 1. `sync` — Reconnect Recovery
Sent immediately when rider connects or reconnects. Restores full active ongoing ride state (`searching`, `offered`, `accepted`, `arrived`, `on_trip`). If no active ride is ongoing (e.g. previous ride ended or reached `no_driver`), `ride` is `null`:
* **Event:** `sync`
* **Payload:**
```json
{
  "rider": { "id": "rider_01", "name": "Priya Sharma" },
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "accepted",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "distanceKm": 2.72,
    "fare": 90,
    "etaMin": 3,
    "tripMin": 5,
    "driver": {
      "id": "driver_01",
      "name": "Rajesh Sharma",
      "lat": 28.6150,
      "lng": 77.2100,
      "heading": 135,
      "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
    },
    "route": {
      "phase": "pickup",
      "coords": [[28.6150, 77.2100], [28.6139, 77.2090]]
    },
    "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]],
    "offerPending": false
  }
}
```

---

#### 2. `ride:update` — Live Stream (Every 1s + Status Changes)
Fired every 1 second during active rides with driver's live GPS, rotation heading, and countdown ETA:
* **Event:** `ride:update` (also mirrored on `ride`)
* **Payload:**
```json
{
  "id": "ride_1791919949941_1",
  "status": "accepted",
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "distanceKm": 2.72,
  "fare": 90,
  "etaMin": 3,
  "tripMin": 5,
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "lat": 28.6150,
    "lng": 77.2100,
    "heading": 135,
    "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
  },
  "route": {
    "phase": "pickup",
    "coords": [[28.6150, 77.2100], [28.6139, 77.2090]]
  },
  "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]],
  "offerPending": false,
  "notice": null
}
```
* **Notice Handling:** If a driver cancels, the status transitions back to `"searching"` and `notice` contains `"Your driver cancelled. Finding you another one."`.

---

#### 3. `ride:ended` — Final Receipt Event
Guaranteed final event sent when a ride finishes (trip completed, rider cancelled, ops cancelled, or timeout / `no_driver`). Use this to clear active ride and render the receipt:
* **Event:** `ride:ended`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "status": "completed",
  "reason": "completed",
  "fare": 90,
  "tripKm": 2.72,
  "distanceKm": 2.72,
  "driverName": "Rajesh Sharma",
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
  },
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```
*(Reasons: `completed`, `cancelled`, `rider_cancelled`, `no_driver`)*

> [!NOTE]
> **Driver Cancellation Re-dispatch:** When a driver cancels an accepted ride, the rider does **NOT** receive `ride:ended`. Instead, the ride is automatically re-dispatched to other drivers. The rider receives `ride:update` with `status: "searching"` and `notice: "Your driver cancelled. Finding you another one."`. The rider app should remain in searching mode with the radar active.

---
---

## 3. Driver App Integration (`/driver`)

### 3.1 Connection & Handshake
Connect to the `/driver` namespace passing `driverId` and `name`:

```typescript
import { io, Socket } from 'socket.io-client';

const driverSocket: Socket = io('http://localhost:4000/driver', {
  auth: {
    driverId: 'driver_01',
    name: 'Rajesh Sharma',
  },
  transports: ['websocket'],
});
```

---

### 3.2 Server $\rightarrow$ Driver App Initial State & Reconnect (`sync`)
Sent immediately when driver connects or reconnects. Restores full driver profile, active ongoing ride with embedded route, and any active pending offer:
* **Event:** `sync`
* **Payload (Active Ride Example):**
```json
{
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "online": true,
    "status": "busy",
    "lat": 28.6251,
    "lng": 77.2152,
    "heading": 140
  },
  "ride": {
    "id": "ride_1791919949941_1",
    "rideId": "ride_1791919949941_1",
    "status": "accepted",
    "riderId": "rider_01",
    "riderName": "Priya Sharma",
    "riderPhone": "+919876543210",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "pickup_lat": 28.6139,
    "pickup_lng": 77.2090,
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "drop_lat": 28.6250,
    "drop_lng": 77.2150,
    "fare": 90,
    "distanceKm": 2.72,
    "etaMin": 3,
    "tripMin": 5,
    "route": {
      "phase": "pickup",
      "coords": [[28.6251, 77.2152], [28.6139, 77.2090]],
      "km": 1.5,
      "min": 3
    },
    "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]]
  },
  "route": {
    "phase": "pickup",
    "coords": [[28.6251, 77.2152], [28.6139, 77.2090]],
    "km": 1.5,
    "min": 3
  },
  "offer": null
}
```
*(If no active ride is in progress, `ride: null` and `route: null`).*

---

### 3.3 Driver App $\rightarrow$ Server (Client Actions & Acks)

#### 1. `online` — Go Online & Available
Registers driver in the H3 supply index. Accepts empty payload `{}` if GPS is not yet acquired:
* **Event:** `online`
* **Request Payload:** Optional `{ "lat": 28.6251, "lng": 77.2152 }` OR `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "driver": { "id": "driver_01", "online": true, "status": "available" }
}
```

---

#### 2. `offline` — Go Offline
Removes driver from supply index and dispatch pools:
* **Event:** `offline`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "driver": { "id": "driver_01", "online": false, "status": "offline" }
}
```

---

#### 3. `location` — Send Live GPS, Heading & Speed
Streamed every 3 seconds (`LOCATION_PING_MS = 3000`):
* **Event:** `location`
* **Request Payload:**
```json
{
  "lat": 28.6251,
  "lng": 77.2152,
  "heading": 140,
  "speed": 35
}
```
* **Ack Callback Response:**
```json
{
  "ok": true,
  "driverId": "driver_01",
  "lat": 28.6251,
  "lng": 77.2152,
  "heading": 140,
  "cell": "872fb516bffffff"
}
```

---

#### 4. `offer:accept` — Accept Broadcasted Offer (Race Condition Winner)
Atomic Redis lock (`NX EX 120`). First driver to accept wins:
* **Event:** `offer:accept`
* **Request Payload:**
```json
{
  "rideId": "ride_1791919949941_1"
}
```
* **Ack Callback Response (Winner):**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "rideId": "ride_1791919949941_1",
    "status": "accepted",
    "riderId": "rider_01",
    "riderName": "Priya Sharma",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "pickup_lat": 28.6139,
    "pickup_lng": 77.2090,
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "drop_lat": 28.6250,
    "drop_lng": 77.2150,
    "fare": 90,
    "distanceKm": 2.72,
    "distance_km": 2.72,
    "etaMin": 3,
    "tripMin": 5,
    "route": {
      "phase": "pickup",
      "coords": [[28.6251, 77.2152], [28.6139, 77.2090]],
      "km": 1.5,
      "min": 3
    },
    "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]]
  },
  "route": {
    "phase": "pickup",
    "coords": [[28.6251, 77.2152], [28.6139, 77.2090]],
    "km": 1.5,
    "min": 3
  }
}
```
* **Ack Callback Response (Lost):**
```json
{
  "ok": false,
  "error": "Ride has already been accepted by another driver"
}
```

---

#### 5. `offer:decline` — Reject Offer
Declines current offer and unlocks driver immediately:
* **Event:** `offer:decline`
* **Request Payload:** `{ "rideId": "ride_1791919949941_1" }`
* **Ack Callback Response:** `{ "ok": true }`

---

#### 6. `ride:arrived` — Mark Arrived at Pickup
* **Event:** `ride:arrived`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "arrived",
    "riderName": "Priya Sharma",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "fare": 90,
    "distanceKm": 2.72,
    "route": {
      "phase": "pickup",
      "coords": [[28.6139, 77.2090]],
      "km": 0,
      "min": 0
    },
    "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]]
  },
  "route": {
    "phase": "pickup",
    "coords": [[28.6139, 77.2090]],
    "km": 0,
    "min": 0
  }
}
```

---

#### 7. `ride:start` — Start Trip
Switches route to `trip` phase (pickup to destination):
* **Event:** `ride:start`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "on_trip",
    "riderName": "Priya Sharma",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "fare": 90,
    "distanceKm": 2.72,
    "tripMin": 5,
    "route": {
      "phase": "trip",
      "coords": [[28.6139, 77.2090], [28.6250, 77.2150]],
      "km": 2.72,
      "min": 5
    },
    "tripRoute": [[28.6139, 77.2090], [28.6250, 77.2150]]
  },
  "route": {
    "phase": "trip",
    "coords": [[28.6139, 77.2090], [28.6250, 77.2150]],
    "km": 2.72,
    "min": 5
  }
}
```

---

#### 8. `ride:complete` — End Trip & Collect Fare
* **Event:** `ride:complete`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "fare": 90,
  "distanceKm": 2.72,
  "tripKm": 2.72,
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "completed",
    "fare": 90,
    "distanceKm": 2.72
  }
}
```

---

#### 9. `ride:cancel` — Driver Cancels Ride (Triggers Re-dispatch)
Driver is freed immediately, and ride automatically re-broadcasts to another available driver:
* **Event:** `ride:cancel`
* **Request Payload:** `{}`
* **Ack Callback Response:**
```json
{
  "ok": true,
  "message": "Ride cancelled. Rider is being re-assigned to another driver.",
  "ride": { "id": "ride_1791919949941_1", "status": "searching" }
}
```

---

### 3.3 Server $\rightarrow$ Driver App (Incoming Events)

#### 1. `sync` — Driver Reconnect Recovery
Sent immediately on connect/reconnect. Contains active ride state and any pending offer with remaining countdown timer:
* **Event:** `sync`
* **Payload:**
```json
{
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "online": true,
    "status": "available",
    "lat": 28.6251,
    "lng": 77.2152,
    "heading": 140
  },
  "ride": null,
  "offer": {
    "rideId": "ride_1791919949941_1",
    "riderName": "Priya Sharma",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "fare": 90,
    "distanceKm": 2.72,
    "timeoutMs": 11200,
    "expiresAt": 1791919964941
  }
}
```

---

#### 2. `offer` — New Ride Offer Broadcast
Sent simultaneously to top candidate drivers. Driver is locked from receiving competing offers while this timer runs:
* **Event:** `offer`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "riderId": "rider_01",
  "riderName": "Priya Sharma",
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "pickup_lat": 28.6139,
  "pickup_lng": 77.2090,
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "drop_lat": 28.6250,
  "drop_lng": 77.2150,
  "fare": 90,
  "distanceKm": 2.72,
  "distance_km": 2.72,
  "tripMin": 5,
  "etaMin": 5,
  "timeoutMs": 15000,
  "expiresAt": 1791919964941,
  "batchIndex": 1,
  "pickupEtaMin": 3,
  "pickupDistanceKm": 1.2
}
```

---

#### 3. `offer_revoked` — Offer Expired, Cancelled, or Lost Race
Sent when the 15-second timer expires, another driver won the race, or the rider cancelled while the offer was pending:
* **Event:** `offer_revoked`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "reason": "cancelled"
}
```
*(Reasons: `accepted_by_other`, `timeout`, `declined`, `cancelled`)*

---

#### 4. `ride:update` — Live Route & Status for Driver
Pushed on accept, arrive, start, and live updates:
* **Event:** `ride:update`
* **Payload:** Complete driver ride payload with `route: { phase, coords, km, min }`.

---

#### 5. `ride:ended` — Final Terminal Event for Driver
Sent when the ride completes or is cancelled after driver accepted:
* **Event:** `ride:ended`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "reason": "cancelled"
}
```
*(Reasons: `completed`, `cancelled`, `driver_cancelled`)*

---

## 4. Key Implementation Guarantees

1. **Live Car Movement (1-Sec Stream):**
   * Server runs a 1-second interval loop streaming `ride:update` to connected riders.
   * Car coordinates interpolate smoothly along the route, rotating `heading` (0-360°) and counting down `etaMin`.
2. **Deterministic ETA Formula:**
   * $\text{ETA (min)} = \frac{\text{straight line distance (km)} \times 1.3}{24 \text{ km/h}} \times 60$
   * Applied dynamically during `accepted` (to pickup) and `on_trip` (to destination).
3. **One Offer Per Driver:**
   * Drivers with an active, unexpired pending offer are automatically excluded from subsequent dispatch broadcasts until they accept, decline, or timeout.
4. **Driver Cancellation Re-dispatch:**
   * When a driver cancels, the ride is **not** aborted. The rider transitions back to `searching` with notice `"Your driver cancelled. Finding you another one."`, and the server immediately dispatches to the next batch.
