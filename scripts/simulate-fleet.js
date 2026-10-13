import { io } from 'socket.io-client';

const URL = process.env.SERVER || 'http://localhost:4000';

const DRIVERS = [
  { id: 'driver-cp', name: 'Ramesh (Connaught Place)', lat: 28.6280, lng: 77.2150 },
  { id: 'driver-ig', name: 'Suresh (India Gate)', lat: 28.6129, lng: 77.2295 },
  { id: 'driver-kb', name: 'Imran (Karol Bagh)', lat: 28.6510, lng: 77.1900 },
  { id: 'driver-ln', name: 'Gurpreet (Lajpat Nagar)', lat: 28.5700, lng: 77.2400 },
  { id: 'driver-sk', name: 'Manoj (Saket)', lat: 28.5240, lng: 77.2060 },
];

console.log('\n======================================================');
console.log('   Multi-Driver Fleet Simulator (City Scale)      ');
console.log('======================================================\n');
console.log(`Connecting 5 drivers across Delhi to ${URL}/driver ...\n`);

const sockets = [];

for (const d of DRIVERS) {
  const socket = io(`${URL}/driver`, {
    auth: { driverId: d.id, name: d.name },
    query: { driverId: d.id, name: d.name },
  });

  socket.on('connect', () => {
    // Put driver online with coordinates
    socket.emit('online', { lat: d.lat, lng: d.lng }, (res) => {
      console.log(`  [ONLINE] ${d.name.padEnd(28)} at [${d.lat}, ${d.lng}]`);
    });
  });

  socket.on('offer', (offer) => {
    console.log(`\n  [OFFER RECEIVED] ${d.name} received offer!`);
    console.log(`     Ride ID:  ${offer.rideId}`);
    console.log(`     Fare:     Rs.${offer.fare} (${offer.distanceKm} km trip)`);
    console.log(`     ETA:      ${offer.pickupEtaMin || '?'} min from pickup`);
    console.log(`     Timer:    ${offer.timeoutMs / 1000}s\n`);

    // Auto-accept after 2 seconds for testing (or simulate real driver delay)
    if (process.env.AUTO_ACCEPT === 'true') {
      console.log(`     -> ${d.name} auto-accepting in 1s...`);
      setTimeout(() => {
        socket.emit('offer:accept', { rideId: offer.rideId }, (ack) => {
          if (ack && ack.ok) {
            console.log(`     [WON] ${d.name} acquired atomic lock and won ride!`);
          } else {
            console.log(`     [LOST] ${d.name} rejected (${ack?.error})`);
          }
        });
      }, 1000);
    }
  });

  socket.on('offer_revoked', (data) => {
    console.log(`  [REVOKED] ${d.name}'s offer closed (${data.reason})`);
  });

  sockets.push(socket);
}

console.log('\n------------------------------------------------------');
console.log('  Drivers are now LIVE and listening for ride offers!');
console.log('  Now open Postman and send a ride:request from Rider.');
console.log('  (Watch how only the NEAREST drivers get the offer)');
console.log('  Press Ctrl+C to stop the simulator.');
console.log('------------------------------------------------------\n');

process.on('SIGINT', () => {
  console.log('\nTaking drivers offline...');
  sockets.forEach((s) => s.disconnect());
  process.exit(0);
});
