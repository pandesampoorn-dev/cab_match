# WebSocket & Socket.IO Event Guide

This document is the complete contract reference for frontend developers (React, React Native, Flutter, Web) and QA engineers testing the ride-hailing dispatch server via Postman or Socket.IO client libraries.

---

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

### Initial State (`sync`)
Sent by the server immediately upon successful connection:
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
    "lng": 77.2152
  },
  "ride": null
}
```

---

### Client -> Server Events (Driver Actions)

#### 1. Go Online
Marks driver as active and registers them in the H3 geospatial supply index.
* **Event:** `online`
* **Payload:**
```json
{
  "lat": 28.6251,
  "lng": 77.2152
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "driverId": "driver_01",
  "online": true,
  "status": "available"
}
```

#### 2. Live GPS Location Update
Driver GPS heartbeat sent every 3 to 5 seconds. Fast-writes to Redis and updates the Uber H3 hexagon cell.
* **Event:** `location`
* **Payload:**
```json
{
  "lat": 28.6275,
  "lng": 77.2180
}
```
* **Ack Response:**
```json
{
  "ok": true,
  "driverId": "driver_01",
  "lat": 28.6275,
  "lng": 77.2180,
  "cell": "872fb516bffffff"
}
```

#### 3. Accept Batch Offer (Race Condition Winner)
Driver accepts a broadcasted ride offer. Uses an atomic Redis lock (`NX EX 15`). First driver to accept wins.
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
    "status": "accepted",
    "driver_id": "driver_01",
    "pickup_lat": 28.6139,
    "pickup_lng": 77.2090,
    "drop_lat": 28.6250,
    "drop_lng": 77.2150,
    "fare": 90,
    "distance_km": 2.72
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
Driver explicitly declines the ride offer.
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
  "ride": { "status": "arrived", "id": "ride_1791919949941_1" }
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
  "ride": { "status": "on_trip", "id": "ride_1791919949941_1" }
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
  "ride": { "status": "completed", "id": "ride_1791919949941_1" }
}
```

#### 8. Cancel Active Ride
Driver cancels the assigned ride.
* **Event:** `ride:cancel`
* **Payload:** `{}`
* **Ack Response:**
```json
{
  "ok": true,
  "ride": { "status": "cancelled", "id": "ride_1791919949941_1" }
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
Broadcasted simultaneously to the top 3 nearest drivers in the current batch.
* **Event:** `offer`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "distanceKm": 2.72,
  "fare": 90,
  "timeoutMs": 15000,
  "batchIndex": 1,
  "pickupEtaMin": 4.9,
  "pickupDistanceKm": 1.2
}
```

#### 2. Offer Revoked (`offer_revoked`)
Sent when the 15-second timer expires, or another driver won the race.
* **Event:** `offer_revoked`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "reason": "accepted_by_other"
}
```
*(Reasons: `accepted_by_other`, `timeout`, `declined`)*

#### 3. Ride Completed (`ride:completed`)
Sent when trip ends successfully.
* **Event:** `ride:completed`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "fare": 90
}
```

#### 4. Ride Cancelled (`ride:cancelled`)
Sent if rider cancels the ride before trip starts.
* **Event:** `ride:cancelled`
* **Payload:**
```json
{
  "rideId": "ride_1791919949941_1",
  "reason": "rider_cancelled"
}
```

---

## 4. Rider Namespace (`/rider`)

### Handshake Credentials
```json
{
  "riderId": "rider_01",
  "name": "Priya Sharma"
}
```

### Initial State (`sync`)
Sent immediately upon connection:
* **Event:** `sync`
* **Payload:**
```json
{
  "rider": { "id": "rider_01", "name": "Priya Sharma" },
  "ride": null
}
```

---

### Client -> Server Events (Rider Actions)

#### 1. Fare & Route Quote (`quote`)
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
  "fare": 90,
  "road": true,
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 }
}
```

#### 2. Check Nearby Drivers (`nearby`)
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
      "vehicle": { "make": "Maruti", "model": "Dzire", "plate": "DL 01 AB 1234" }
    }
  ]
}
```

#### 3. Request a Ride (`ride:request`)
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
    "timeline": [{ "status": "searching", "at": 1791919949941 }]
  }
}
```

#### 4. Cancel Ride (`ride:cancel`)
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

#### Live Ride State Updates (`ride`)
The server pushes this event at every milestone of the ride lifecycle:
* **Event:** `ride`
* **Payload:**
```json
{
  "id": "ride_1791919949941_1",
  "status": "accepted",
  "pickup": { "lat": 28.6139, "lng": 77.2090 },
  "drop": { "lat": 28.6250, "lng": 77.2150 },
  "distanceKm": 2.72,
  "fare": 90,
  "etaMin": 5,
  "driver": {
    "id": "driver_01",
    "name": "Rajesh Sharma",
    "lat": 28.6150,
    "lng": 77.2100,
    "vehicle": {
      "make": "Maruti",
      "model": "Dzire",
      "color": "White",
      "plate": "DL 01 AB 1234"
    }
  },
  "timeline": [
    { "status": "searching", "at": 1791919949941 },
    { "status": "offered", "at": 1791919949945, "batch": 1 },
    { "status": "accepted", "at": 1791919951200, "driverId": "driver_01" }
  ]
}
```

### Ride Status Lifecycle:
```text
searching -> offered -> accepted -> arrived -> on_trip -> completed
    |           |
    v           v
no_driver   cancelled
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
