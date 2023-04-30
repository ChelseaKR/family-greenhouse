module.exports = (sequelize, Sequelize) => {
    const Plant = sequelize.define("plant", {
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
        watering_frequency_days: {
            type: Sequelize.INTEGER
        },
        last_watered: {
            type: Sequelize.DATE
        }
    });
    Plant.hasMany(Task, { as: 'tasks', foreignKey: 'plant_id' });

    return Plant;
};