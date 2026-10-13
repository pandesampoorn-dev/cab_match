import { io } from 'socket.io-client';

const URL = process.env.SERVER || 'http://localhost:4000';

const wait = (sock, ev, ms = 10000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`Timeout waiting for event "${ev}"`)), ms);
    sock.once(ev, (data) => {
      clearTimeout(t);
      res(data);
    });
  });

const call = (sock, ev, data = {}) =>
  new Promise((res, rej) =>
    sock.emit(ev, data, (r) => (r && r.ok ? res(r) : rej(new Error(r?.error || `${ev} failed`))))
  );

async function runTest() {
  console.log('\n--- Starting Batch Broadcast Dispatch & Concurrency Test ---\n');

  // 1. Connect 3 drivers
  const d1 = io(`${URL}/driver`, { auth: { driverId: 'd-1', name: 'Ramesh' } });
  const d2 = io(`${URL}/driver`, { auth: { driverId: 'd-2', name: 'Suresh' } });
  const d3 = io(`${URL}/driver`, { auth: { driverId: 'd-3', name: 'Imran' } });

  await Promise.all([wait(d1, 'sync'), wait(d2, 'sync'), wait(d3, 'sync')]);
  console.log('[PASS] 3 drivers connected');

  // 2. Set all 3 drivers online near Connaught Place (New Delhi)
  await call(d1, 'online', { lat: 28.6251, lng: 77.2151 });
  await call(d2, 'online', { lat: 28.6252, lng: 77.2152 });
  await call(d3, 'online', { lat: 28.6253, lng: 77.2153 });
  console.log('[PASS] All 3 drivers online in H3 grid');

  // 3. Connect rider
  const rider = io(`${URL}/rider`, { auth: { riderId: 'r-1', name: 'Aarav' } });
  await wait(rider, 'sync');
  console.log('[PASS] Rider connected');

  // 4. Rider requests quote
  const pickup = { lat: 28.6250, lng: 77.2150 };
  const drop = { lat: 28.6350, lng: 77.2250 };
  const quote = await call(rider, 'quote', { pickup, drop });
  console.log(`[PASS] Quote received: distance ${quote.distanceKm} km, ETA ${quote.durationMin} min, Rs.${quote.fare}`);

  // 5. Rider requests ride -> Batch broadcast to drivers
  console.log('-> Requesting ride and watching for simultaneous batch offers...');
  const offerP1 = wait(d1, 'offer');
  const offerP2 = wait(d2, 'offer');

  const rideRes = await call(rider, 'ride:request', { pickup, drop });
  const rideId = rideRes.ride.id;
  console.log(`[PASS] Ride requested: ${rideId}`);

  const [offer1, offer2] = await Promise.all([offerP1, offerP2]);
  console.log(`[PASS] Batch Broadcast verified! Both Driver 1 and Driver 2 received offer for ride ${offer1.rideId} simultaneously`);

  // 6. Test Race Condition: Both drivers try to accept at the same time
  console.log('-> Testing race condition: Driver 1 and Driver 2 accept concurrently...');
  const [res1, res2] = await Promise.allSettled([
    call(d1, 'offer:accept', { rideId }),
    call(d2, 'offer:accept', { rideId }),
  ]);

  const winner = res1.status === 'fulfilled' ? 'Driver 1' : 'Driver 2';
  const loser = res1.status === 'fulfilled' ? 'Driver 2' : 'Driver 1';
  const loserReason = res1.status === 'fulfilled' ? res2.reason.message : res1.reason.message;

  console.log(`[PASS] Atomic Lock verified: ${winner} won the ride!`);
  console.log(`[PASS] Concurrency safety verified: ${loser} rejected (${loserReason})`);

  // 7. Complete trip flow with winner driver
  const winDriver = res1.status === 'fulfilled' ? d1 : d2;
  await call(winDriver, 'ride:arrived');
  console.log('[PASS] Driver marked arrived');

  await call(winDriver, 'ride:start');
  console.log('[PASS] Trip started');

  await call(winDriver, 'ride:complete');
  console.log('[PASS] Trip completed successfully!');

  // Close sockets
  d1.disconnect();
  d2.disconnect();
  d3.disconnect();
  rider.disconnect();

  console.log('\n--- All Tests Passed Successfully! ---\n');
  process.exit(0);
}

runTest().catch((e) => {
  console.error('\n[FAIL] Test Failed:', e.message);
  process.exit(1);
});
