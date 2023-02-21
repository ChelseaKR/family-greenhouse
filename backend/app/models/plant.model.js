module.exports = (sequelize, Sequelize) => {
    const Plant = sequelize.define("plant", {
        userId: {
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
        }
    });

    return Plant;
};