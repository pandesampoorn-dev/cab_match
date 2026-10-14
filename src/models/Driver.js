import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Driver = sequelize.define(
  'Driver',
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('offline', 'available', 'on_job'),
      defaultValue: 'offline',
      allowNull: false,
    },
    online: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    lat: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    lng: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    vehicle: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
    },
    heading: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
  },
  {
    tableName: 'drivers',
    timestamps: true,
    underscored: true,
  }
);
