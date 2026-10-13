import { Rider } from './Rider.js';
import { Driver } from './Driver.js';
import { Ride } from './Ride.js';
import { RideOffer } from './RideOffer.js';
import { sequelize, initDatabase } from '../config/database.js';

// Associations
Rider.hasMany(Ride, { foreignKey: 'rider_id', as: 'rides' });
Ride.belongsTo(Rider, { foreignKey: 'rider_id', as: 'rider' });

Driver.hasMany(Ride, { foreignKey: 'driver_id', as: 'rides' });
Ride.belongsTo(Driver, { foreignKey: 'driver_id', as: 'driver' });

Ride.hasMany(RideOffer, { foreignKey: 'ride_id', as: 'offers' });
RideOffer.belongsTo(Ride, { foreignKey: 'ride_id', as: 'ride' });

Driver.hasMany(RideOffer, { foreignKey: 'accepted_by', as: 'acceptedOffers' });
RideOffer.belongsTo(Driver, { foreignKey: 'accepted_by', as: 'winner' });

export {
  sequelize,
  initDatabase,
  Rider,
  Driver,
  Ride,
  RideOffer,
};
