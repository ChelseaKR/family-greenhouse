'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable(
'task_events',
{
          id: Sequelize.INTEGER,
          task_id: Sequelize.INTEGER,
          datetime: Sequelize.DATE,
          is_completed: Sequelize.BOOLEAN,
          completed_by: Sequelize.STRING,
          date_completed: Sequelize.DATE,
        }
    );
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('task_events');
  }
};
