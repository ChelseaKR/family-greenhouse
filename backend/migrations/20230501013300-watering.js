'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    return queryInterface.addColumn('plants', 'watering_frequency_days', Sequelize.INTEGER);
  },

  async down (queryInterface, Sequelize) {
    return queryInterface.removeColumn('plants', 'watering_frequency_days');
  }
};
