import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const RideOffer = sequelize.define(
  'RideOffer',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    ride_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    batch_index: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: false,
    },
    driver_ids: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    accepted_by: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('offered', 'accepted', 'expired', 'revoked'),
      defaultValue: 'offered',
      allowNull: false,
    },
  },
  {
    tableName: 'ride_offers',
    timestamps: true,
    underscored: true,
  }
);
