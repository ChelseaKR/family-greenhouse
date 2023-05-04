'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    return queryInterface.addColumn('plants', 'last_watered', Sequelize.DATE);
  },

  async down (queryInterface, Sequelize) {
    return queryInterface.removeColumn('plants', 'last_watered');
  }
};
