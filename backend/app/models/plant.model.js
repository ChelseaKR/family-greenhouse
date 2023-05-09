module.exports = (sequelize, Sequelize) => {
    const Plant = sequelize.define("plant", {
        id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        userId: {
            type: Sequelize.STRING
        },
        greenhouse: {
            type: Sequelize.STRING
        },
        name: {
            type: Sequelize.STRING
        },
        type: {
            type: Sequelize.STRING
        },
        location: {
            type: Sequelize.STRING
        },
        description: {
            type: Sequelize.STRING
        },
        water_frequency_days: {
            type: Sequelize.INTEGER
        },
        water_reminder_time: {
            type: Sequelize.TIME
        }
    });

    return Plant;
};