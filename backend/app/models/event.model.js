module.exports = (sequelize, Sequelize) => {
    const Event = sequelize.define("event", {
        id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        task_id: {
            type: Sequelize.INTEGER
        },
        datetime: {
            type: Sequelize.DATE
        },
        is_completed: {
            type: Sequelize.BOOLEAN
        },
        completed_by: {
            type: Sequelize.STRING
        },
        date_completed: {
            type: Sequelize.DATE
        },
    });

    return Event;
};