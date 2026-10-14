# WebSocket & Socket.IO Event Guide


## 1. Connection Overview

* **Base URL:** `http://localhost:4000` (or your deployment server host)
* **Transport:** Socket.IO v4 (`websocket`, `polling`)
* **Namespaces:**
  - `/driver` — Driver Mobile App
  - `/rider` — Rider Mobile App
  - `/ops` — Real-time Ops & Admin Monitoring Dashboard

---

## 2. Authentication & Handshake

Authentication is frictionless. Provide your ID and name either via **Socket.IO `auth` handshake object** or **URL query parameters** (ideal for Postman).

### Postman Connection Setup:
* Select **Socket.IO** request in Postman.
* **URL:** `http://localhost:4000/driver` (or `/rider`)
* In the **Params** tab, add:
  - `driverId`: `driver_01` (or `riderId`: `rider_01`)
  - `name`: `John Doe`

---

## 3. Driver Namespace (`/driver`)

### Handshake Credentials
```json
{
  "driverId": "driver_01",
  "name": "Rajesh Sharma"
}
```

### Initial State / Reconnect (`sync`)
Sent by the server immediately upon connection or reconnect:
* **Event:** `sync`
* **Behavior:** Returns driver state, active ride (with full route and rider details), and any active pending offer with remaining countdown timer.
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
    "heading": 135
  },
  "ride": null,
  "route": null,
  "offer": null
}
```
*(When on an active ride or offer, full objects are provided instead of null; `route` is provided at root and also within `ride.route`).*

**Active Ride Reconnect Example:**
```json
{
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "online": true,
    "status": "busy",
    "lat": 28.6251,
    "lng": 77.2152,
    "heading": 135
  },
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "accepted",
    "riderName": "Priya Sharma",
    "riderPhone": "+919876543210",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
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

---

### Client -> Server Events (Driver Actions)

#### 1. Go Online
Marks driver as active and registers them in the H3 geospatial supply index.
* **Event:** `online`
* **Payload:** Optional GPS `{ "lat": 28.6251, "lng": 77.2152 }` OR empty `{}` (server safely accepts empty payload and sets driver available).
* **Ack Response:**
```json
{
  "ok": true,
  "driver": {
    "id": "driver_01",
    "online": true,
    "status": "available"
  }
}
```

#### 2. Live GPS Location & Heading (`location`)
Driver streams GPS heartbeat (every 3 to 5s) along with `heading` and optional `speed`. Fast-writes to Redis and forwards to active ride's rider so car icon rotates accurately.
* **Event:** `location`
* **Payload:**
```json
{
  "lat": 28.6275,
  "lng": 77.2180,
  "heading": 140,
  "speed": 35
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "driverId": "driver_01",
  "lat": 28.6275,
  "lng": 77.2180,
  "heading": 140,
  "cell": "872fb516bffffff"
}
```

#### 3. Accept Batch Offer (Race Condition Winner)
Driver accepts a broadcasted ride offer. Uses an atomic Redis lock (`NX EX 120`). First driver to accept wins.
* **Event:** `offer:accept`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1"
}
```
* **Ack Response (Success / Winner):**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "rideId": "ride_1791919949941_1",
    "status": "accepted",
    "riderId": "rider_01",
    "riderName": "Priya Sharma",
    "riderPhone": null,
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
* **Ack Response (Lost / Another driver won):**
```json
{
  "ok": false,
  "error": "Ride already accepted by another driver"
}
```

#### 4. Decline Offer
Driver explicitly declines the ride offer. Immediately unlocks driver to receive future offers.
* **Event:** `offer:decline`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1"
}
```
* **Ack Response:**
```json
{
  "ok": true
}
```

#### 5. Mark Arrived at Pickup
Driver arrives at the passenger pickup point.
* **Event:** `ride:arrived`
* **Payload:** `{}`
* **Ack Response:**
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

#### 6. Start Trip
Driver starts the trip after rider boards.
* **Event:** `ride:start`
* **Payload:** `{}`
* **Ack Response:**
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

#### 7. Complete Trip
Driver ends the trip at the destination. Driver is freed and returned to `available` pool.
* **Event:** `ride:complete`
* **Payload:** `{}`
* **Ack Response:**
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

#### 8. Driver Cancel (Automatic Re-dispatch)
Driver cancels the assigned ride.
* **Event:** `ride:cancel`
* **Behavior:** Driver is freed immediately. The ride is **NOT permanently cancelled**; it transitions back to `searching` and is instantly re-broadcasted to the next available driver. The rider receives `"Your driver cancelled. Finding you another one."`.
* **Payload:** `{}`
* **Ack Response:**
```json
{
  "ok": true,
  "message": "Ride cancelled. Rider is being re-assigned to another driver.",
  "ride": { "id": "ride_1791919949941_1", "status": "searching" }
}
```

#### 9. Go Offline
Driver goes offline and is removed from the active dispatch pool.
* **Event:** `offline`
* **Payload:** `{}`
* **Ack Response:**
```json
{
  "ok": true,
  "driverId": "driver_01",
  "online": false,
  "status": "offline"
}
```

---

### Server -> Client Events (Driver Incoming)

#### 1. Incoming Ride Offer (`offer`)
Broadcasted simultaneously to top available drivers in current batch. Drivers are locked from receiving another conflicting offer during this timer.
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
  "distanceKm": 2.72,
  "distance_km": 2.72,
  "fare": 90,
  "tripMin": 5,
  "etaMin": 5,
  "timeoutMs": 15000,
  "expiresAt": 1791919964941,
  "batchIndex": 1,
  "pickupEtaMin": 3,
  "pickupDistanceKm": 1.2
}
```

#### 2. Offer Revoked (`offer_revoked`)
Sent when the 15-second timer expires, another driver won the race, or the rider cancelled while offer was pending:
* **Event:** `offer_revoked`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "reason": "cancelled"
}
```
*(Reasons: `accepted_by_other`, `timeout`, `declined`, `cancelled`)*

#### 3. Live Ride Updates for Driver (`ride:update`)
Pushed to driver on every milestone (`accepted`, `arrived`, `on_trip`) and during live tracking:
* **Event:** `ride:update`
* **Payload:** Complete ride object including `riderName`, `pickup`, `drop`, and active `route: { phase, coords, km, min }`.

#### 4. Ride Completed Notification (`ride:completed`)
Sent when trip ends successfully.
* **Event:** `ride:completed`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "fare": 90,
  "distanceKm": 2.72,
  "tripKm": 2.72
}
```

#### 5. Ride Ended Notification for Driver (`ride:ended`)
Sent if rider or ops cancels the ride after driver accepted:
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

## 4. Rider Namespace (`/rider`)

### Handshake Credentials
```json
{
  "riderId": "rider_01",
  "name": "Priya Sharma"
}
```

### Initial State / Reconnect (`sync`)
Sent immediately upon connection / reconnect:
* **Event:** `sync`
* **Behavior:** Returns rider info and the active ongoing ride with full payload (planned `tripRoute`, `route`, `driver`, `etaMin`, `search` hex rings). Only ongoing rides (`searching`, `offered`, `accepted`, `arrived`, `on_trip`) are returned; terminated rides (`completed`, `cancelled`, `no_driver`) return `ride: null`.
* **Payload:**
```json
{
  "rider": { "id": "rider_01", "name": "Priya Sharma" },
  "ride": null
}
```
*(If an active ride exists, `ride` contains the complete live ride object with `tripRoute`, `route`, `search`, etc.)*

---

### Client -> Server Events (Rider Actions)

#### 1. Live Location Heartbeat (`location`)
Sent by rider app periodically (e.g., every 10 seconds) to maintain rider's latest GPS position:
* **Event:** `location`
* **Payload:**
```json
{
  "lat": 28.6139,
  "lng": 77.2090
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "lat": 28.6139,
  "lng": 77.2090
}
```

#### 2. Fare & Route Quote (`quote`)
Calculates real OSRM road distance, duration, and price estimate without creating a ride.
* **Event:** `quote`
* **Payload:**
```json
{
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "distanceKm": 2.72,
  "durationMin": 4.9,
  "tripMin": 5,
  "fare": 90,
  "road": true,
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "pickupEtaMin": 3,
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
      "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
    }
  ]
}
```

#### 3. Check Nearby Drivers (`nearby`)
Finds available drivers in nearby H3 rings.
* **Event:** `nearby`
* **Payload:**
```json
{
  "lat": 28.6139,
  "lng": 77.2090
}
```
* **Ack Response:**
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

#### 4. Request a Ride (`ride:request`)
Creates a new ride and kicks off the Batch Broadcast dispatch engine (Top 3 drivers, 15s timeout).
* **Event:** `ride:request`
* **Payload:**
```json
{
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "ride": {
    "id": "ride_1791919949941_1",
    "status": "searching",
    "pickup": { "lat": 28.6139, "lng": 77.2090 },
    "drop": { "lat": 28.6250, "lng": 77.2150 },
    "distanceKm": 2.72,
    "fare": 90,
    "etaMin": 5,
    "driver": null,
    "route": null,
    "search": {
      "ring": 0,
      "cells": 19,
      "rings": [
        ["8860145b59fffff"],
        ["8860145b58fffff", "8860145b5bfffff", "..."]
      ]
    },
    "timeline": [{ "status": "searching", "at": 1791919949941 }]
  }
}
```

#### 5. Cancel Ride (`ride:cancel`)
Cancels the searching or accepted ride.
* **Event:** `ride:cancel`
* **Payload:** `{}`
* **Ack Response:**
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

### Server -> Client Events (Rider Incoming)

#### 1. Live Ride State Updates (`ride` / `ride:update`)
The server pushes this event at every lifecycle transition AND **every 1 second** during active rides with updated driver coordinates, heading, and countdown ETA:
* **Events:** `ride` (Primary) **AND** `ride:update` (Streamed every 1s)
* **Payload:**
```json
{
  "id": "ride_1791919949941_1",
  "status": "accepted",
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "distanceKm": 2.72,
  "fare": 90,
  "etaMin": 4,
  "tripMin": 5,
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "lat": 28.6150,
    "lng": 77.2100,
    "heading": 135,
    "vehicle": {
      "make": "Maruti",
      "model": "Dzire",
      "color": "White",
      "plate": "DL 01 AB 1234"
    }
  },
  "route": {
    "phase": "pickup",
    "coords": [[28.6150, 77.2100], [28.6139, 77.2090]]
  },
  "tripRoute": [
    [28.6139, 77.2090],
    [28.6200, 77.2120],
    [28.6250, 77.2150]
  ],
  "search": {
    "ring": 0,
    "rings": 3,
    "cells": ["8860145b59fffff"]
  },
  "offerPending": false,
  "timeline": [
    { "status": "searching", "at": 1791919949941 },
    { "status": "offered", "at": 1791919949945, "batch": 1 },
    { "status": "accepted", "at": 1791919951200, "driverId": "driver_01" }
  ]
}
```

#### 2. Terminal Receipt / End Event (`ride:ended`)
Guaranteed terminal event sent whenever a ride finishes (trip completed, rider cancelled, driver cancelled, ops cancelled, or timeout / `no_driver`):
* **Event:** `ride:ended`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "id": "ride_1791919949941_1",
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

### Ride Status Lifecycle:
```text
searching -> offered -> accepted -> arrived -> on_trip -> completed (ride:ended)
    |           |
    v           v
no_driver   cancelled (ride:ended)
```

---

## 5. Ops & Dashboard Namespace (`/ops`)

Used by web dashboards or admin tools to monitor the entire dispatch engine in real time.

* **Connection:** `http://localhost:4000/ops`

### Server -> Client Events:
* **`snapshot`** — Full cluster state sent on connect (drivers online/offline, active rides, stats counters).
* **`ops:log`** — Live stream of backend log entries (`[OK]`, `[RIDE]`, `[DISPATCH]`, `[WARN]`).
* **`ride:new`** — Fired whenever a new ride request is created.
* **`ride:update`** — Fired on every status transition (accepted, arrived, on_trip, completed, cancelled).

---

## 6. HTTP REST Endpoints

Although WebSocket is the primary communication protocol, 2 lightweight monitoring endpoints are available:

### 1. Health Check
* **GET** `/api/health`
* **Response:**
```json
{
  "ok": true,
  "h3Res": 7,
  "batchSize": 3,
  "uptime": 1245.82
}
```

### 2. Live Cluster Snapshot
* **GET** `/api/state`
* **Response:**
```json
{
  "at": 1791919955000,
  "drivers": [ ... ],
  "rides": [ ... ],
  "stats": {
    "free": 3,
    "busy": 1,
    "waiting": 0,
    "completed": 12
  },
  "logs": [ ... ]
}
```
