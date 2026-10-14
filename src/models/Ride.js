import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Ride = sequelize.define(
  'Ride',
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
    },
    rider_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    driver_id: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(
        'requested',
        'searching',
        'offered',
        'accepted',
        'arrived',
        'on_trip',
        'completed',
        'cancelled',
        'no_driver'
      ),
      defaultValue: 'requested',
      allowNull: false,
    },
    pickup_lat: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    pickup_lng: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    drop_lat: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    drop_lng: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    distance_km: {
      type: DataTypes.FLOAT,
      allowNull: true,
      defaultValue: 0,
    },
    fare: {
      type: DataTypes.FLOAT,
      allowNull: true,
      defaultValue: 0,
    },
    eta_min: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    timeline: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    route_coords: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: [],
    },
  },
  {
    tableName: 'rides',
    timestamps: true,
    underscored: true,
  }
);
