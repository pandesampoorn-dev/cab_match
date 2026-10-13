import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Rider = sequelize.define(
  'Rider',
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
    lat: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    lng: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
  },
  {
    tableName: 'riders',
    timestamps: true,
    underscored: true,
  }
);
